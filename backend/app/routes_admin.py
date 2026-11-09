"""관리자 화면 API: 부서 관리자(게시 대기·검토·분류·부서 감사로그), 시스템 관리자(사용자·부서·인사 동기화), 감사 역할."""
from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from . import services as S
from .deps import client_ip, current_user, get_conn, require
from .policy import User, load_user
from .queries import BASE_SELECT, summary

router = APIRouter(prefix="/api/admin")

MASS_DEACTIVATION_RATIO = 0.05  # 기획서 6.2: 전체의 5% 초과 비활성화 시 중단


def _admin_scope(u: User) -> list[int] | None:
    """None = 전체(시스템 관리자), 리스트 = 관리 부서."""
    if u.is_sys_admin:
        return None
    return list(u.admin_depts.keys())


def _need_any_admin(u: User):
    if not (u.is_sys_admin or u.admin_depts or u.is_auditor):
        raise HTTPException(403, "관리자 화면 권한이 없습니다.")


@router.get("/overview")
def overview(u: User = Depends(current_user), conn=Depends(get_conn)):
    _need_any_admin(u)
    scope = _admin_scope(u)
    dept_rows = conn.execute("SELECT * FROM departments ORDER BY sort_order, id").fetchall()
    if scope is not None:
        dept_rows = [d for d in dept_rows if d["id"] in scope]
    today = date.today().isoformat()
    by_dept = []
    for d in dept_rows:
        c = conn.execute(
            "SELECT"
            " SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) pub,"
            " SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft,"
            " SUM(CASE WHEN review_state='in_review' THEN 1 ELSE 0 END) pending,"
            " SUM(CASE WHEN status='published' AND next_review_date < ? THEN 1 ELSE 0 END) overdue,"
            " SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) archived"
            " FROM manuals WHERE department_id=? AND deleted_at IS NULL", (today, d["id"])).fetchone()
        admins = [r["name"] for r in conn.execute(
            "SELECT u.name FROM dept_admins da JOIN users u ON u.id=da.user_id WHERE da.department_id=? AND u.is_active=1", (d["id"],))]
        members = conn.execute("SELECT COUNT(*) FROM users WHERE department_id=? AND is_active=1", (d["id"],)).fetchone()[0]
        by_dept.append({"id": d["id"], "code": d["code"], "name": d["name"], "approval_mode": d["approval_mode"], "is_active": bool(d["is_active"]),
                        "published": c["pub"] or 0, "drafts": c["draft"] or 0, "pending": c["pending"] or 0,
                        "overdue": c["overdue"] or 0, "archived": c["archived"] or 0, "admins": admins, "members": members})
    zero = []
    if u.is_sys_admin:
        zero = [dict(r) for r in conn.execute(
            "SELECT query, COUNT(*) AS n, MAX(at) AS last_at FROM search_logs WHERE result_count=0 GROUP BY query ORDER BY n DESC, last_at DESC LIMIT 10")]
    counts = {
        "users": conn.execute("SELECT COUNT(*) FROM users WHERE is_active=1").fetchone()[0] if u.is_sys_admin else None,
        "published": sum(x["published"] for x in by_dept),
        "drafts": sum(x["drafts"] for x in by_dept),
        "pending": sum(x["pending"] for x in by_dept),
        "overdue": sum(x["overdue"] for x in by_dept),
        "searches_7d": conn.execute("SELECT COUNT(*) FROM search_logs WHERE at >= ?", ((date.today() - timedelta(days=7)).isoformat(),)).fetchone()[0],
        "views_7d": conn.execute("SELECT COALESCE(SUM(views),0) FROM view_stats WHERE date >= ?", ((date.today() - timedelta(days=7)).isoformat(),)).fetchone()[0],
    }
    return {"counts": counts, "by_dept": by_dept, "zero_searches": zero,
            "roles": {"sys_admin": u.is_sys_admin, "auditor": u.is_auditor, "dept_admin": bool(u.admin_depts)}}


