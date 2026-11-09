"""로그인(프로토타입용 로컬 계정). 운영 전환 시 사내 SSO(OIDC/AD)로 교체한다(기획서 9.3)."""
from __future__ import annotations

import os
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import services as S
from .deps import SESSION_COOKIE, SESSION_HOURS, client_ip, current_user, get_conn
from .policy import User, load_user

router = APIRouter(prefix="/api/auth")

DEMO_LOGIN = os.environ.get("WORKWIKI_DEMO_LOGIN", "1") == "1"
_fail: dict[str, list[float]] = defaultdict(list)


def me_payload(conn, u: User) -> dict:
    admin_depts = [{"id": r["id"], "name": r["name"], "can_self_publish": bool(u.admin_depts.get(r["id"], True))}
                   for r in conn.execute("SELECT id, name FROM departments WHERE id IN (%s)" % (",".join("?" * len(u.admin_depts)) or "NULL"),
                                         list(u.admin_depts.keys()))] if u.admin_depts else []
    unread = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (u.id,)).fetchone()[0]
    return {"id": u.id, "username": u.username, "name": u.name, "position": u.position,
            "department_id": u.department_id, "department_name": u.department_name,
            "roles": sorted(u.roles), "admin_depts": admin_depts, "unread": unread}


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(get_conn)):
    ip = client_ip(request)
    key = f"{ip}:{body.username.lower()}"
    recent = [t for t in _fail[key] if t > time.time() - 600]
    _fail[key] = recent
    if len(recent) >= 5:
        raise HTTPException(429, "로그인 실패가 반복되어 10분 동안 잠겼습니다.")
    r = conn.execute("SELECT * FROM users WHERE lower(username)=lower(?)", (body.username.strip(),)).fetchone()
    if not r or not r["is_active"] or not S.verify_password(body.password, r["password_hash"]):
        _fail[key].append(time.time())
        S.audit(conn, None, "auth.login_failed", "user", body.username[:50], None, {}, ip)
        raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다.")
    token = secrets.token_urlsafe(32)
    nowdt = datetime.now()
    conn.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                 (token, r["id"], nowdt.strftime("%Y-%m-%d %H:%M:%S"),
                  (nowdt + timedelta(hours=SESSION_HOURS)).strftime("%Y-%m-%d %H:%M:%S")))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (nowdt.strftime("%Y-%m-%d %H:%M:%S"),))
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", secure=secure, max_age=SESSION_HOURS * 3600, path="/")
    u = load_user(conn, r["id"])
    S.audit(conn, u, "auth.login", "user", u.id, u.department_id, {}, ip)
    return me_payload(conn, u)


@router.post("/logout")
def logout(request: Request, response: Response, conn=Depends(get_conn)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(u: User = Depends(current_user), conn=Depends(get_conn)):
    return me_payload(conn, u)


@router.get("/demo-users")
def demo_users(conn=Depends(get_conn)):
    """로그인 화면의 '예시 계정 바로 로그인'. 외부 공개 시 WORKWIKI_DEMO_LOGIN=0으로 끈다."""
    if not DEMO_LOGIN:
        return {"enabled": False, "users": []}
    rows = conn.execute(
        "SELECT u.id, u.username, u.name, u.position, d.name AS dept FROM users u LEFT JOIN departments d ON d.id=u.department_id"
        " WHERE u.is_active=1 ORDER BY d.sort_order, u.id LIMIT 20").fetchall()
    out = []
    for r in rows:
        u = load_user(conn, r["id"])
        role = "시스템 관리자" if u.is_sys_admin else ("부서 관리자" if u.admin_depts else "부서원")
        out.append({"username": r["username"], "name": r["name"], "position": r["position"], "department": r["dept"], "role": role})
    return {"enabled": True, "password_hint": os.environ.get("WORKWIKI_DEFAULT_PASSWORD", "1234"), "users": out}


class PasswordIn(BaseModel):
    current: str
    new: str = Field(min_length=8, max_length=200)


@router.post("/change-password")
def change_password(body: PasswordIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    r = conn.execute("SELECT password_hash FROM users WHERE id=?", (u.id,)).fetchone()
    if not S.verify_password(body.current, r["password_hash"]):
        raise HTTPException(400, "현재 비밀번호가 맞지 않습니다.")
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (S.hash_password(body.new), u.id))
    S.audit(conn, u, "auth.change_password", "user", u.id, u.department_id, {}, client_ip(request))
    return {"ok": True}
