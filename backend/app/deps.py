"""요청 공통: DB 연결, 로그인 사용자, 오류 응답."""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request

from .db import connect
from .policy import User, can, load_user

SESSION_COOKIE = "ww_session"
SESSION_HOURS = int(os.environ.get("WORKWIKI_SESSION_HOURS", "8"))


def get_conn():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def client_ip(request: Request) -> str:
    # Cloudflare Tunnel(같은 PC의 cloudflared) 경유일 때만 CF 헤더를 믿는다
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1") and request.headers.get("cf-connecting-ip"):
        return request.headers["cf-connecting-ip"]
    return host


def optional_user(request: Request, conn=Depends(get_conn)) -> User | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    s = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if not s:
        return None
    nowdt = datetime.now()
    if s["expires_at"] < nowdt.strftime("%Y-%m-%d %H:%M:%S"):
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        return None
    u = load_user(conn, s["user_id"])
    if not u or not u.is_active:
        return None
    # 사용 중이면 만료 시각을 늘린다(슬라이딩 세션)
    conn.execute("UPDATE sessions SET expires_at=? WHERE token=?",
                 ((nowdt + timedelta(hours=SESSION_HOURS)).strftime("%Y-%m-%d %H:%M:%S"), token))
    return u


def current_user(u: User | None = Depends(optional_user)) -> User:
    if u is None:
        raise HTTPException(401, "로그인이 필요합니다.")
    return u


def require(conn, u: User, action: str, manual=None, dept_id=None, version=None, msg: str | None = None):
    if not can(conn, u, action, manual=manual, dept_id=dept_id, version=version):
        raise HTTPException(403, msg or "권한이 없습니다.")


def get_manual(conn, manual_id: int):
    m = conn.execute("SELECT * FROM manuals WHERE id=? AND deleted_at IS NULL", (manual_id,)).fetchone()
    if not m:
        raise HTTPException(404, "매뉴얼을 찾을 수 없습니다.")
    return m