@router.get("/approvals")
def approvals(u: User = Depends(current_user), conn=Depends(get_conn)):
    _need_any_admin(u)
    S.remind_stale_approvals(conn)
    scope = _admin_scope(u)
    sql = ("SELECT a.*, m.title, m.manual_no, m.department_id, d.name AS dept_name, v.version_no, v.change_type, v.change_reason,"
           " ru.name AS requester, du.name AS decider FROM approvals a JOIN manuals m ON m.id=a.manual_id"
           " JOIN departments d ON d.id=m.department_id JOIN manual_versions v ON v.id=a.version_id"
           " LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by WHERE m.deleted_at IS NULL")
    params: list = []
    if scope is not None:
        sql += f" AND m.department_id IN ({','.join('?' * len(scope)) or 'NULL'})"
        params += scope
    pending = conn.execute(sql + " AND a.decision='pending' ORDER BY a.requested_at", params).fetchall()
    done = conn.execute(sql + " AND a.decision IN ('approved','rejected') ORDER BY a.decided_at DESC LIMIT 30", params).fetchall()

    def row(a):
        return {"id": a["id"], "manual_id": a["manual_id"], "title": a["title"], "manual_no": a["manual_no"], "department_name": a["dept_name"],
                "version_no": a["version_no"], "change_type": a["change_type"], "change_reason": a["change_reason"], "requester": a["requester"],
                "requested_at": a["requested_at"], "request_comment": a["request_comment"], "decision": a["decision"],
                "decider": a["decider"], "decided_at": a["decided_at"], "comment": a["comment"],
                "can_decide": a["department_id"] in u.admin_depts}
    return {"pending": [row(a) for a in pending], "done": [row(a) for a in done]}


@router.get("/reviews")
def reviews(u: User = Depends(current_user), conn=Depends(get_conn)):
    _need_any_admin(u)
    scope = _admin_scope(u)
    soon = (date.today() + timedelta(days=60)).isoformat()
    sql = BASE_SELECT + " WHERE m.deleted_at IS NULL AND m.status='published' AND m.next_review_date <= ?"
    params: list = [soon]
    if scope is not None:
        sql += f" AND m.department_id IN ({','.join('?' * len(scope)) or 'NULL'})"
        params += scope
    rows = conn.execute(sql + " ORDER BY m.next_review_date", params).fetchall()
    orphan_sql = BASE_SELECT + " WHERE m.deleted_at IS NULL AND m.status != 'archived' AND (o.is_active=0 OR o.department_id != m.department_id OR m.owner_id IS NULL)"
    oparams: list = []
    if scope is not None:
        orphan_sql += f" AND m.department_id IN ({','.join('?' * len(scope)) or 'NULL'})"
        oparams += scope
    orphans = conn.execute(orphan_sql, oparams).fetchall()
    return {"due": [summary(r, True) for r in rows], "orphans": [summary(r, True) for r in orphans]}


# ------------------------------------------------------------------ 사용자(시스템 관리자)
class UserIn(BaseModel):
    employee_no: str = Field(min_length=1, max_length=20)
    username: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_.\-]+$")
    name: str = Field(min_length=1, max_length=50)
    position: str | None = Field(default=None, max_length=20)
    email: str | None = Field(default=None, max_length=100)
    department_id: int
    password: str | None = Field(default=None, max_length=200)


class UserPatch(BaseModel):
    name: str | None = Field(default=None, max_length=50)
    position: str | None = Field(default=None, max_length=20)
    email: str | None = Field(default=None, max_length=100)
    department_id: int | None = None
    is_active: bool | None = None
    roles: list[str] | None = None


