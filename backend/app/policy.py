"""권한 판단은 이 파일의 can() 한 곳에서만 한다(기획서 6.2, 9.1).

역할 4종: 직원(타 부서) · 부서원 · 부서 관리자 · 시스템 관리자 (+ 감사 역할 auditor)
권한은 소속 부서로 자동 결정되고, 사람이 지정하는 것은 부서 관리자 지명뿐이다.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field


@dataclass
class User:
    id: int
    username: str
    name: str
    department_id: int | None
    is_active: bool
    roles: set = field(default_factory=set)
    admin_depts: dict = field(default_factory=dict)  # dept_id -> can_self_publish
    position: str | None = None
    department_name: str | None = None

    @property
    def is_sys_admin(self) -> bool:
        return "sys_admin" in self.roles

    @property
    def is_auditor(self) -> bool:
        return "auditor" in self.roles


def load_user(conn: sqlite3.Connection, user_id: int) -> User | None:
    r = conn.execute(
        "SELECT u.*, d.name AS dept_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=?",
        (user_id,),
    ).fetchone()
    if not r:
        return None
    roles = {x["role"] for x in conn.execute("SELECT role FROM system_roles WHERE user_id=?", (user_id,))}
    admins = {x["department_id"]: bool(x["can_self_publish"]) for x in
              conn.execute("SELECT department_id, can_self_publish FROM dept_admins WHERE user_id=?", (user_id,))}
    return User(id=r["id"], username=r["username"], name=r["name"], department_id=r["department_id"],
                is_active=bool(r["is_active"]), roles=roles, admin_depts=admins,
                position=r["position"], department_name=r["dept_name"])


# 행위 목록(9.1 표의 각 행)
MANUAL_ACTIONS = {
    "view_published",   # 공식본 조회(열람 범위 안)
    "view_work",        # 작업본·버전 이력 조회
    "edit",             # 작성·수정
    "request_publish",  # 게시 요청
    "publish",          # 게시
    "reject",           # 반려
    "manage",           # 폐기·담당자 지정·열람 범위 변경
    "force_unlock",     # 편집 잠금 강제 해제
    "unarchive",        # 폐기 해제
}
DEPT_ACTIONS = {"create_manual", "manage_categories", "audit_dept", "approve_queue"}
GLOBAL_ACTIONS = {"admin", "audit_all"}


def can(conn: sqlite3.Connection, u: User | None, action: str, manual=None, dept_id: int | None = None,
        version=None) -> bool:
    if u is None or not u.is_active:
        return False

    if action in GLOBAL_ACTIONS:
        if action == "admin":
            return u.is_sys_admin
        if action == "audit_all":
            return u.is_auditor
        return False

    if manual is not None:
        if manual["deleted_at"]:
            return False
        dept_id = manual["department_id"]

    if dept_id is None:
        return False

    member = u.department_id == dept_id
    dadmin = dept_id in u.admin_depts

    if action in DEPT_ACTIONS:
        if action == "create_manual":
            return member or dadmin
        return dadmin  # 분류 관리·부서 감사로그·게시 대기 목록

    if manual is None or action not in MANUAL_ACTIONS:
        return False

    archived = manual["status"] == "archived"

    if action == "view_published":
        if not manual["published_version_id"]:
            return False
        if member or dadmin or u.is_sys_admin:
            return True
        if archived:
            return False
        if manual["visibility"] == "company":
            return True
        extra = conn.execute(
            "SELECT 1 FROM manual_extra_departments WHERE manual_id=? AND department_id=?",
            (manual["id"], u.department_id),
        ).fetchone()
        return extra is not None

    if action == "view_work":
        return member or dadmin or u.is_sys_admin  # 시스템 관리자는 운영 목적 조회만

    if action == "unarchive":
        return dadmin

    if archived:
        return False

    if action in ("edit", "request_publish"):
        return member or dadmin  # 시스템 관리자는 매뉴얼 내용을 고치지 못한다

    if action == "publish":
        mode = conn.execute("SELECT approval_mode FROM departments WHERE id=?", (dept_id,)).fetchone()
        skip = mode is not None and mode["approval_mode"] == "skip"
        if skip and (member or dadmin):
            return True
        if not dadmin:
            return False
        # 직무 분리: 본인이 만든 버전을 게시하지 못하게 할 수 있다(dept_admins.can_self_publish)
        if version is not None and version["created_by"] == u.id and not u.admin_depts.get(dept_id, True):
            return False
        return True

    if action in ("reject", "manage", "force_unlock"):
        return dadmin

    return False


def visible_filter_sql(u: User, alias: str = "m") -> tuple[str, list]:
    """검색·목록에서 쓰는 '공식본 열람 가능' SQL 조건. can(view_published)와 같은 규칙."""
    if u.is_sys_admin:
        return f"{alias}.published_version_id IS NOT NULL AND {alias}.deleted_at IS NULL", []
    admin_ids = list(u.admin_depts.keys()) or [-1]
    ph = ",".join("?" * len(admin_ids))
    sql = (
        f"{alias}.published_version_id IS NOT NULL AND {alias}.deleted_at IS NULL AND ("
        f" {alias}.department_id = ? OR {alias}.department_id IN ({ph})"
        f" OR ({alias}.status != 'archived' AND ({alias}.visibility = 'company'"
        f"   OR EXISTS (SELECT 1 FROM manual_extra_departments x WHERE x.manual_id={alias}.id AND x.department_id=?))))"
    )
    return sql, [u.department_id or -1, *admin_ids, u.department_id or -1]


def work_filter_sql(u: User, alias: str = "m") -> tuple[str, list]:
    """작업본 열람 가능 조건(can(view_work)과 같은 규칙)."""
    if u.is_sys_admin:
        return f"{alias}.deleted_at IS NULL", []
    ids = list({u.department_id or -1, *u.admin_depts.keys()})
    ph = ",".join("?" * len(ids))
    return f"{alias}.deleted_at IS NULL AND {alias}.department_id IN ({ph})", ids