def _after_user_change(conn, actor: User, before, after_dept: int | None, after_active: bool, ip: str | None):
    """전보·퇴사 처리: 세션·잠금 해제, 담당 매뉴얼 재지정 알림(기획서 6.2)."""
    moved = after_dept != before["department_id"]
    left = before["is_active"] and not after_active
    if not (moved or left):
        return
    if left:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (before["id"],))
    conn.execute("DELETE FROM edit_locks WHERE user_id=?", (before["id"],))
    owned = conn.execute("SELECT id, title, department_id FROM manuals WHERE owner_id=? AND deleted_at IS NULL AND status != 'archived'"
                         " AND department_id=?", (before["id"], before["department_id"])).fetchall()
    reason = "퇴사(비활성화)" if left else "전보"
    for m in owned:
        S.notify(conn, S.dept_admin_ids(conn, m["department_id"]), "owner",
                 f"담당자 재지정 필요: '{m['title']}' — 담당 {before['name']} 님 {reason}", m["id"])
    if moved and not left:
        # 부서 관리자 지위는 소속 부서 기준이 아니므로 유지하되, 이전 부서 작업 잠금만 푼다
        pass


@router.get("/users")
def users(q: str = "", dept: int | None = None, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    sql = ("SELECT u.id, u.employee_no, u.username, u.name, u.position, u.email, u.department_id, u.is_active, u.is_local_admin, u.created_at,"
           " d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE 1=1")
    params: list = []
    if q:
        sql += " AND (u.name LIKE ? OR u.username LIKE ? OR u.employee_no LIKE ?)"
        params += [f"%{q}%"] * 3
    if dept:
        sql += " AND u.department_id=?"
        params.append(dept)
    rows = conn.execute(sql + " ORDER BY u.is_active DESC, d.sort_order, u.employee_no", params).fetchall()
    roles = {}
    for r in conn.execute("SELECT * FROM system_roles"):
        roles.setdefault(r["user_id"], []).append(r["role"])
    admins = {}
    for r in conn.execute("SELECT da.user_id, d.name FROM dept_admins da JOIN departments d ON d.id=da.department_id"):
        admins.setdefault(r["user_id"], []).append(r["name"])
    return [dict(r) | {"roles": roles.get(r["id"], []), "admin_of": admins.get(r["id"], [])} for r in rows]


@router.post("/users")
def create_user(body: UserIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    if conn.execute("SELECT 1 FROM users WHERE employee_no=? OR lower(username)=lower(?)", (body.employee_no, body.username)).fetchone():
        raise HTTPException(409, "같은 사번 또는 아이디가 이미 있습니다.")
    import os
    pw = body.password or os.environ.get("WORKWIKI_DEFAULT_PASSWORD", "1234")
    cur = conn.execute("INSERT INTO users(employee_no, username, name, email, position, department_id, password_hash) VALUES (?,?,?,?,?,?,?)",
                       (body.employee_no, body.username, body.name, body.email, body.position, body.department_id, S.hash_password(pw)))
    S.audit(conn, u, "user.create", "user", cur.lastrowid, body.department_id, {"name": body.name, "employee_no": body.employee_no}, client_ip(request))
    return {"id": cur.lastrowid}


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    before = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not before:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    data = body.model_dump(exclude_unset=True)
    if user_id == u.id and data.get("is_active") is False:
        raise HTTPException(409, "본인 계정은 비활성화할 수 없습니다.")
    sets, params = [], []
    for k in ("name", "position", "email", "department_id"):
        if k in data and data[k] is not None:
            sets.append(f"{k}=?")
            params.append(data[k])
    if "is_active" in data and data["is_active"] is not None:
        sets.append("is_active=?")
        params.append(1 if data["is_active"] else 0)
    if sets:
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", (*params, user_id))
    if "roles" in data and data["roles"] is not None:
        roles = [r for r in data["roles"] if r in ("sys_admin", "auditor")]
        if user_id == u.id and "sys_admin" not in roles:
            raise HTTPException(409, "본인의 시스템 관리자 역할은 해제할 수 없습니다.")
        conn.execute("DELETE FROM system_roles WHERE user_id=?", (user_id,))
        for r in roles:
            conn.execute("INSERT INTO system_roles VALUES (?,?)", (user_id, r))
    after = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    _after_user_change(conn, u, before, after["department_id"], bool(after["is_active"]), client_ip(request))
    S.audit(conn, u, "user.update", "user", user_id, after["department_id"], data, client_ip(request))
    return {"ok": True}


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    import os
    import secrets
    if not conn.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    temp = os.environ.get("WORKWIKI_DEFAULT_PASSWORD") or secrets.token_hex(4)
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (S.hash_password(temp), user_id))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    S.audit(conn, u, "user.reset_password", "user", user_id, None, {}, client_ip(request))
    return {"temporary_password": temp}


# ------------------------------------------------------------------ 부서·부서 관리자(시스템 관리자)
class DeptIn(BaseModel):
    code: str = Field(min_length=1, max_length=10, pattern=r"^[A-Z0-9]+$")
    name: str = Field(min_length=1, max_length=50)
    approval_mode: str = "required"


class DeptPatch(BaseModel):
    name: str | None = Field(default=None, max_length=50)
    approval_mode: str | None = None
    is_active: bool | None = None


@router.post("/departments")
def create_dept(body: DeptIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    if body.approval_mode not in ("required", "skip"):
        raise HTTPException(422, "승인 설정이 올바르지 않습니다.")
    if conn.execute("SELECT 1 FROM departments WHERE code=?", (body.code,)).fetchone():
        raise HTTPException(409, "같은 부서 코드가 있습니다.")
    so = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM departments").fetchone()[0]
    cur = conn.execute("INSERT INTO departments(code, name, approval_mode, sort_order) VALUES (?,?,?,?)", (body.code, body.name, body.approval_mode, so))
    S.audit(conn, u, "dept.create", "department", cur.lastrowid, cur.lastrowid, body.model_dump(), client_ip(request))
    return {"id": cur.lastrowid}


@router.patch("/departments/{dept_id}")
def patch_dept(dept_id: int, body: DeptPatch, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    d = conn.execute("SELECT * FROM departments WHERE id=?", (dept_id,)).fetchone()
    if not d:
        raise HTTPException(404, "부서를 찾을 수 없습니다.")
    data = body.model_dump(exclude_unset=True)
    if "approval_mode" in data and data["approval_mode"] not in ("required", "skip"):
        raise HTTPException(422, "승인 설정이 올바르지 않습니다.")
    if "name" in data and data["name"]:
        conn.execute("UPDATE departments SET name=? WHERE id=?", (data["name"], dept_id))
    if "approval_mode" in data and data["approval_mode"]:
        conn.execute("UPDATE departments SET approval_mode=? WHERE id=?", (data["approval_mode"], dept_id))
    if "is_active" in data and data["is_active"] is not None:
        conn.execute("UPDATE departments SET is_active=? WHERE id=?", (1 if data["is_active"] else 0, dept_id))
    S.audit(conn, u, "dept.update", "department", dept_id, dept_id, data, client_ip(request))
    return {"ok": True}


class DeptAdminIn(BaseModel):
    user_id: int
    can_self_publish: bool = True


@router.put("/departments/{dept_id}/admins")
def set_dept_admin(dept_id: int, body: DeptAdminIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    t = conn.execute("SELECT name, is_active FROM users WHERE id=?", (body.user_id,)).fetchone()
    if not t or not t["is_active"]:
        raise HTTPException(422, "재직 중인 사용자만 지명할 수 있습니다.")
    conn.execute("INSERT INTO dept_admins VALUES (?,?,?) ON CONFLICT(department_id, user_id) DO UPDATE SET can_self_publish=excluded.can_self_publish",
                 (dept_id, body.user_id, 1 if body.can_self_publish else 0))
    S.audit(conn, u, "dept.admin_assign", "department", dept_id, dept_id,
            {"user": t["name"], "can_self_publish": body.can_self_publish}, client_ip(request))
    S.notify(conn, [body.user_id], "role", "부서 관리자로 지명되었습니다. 게시 대기 목록을 확인해 주세요.")
    return {"ok": True}


@router.delete("/departments/{dept_id}/admins/{user_id}")
def remove_dept_admin(dept_id: int, user_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    t = conn.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()
    conn.execute("DELETE FROM dept_admins WHERE department_id=? AND user_id=?", (dept_id, user_id))
    S.audit(conn, u, "dept.admin_remove", "department", dept_id, dept_id, {"user": t["name"] if t else user_id}, client_ip(request))
    return {"ok": True}


class MoveIn(BaseModel):
    target_id: int


@router.post("/departments/{dept_id}/move-manuals")
def move_manuals(dept_id: int, body: MoveIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    """부서 통폐합: 매뉴얼을 다른 부서로 일괄 이동(기획서 2.1). 업무분류는 같은 이름으로 옮겨 만든다."""
    require(conn, u, "admin")
    if dept_id == body.target_id:
        raise HTTPException(422, "같은 부서로는 옮길 수 없습니다.")
    src = conn.execute("SELECT * FROM departments WHERE id=?", (dept_id,)).fetchone()
    dst = conn.execute("SELECT * FROM departments WHERE id=?", (body.target_id,)).fetchone()
    if not src or not dst:
        raise HTTPException(404, "부서를 찾을 수 없습니다.")
    cat_map = {}
    for c in conn.execute("SELECT * FROM categories WHERE department_id=?", (dept_id,)):
        ex = conn.execute("SELECT id FROM categories WHERE department_id=? AND name=?", (dst["id"], c["name"])).fetchone()
        if ex:
            cat_map[c["id"]] = ex["id"]
        else:
            so = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM categories WHERE department_id=?", (dst["id"],)).fetchone()[0]
            cat_map[c["id"]] = conn.execute("INSERT INTO categories(department_id, name, sort_order) VALUES (?,?,?)",
                                            (dst["id"], c["name"], so)).lastrowid
    rows = conn.execute("SELECT id, category_id FROM manuals WHERE department_id=? AND deleted_at IS NULL", (dept_id,)).fetchall()
    for m in rows:
        conn.execute("UPDATE manuals SET department_id=?, category_id=?, updated_at=? WHERE id=?",
                     (dst["id"], cat_map.get(m["category_id"]), S.now(), m["id"]))
        conn.execute("DELETE FROM manual_extra_departments WHERE manual_id=? AND department_id=?", (m["id"], dst["id"]))
    S.audit(conn, u, "dept.move_manuals", "department", dept_id, dst["id"],
            {"from": src["name"], "to": dst["name"], "count": len(rows)}, client_ip(request))
    S.notify(conn, S.dept_admin_ids(conn, dst["id"]), "owner",
             f"{src['name']} 매뉴얼 {len(rows)}건을 {dst['name']}에 옮겼습니다. 담당자를 확인해 주세요.")
    return {"moved": len(rows)}


@router.get("/departments")
def admin_departments(u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    out = []
    for d in conn.execute("SELECT * FROM departments ORDER BY sort_order, id"):
        admins = [dict(r) for r in conn.execute(
            "SELECT u.id, u.name, u.position, da.can_self_publish FROM dept_admins da JOIN users u ON u.id=da.user_id WHERE da.department_id=?",
            (d["id"],))]
        members = conn.execute("SELECT COUNT(*) FROM users WHERE department_id=? AND is_active=1", (d["id"],)).fetchone()[0]
        out.append(dict(d) | {"admins": admins, "members": members})
    return out


# ------------------------------------------------------------------ 인사 동기화(기획서 6.2, 14장)
def _read_csv(data: bytes) -> list[dict]:
    for enc in ("utf-8-sig", "cp949"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise HTTPException(422, "CSV 인코딩을 읽지 못했습니다(UTF-8 또는 CP949).")
    reader = csv.DictReader(io.StringIO(text))
    need = {"employee_no", "name", "department_code"}
    if not reader.fieldnames or not need.issubset({f.strip() for f in reader.fieldnames}):
        raise HTTPException(422, "CSV 머리행에 employee_no, name, department_code가 있어야 합니다.")
    return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in reader]


@router.post("/hr-sync")
async def hr_sync(request: Request, file: UploadFile = File(...), mode: str = Form("preview"), force: bool = Form(False),
                  u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    rows = _read_csv(await file.read(5_000_000))
    depts = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM departments")}
    current = {r["employee_no"]: r for r in conn.execute("SELECT * FROM users")}
    seen, create, update, errors = set(), [], [], []
    deactivate = []
    for i, r in enumerate(rows, start=2):
        no = r.get("employee_no")
        if not no:
            errors.append(f"{i}행: 사번이 비어 있습니다.")
            continue
        if no in seen:
            errors.append(f"{i}행: 사번 {no}이 중복됩니다.")
            continue
        seen.add(no)
        dcode = r.get("department_code")
        if dcode not in depts:
            errors.append(f"{i}행: 부서 코드 '{dcode}'가 없습니다.")
            continue
        active = r.get("is_active", "1") not in ("0", "N", "n", "false", "퇴사")
        cur = current.get(no)
        if not cur:
            if active:
                create.append({"employee_no": no, "name": r["name"], "department_code": dcode, "position": r.get("position") or None,
                               "email": r.get("email") or None})
            continue
        changes = {}
        if r["name"] and r["name"] != cur["name"]:
            changes["name"] = r["name"]
        if depts[dcode] != cur["department_id"]:
            changes["department_code"] = dcode
        if (r.get("position") or None) and r.get("position") != cur["position"]:
            changes["position"] = r.get("position")
        if not active and cur["is_active"]:
            deactivate.append({"employee_no": no, "name": cur["name"], "reason": "인사 파일에 퇴사로 표시"})
        elif active and not cur["is_active"]:
            changes["is_active"] = True
        if changes:
            update.append({"employee_no": no, "name": cur["name"], "changes": changes})
    for no, cur in current.items():
        if no not in seen and cur["is_active"] and not cur["is_local_admin"]:
            deactivate.append({"employee_no": no, "name": cur["name"], "reason": "인사 파일에 없음"})
    active_total = sum(1 for c in current.values() if c["is_active"]) or 1
    ratio = len(deactivate) / active_total
    blocked = ratio > MASS_DEACTIVATION_RATIO
    preview = {"create": create, "update": update, "deactivate": deactivate, "errors": errors, "blocked": blocked,
               "ratio": round(ratio * 100, 1), "threshold": int(MASS_DEACTIVATION_RATIO * 100), "applied": False}
    if mode != "apply":
        return preview
    if errors:
        raise HTTPException(422, "오류가 있는 행을 고친 뒤 적용하세요.")
    run = conn.execute("INSERT INTO hr_sync_runs(started_at, run_by, status) VALUES (?,?, 'running')", (S.now(), u.id)).lastrowid
    if blocked and not force:
        conn.execute("UPDATE hr_sync_runs SET finished_at=?, status='blocked', deactivated=?, error=? WHERE id=?",
                     (S.now(), len(deactivate), f"비활성화 {preview['ratio']}%가 기준 {preview['threshold']}%를 넘어 중단", run))
        S.audit(conn, u, "hr_sync.blocked", "hr_sync", run, None, {"deactivate": len(deactivate), "ratio": preview["ratio"]}, client_ip(request))
        S.notify(conn, [x["user_id"] for x in conn.execute("SELECT user_id FROM system_roles WHERE role='sys_admin'")], "hr_sync",
                 f"인사 동기화가 대량 비활성화({len(deactivate)}명, {preview['ratio']}%)로 중단되었습니다. 인사 파일을 확인하세요.")
        conn.commit()
        raise HTTPException(409, f"비활성화 대상이 {preview['ratio']}%로 기준({preview['threshold']}%)을 넘어 적용을 멈췄습니다. 인사 파일을 확인하고, 맞다면 '강제 적용'을 선택하세요.")
    import os
    pw = S.hash_password(os.environ.get("WORKWIKI_DEFAULT_PASSWORD", "1234"))
    for c in create:
        uname = c["employee_no"].lower()
        conn.execute("INSERT INTO users(employee_no, username, name, email, position, department_id, password_hash) VALUES (?,?,?,?,?,?,?)",
                     (c["employee_no"], uname, c["name"], c["email"], c["position"], depts[c["department_code"]], pw))
    for up in update:
        before = conn.execute("SELECT * FROM users WHERE employee_no=?", (up["employee_no"],)).fetchone()
        ch = up["changes"]
        conn.execute("UPDATE users SET name=COALESCE(?, name), position=COALESCE(?, position), department_id=COALESCE(?, department_id),"
                     " is_active=CASE WHEN ? THEN 1 ELSE is_active END WHERE id=?",
                     (ch.get("name"), ch.get("position"), depts.get(ch.get("department_code")), 1 if ch.get("is_active") else 0, before["id"]))
        after = conn.execute("SELECT * FROM users WHERE id=?", (before["id"],)).fetchone()
        _after_user_change(conn, u, before, after["department_id"], bool(after["is_active"]), None)
    for dv in deactivate:
        before = conn.execute("SELECT * FROM users WHERE employee_no=?", (dv["employee_no"],)).fetchone()
        conn.execute("UPDATE users SET is_active=0 WHERE id=?", (before["id"],))
        _after_user_change(conn, u, before, before["department_id"], False, None)
    conn.execute("UPDATE hr_sync_runs SET finished_at=?, status=?, created=?, updated=?, deactivated=? WHERE id=?",
                 (S.now(), "applied_forced" if blocked else "applied", len(create), len(update), len(deactivate), run))
    S.audit(conn, u, "hr_sync.apply", "hr_sync", run, None,
            {"created": len(create), "updated": len(update), "deactivated": len(deactivate), "forced": bool(blocked)}, client_ip(request))
    preview["applied"] = True
    return preview


@router.get("/hr-sync/runs")
def hr_runs(u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    return [dict(r) | {"run_by_name": (conn.execute("SELECT name FROM users WHERE id=?", (r["run_by"],)).fetchone() or {"name": "예약 작업"})["name"]}
            for r in conn.execute("SELECT * FROM hr_sync_runs ORDER BY id DESC LIMIT 20")]


# ------------------------------------------------------------------ 감사 로그
@router.get("/audit")
def audit_logs(action: str = "", q: str = "", offset: int = 0, u: User = Depends(current_user), conn=Depends(get_conn)):
    if u.is_auditor:
        scope = None
    elif u.admin_depts:
        scope = list(u.admin_depts.keys())
    else:
        raise HTTPException(403, "감사 로그 조회 권한이 없습니다.")
    sql = "SELECT * FROM audit_logs WHERE 1=1"
    params: list = []
    if scope is not None:
        sql += f" AND department_id IN ({','.join('?' * len(scope))}) AND target_type IN ('manual','category')"
        params += scope
    if action:
        sql += " AND action LIKE ?"
        params.append(f"{action}%")
    if q:
        sql += " AND (actor_name LIKE ? OR detail LIKE ? OR target_id = ?)"
        params += [f"%{q}%", f"%{q}%", q]
    total = conn.execute(sql.replace("SELECT *", "SELECT COUNT(*)"), params).fetchone()[0]
    rows = conn.execute(sql + " ORDER BY at DESC, id DESC LIMIT 50 OFFSET ?", (*params, max(0, offset))).fetchall()
    titles = {}
    for r in rows:
        if r["target_type"] == "manual" and r["target_id"] and r["target_id"].isdigit() and r["target_id"] not in titles:
            t = conn.execute("SELECT title, manual_no FROM manuals WHERE id=?", (int(r["target_id"]),)).fetchone()
            titles[r["target_id"]] = f"{t['manual_no']} {t['title']}" if t else None
    return {"total": total, "scope": "all" if scope is None else "dept",
            "items": [dict(r) | {"detail": json.loads(r["detail"] or "{}"),
                                 "target_label": titles.get(r["target_id"]) if r["target_type"] == "manual" else None} for r in rows]}


@router.get("/search-logs")
def search_logs(u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    zero = [dict(r) for r in conn.execute(
        "SELECT query, COUNT(*) AS n, MAX(at) AS last_at FROM search_logs WHERE result_count=0 GROUP BY query ORDER BY n DESC, last_at DESC LIMIT 50")]
    top = [dict(r) for r in conn.execute(
        "SELECT query, COUNT(*) AS n, MAX(at) AS last_at FROM search_logs GROUP BY query ORDER BY n DESC LIMIT 20")]
    return {"zero": zero, "top": top}
