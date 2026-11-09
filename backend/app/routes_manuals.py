"""매뉴얼·버전·게시·검색·첨부 API. 모든 판단은 policy.can()을 거친다."""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from . import services as S
from .db import FILES_DIR
from .deps import client_ip, current_user, get_conn, get_manual, require
from .diffing import diff_docs
from .policy import User, can, visible_filter_sql, work_filter_sql
from .queries import BASE_SELECT, summary
from .render import render, toc_from_html, validate_doc

router = APIRouter(prefix="/api")

CHANGE_TYPES = ["최초 작성", "오탈자", "내용 보완", "절차 변경", "규정 개정", "복원"]
LOCK_MINUTES = 15
MAX_DOC_BYTES = 3_000_000
MAX_UPLOAD = 20 * 1024 * 1024
IMAGE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
FILE_EXT = {".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".hwp": "application/x-hwp", ".hwpx": "application/hwp+zip", ".txt": "text/plain", ".csv": "text/csv",
            ".zip": "application/zip"}


def _now_dt():
    return datetime.now()


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _user_name(conn, uid):
    if not uid:
        return None
    r = conn.execute("SELECT name FROM users WHERE id=?", (uid,)).fetchone()
    return r["name"] if r else None


def _active_lock(conn, manual_id):
    conn.execute("DELETE FROM edit_locks WHERE expires_at < ?", (S.now(),))
    r = conn.execute("SELECT l.*, u.name FROM edit_locks l JOIN users u ON u.id=l.user_id WHERE l.manual_id=?",
                     (manual_id,)).fetchone()
    return r


def _ensure_lock(conn, m, u: User):
    lk = _active_lock(conn, m["id"])
    if lk and lk["user_id"] != u.id:
        raise HTTPException(409, f"{lk['name']} 님이 {lk['acquired_at'][11:16]}부터 편집 중입니다.")
    exp = _fmt(_now_dt() + timedelta(minutes=LOCK_MINUTES))
    if lk:
        conn.execute("UPDATE edit_locks SET expires_at=? WHERE manual_id=?", (exp, m["id"]))
    else:
        conn.execute("INSERT INTO edit_locks VALUES (?,?,?,?)", (m["id"], u.id, S.now(), exp))


def _perms(conn, m, u: User) -> dict:
    latest = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["latest_version_id"],)).fetchone() if m["latest_version_id"] else None
    return {
        "view_work": can(conn, u, "view_work", m),
        "edit": can(conn, u, "edit", m),
        "request_publish": can(conn, u, "request_publish", m),
        "publish": can(conn, u, "publish", m, version=latest),
        "publish_any": can(conn, u, "publish", m),
        "reject": can(conn, u, "reject", m),
        "manage": can(conn, u, "manage", m),
        "force_unlock": can(conn, u, "force_unlock", m),
    }


# ------------------------------------------------------------------ 트리·홈
@router.get("/tree")
def tree(u: User = Depends(current_user), conn=Depends(get_conn)):
    vis, vp = visible_filter_sql(u)
    wk, wp = work_filter_sql(u)
    rows = conn.execute(
        BASE_SELECT + f" WHERE m.deleted_at IS NULL AND m.status != 'archived' AND (({vis}) OR ({wk}))"
                      " ORDER BY m.manual_no", (*vp, *wp)).fetchall()
    depts = conn.execute("SELECT * FROM departments WHERE is_active=1 ORDER BY sort_order, id").fetchall()
    cats = conn.execute("SELECT * FROM categories ORDER BY sort_order, id").fetchall()
    out = []
    for d in depts:
        work_vis = u.is_sys_admin or d["id"] == u.department_id or d["id"] in u.admin_depts
        items = [summary(r, work_vis) for r in rows if r["department_id"] == d["id"]]
        out.append({
            "id": d["id"], "code": d["code"], "name": d["name"],
            "categories": [{"id": c["id"], "name": c["name"]} for c in cats if c["department_id"] == d["id"]],
            "manuals": [{k: x[k] for k in ("id", "manual_no", "title", "category_id", "status", "has_work", "review_state")}
                        for x in items],
        })
    return out


@router.get("/home")
def home(u: User = Depends(current_user), conn=Depends(get_conn)):
    S.remind_stale_approvals(conn)
    vis, vp = visible_filter_sql(u)
    recent = conn.execute(BASE_SELECT + f" WHERE {vis} AND m.status='published' ORDER BY pv.published_at DESC LIMIT 8", vp).fetchall()
    favs = conn.execute(BASE_SELECT + f" JOIN favorites f ON f.manual_id=m.id AND f.user_id=? WHERE m.deleted_at IS NULL"
                        " ORDER BY f.created_at DESC LIMIT 10", (u.id,)).fetchall()
    favs = [r for r in favs if can(conn, u, "view_published", r) or can(conn, u, "view_work", r)]
    my_depts = list({u.department_id or -1, *u.admin_depts.keys()})
    ph = ",".join("?" * len(my_depts))
    # 내 작업: 내가 자동 저장 중이거나, 내가 만든 최신 버전이 아직 게시 전인 매뉴얼
    drafts = conn.execute(
        BASE_SELECT + " WHERE m.deleted_at IS NULL AND m.status != 'archived' AND ("
        " EXISTS (SELECT 1 FROM manual_drafts dr WHERE dr.manual_id=m.id AND dr.user_id=?)"
        " OR (lv.created_by=? AND (m.published_version_id IS NULL OR m.latest_version_id != m.published_version_id)))"
        " ORDER BY m.updated_at DESC LIMIT 10", (u.id, u.id)).fetchall()
    if u.admin_depts:
        aph = ",".join("?" * len(u.admin_depts))
        pending = conn.execute(
            "SELECT a.*, m.title, m.manual_no, m.department_id, d.name AS dept_name, v.version_no, ru.name AS requester"
            " FROM approvals a JOIN manuals m ON m.id=a.manual_id JOIN departments d ON d.id=m.department_id"
            " JOIN manual_versions v ON v.id=a.version_id LEFT JOIN users ru ON ru.id=a.requested_by"
            f" WHERE a.decision='pending' AND m.department_id IN ({aph}) AND m.deleted_at IS NULL ORDER BY a.requested_at",
            list(u.admin_depts.keys())).fetchall()
        pending_role = "decide"
    else:
        pending = conn.execute(
            "SELECT a.*, m.title, m.manual_no, m.department_id, d.name AS dept_name, v.version_no, ru.name AS requester"
            " FROM approvals a JOIN manuals m ON m.id=a.manual_id JOIN departments d ON d.id=m.department_id"
            " JOIN manual_versions v ON v.id=a.version_id LEFT JOIN users ru ON ru.id=a.requested_by"
            " WHERE a.decision='pending' AND a.requested_by=? AND m.deleted_at IS NULL ORDER BY a.requested_at", (u.id,)).fetchall()
        pending_role = "mine"
    soon = (date.today() + timedelta(days=30)).isoformat()
    review = conn.execute(
        BASE_SELECT + f" WHERE m.deleted_at IS NULL AND m.status='published' AND m.department_id IN ({ph})"
        " AND m.next_review_date IS NOT NULL AND m.next_review_date <= ? ORDER BY m.next_review_date LIMIT 10",
        (*my_depts, soon)).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM manuals m WHERE {vis} AND m.status='published'", vp).fetchone()[0]
    mine = conn.execute("SELECT COUNT(*) FROM manuals WHERE department_id=? AND deleted_at IS NULL AND status='published'",
                        (u.department_id,)).fetchone()[0]
    popular = conn.execute(
        BASE_SELECT + f" JOIN (SELECT manual_id, SUM(views) v FROM view_stats WHERE date >= ? GROUP BY manual_id) vs"
        f" ON vs.manual_id=m.id WHERE {vis} AND m.status='published' ORDER BY vs.v DESC LIMIT 5",
        ((date.today() - timedelta(days=14)).isoformat(), *vp)).fetchall()
    return {
        "recent": [summary(r) for r in recent],
        "favorites": [summary(r, can(conn, u, "view_work", r)) for r in favs],
        "my_drafts": [summary(r, True) for r in drafts],
        "pending_role": pending_role,
        "pending": [{"id": p["id"], "manual_id": p["manual_id"], "title": p["title"], "manual_no": p["manual_no"],
                     "department_name": p["dept_name"], "version_no": p["version_no"], "requester": p["requester"],
                     "requested_at": p["requested_at"], "comment": p["request_comment"]} for p in pending],
        "review_due": [summary(r, True) for r in review],
        "popular": [summary(r) for r in popular],
        "counts": {"published": total, "my_dept": mine, "pending": len(pending),
                   "overdue": sum(1 for r in review if r["next_review_date"] < date.today().isoformat())},
    }


@router.get("/templates")
def templates(u: User = Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute("SELECT id, name, description, department_id FROM templates WHERE department_id IS NULL OR department_id=?"
                        " ORDER BY sort_order, id", (u.department_id,)).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ 부서·분류
@router.get("/departments")
def departments(u: User = Depends(current_user), conn=Depends(get_conn)):
    return [dict(r) for r in conn.execute("SELECT id, code, name, approval_mode FROM departments WHERE is_active=1 ORDER BY sort_order, id")]


@router.get("/departments/{dept_id}")
def department_page(dept_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    d = conn.execute("SELECT * FROM departments WHERE id=?", (dept_id,)).fetchone()
    if not d:
        raise HTTPException(404, "부서를 찾을 수 없습니다.")
    vis, vp = visible_filter_sql(u)
    wk, wp = work_filter_sql(u)
    rows = conn.execute(BASE_SELECT + f" WHERE m.department_id=? AND m.deleted_at IS NULL AND (({vis}) OR ({wk})) ORDER BY m.manual_no",
                        (dept_id, *vp, *wp)).fetchall()
    work_vis = can(conn, u, "create_manual", dept_id=dept_id) or u.is_sys_admin
    cats = conn.execute("SELECT id, name, sort_order FROM categories WHERE department_id=? ORDER BY sort_order, id", (dept_id,)).fetchall()
    admins = conn.execute("SELECT u.name, u.position FROM dept_admins da JOIN users u ON u.id=da.user_id WHERE da.department_id=?"
                          " AND u.is_active=1", (dept_id,)).fetchall()
    items = [summary(r, work_vis) for r in rows]
    if not work_vis:
        items = [x for x in items if x["status"] != "archived"]
    return {
        "id": d["id"], "code": d["code"], "name": d["name"], "approval_mode": d["approval_mode"],
        "categories": [dict(c) for c in cats],
        "admins": [f"{a['name']} {a['position'] or ''}".strip() for a in admins],
        "manuals": items,
        "perms": {"create": can(conn, u, "create_manual", dept_id=dept_id),
                  "manage_categories": can(conn, u, "manage_categories", dept_id=dept_id)},
    }


@router.get("/departments/{dept_id}/members")
def dept_members(dept_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    if not (can(conn, u, "create_manual", dept_id=dept_id) or u.is_sys_admin):
        raise HTTPException(403, "권한이 없습니다.")
    return [dict(r) for r in conn.execute(
        "SELECT id, name, position FROM users WHERE department_id=? AND is_active=1 ORDER BY name", (dept_id,))]


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    sort_order: int | None = None


@router.post("/departments/{dept_id}/categories")
def add_category(dept_id: int, body: CategoryIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "manage_categories", dept_id=dept_id, msg="업무분류는 부서 관리자만 관리할 수 있습니다.")
    so = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM categories WHERE department_id=?", (dept_id,)).fetchone()[0]
    cur = conn.execute("INSERT INTO categories(department_id, name, sort_order) VALUES (?,?,?)", (dept_id, body.name.strip(), so))
    S.audit(conn, u, "category.create", "category", cur.lastrowid, dept_id, {"name": body.name}, client_ip(request))
    return {"id": cur.lastrowid}


@router.patch("/categories/{cat_id}")
def edit_category(cat_id: int, body: CategoryIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    c = conn.execute("SELECT * FROM categories WHERE id=?", (cat_id,)).fetchone()
    if not c:
        raise HTTPException(404, "분류를 찾을 수 없습니다.")
    require(conn, u, "manage_categories", dept_id=c["department_id"])
    conn.execute("UPDATE categories SET name=?, sort_order=COALESCE(?, sort_order) WHERE id=?", (body.name.strip(), body.sort_order, cat_id))
    S.audit(conn, u, "category.update", "category", cat_id, c["department_id"], {"from": c["name"], "to": body.name}, client_ip(request))
    return {"ok": True}


@router.delete("/categories/{cat_id}")
def delete_category(cat_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    c = conn.execute("SELECT * FROM categories WHERE id=?", (cat_id,)).fetchone()
    if not c:
        raise HTTPException(404, "분류를 찾을 수 없습니다.")
    require(conn, u, "manage_categories", dept_id=c["department_id"])
    if conn.execute("SELECT 1 FROM manuals WHERE category_id=? AND deleted_at IS NULL", (cat_id,)).fetchone():
        raise HTTPException(409, "이 분류에 매뉴얼이 있어 삭제할 수 없습니다. 매뉴얼을 먼저 다른 분류로 옮기세요.")
    conn.execute("DELETE FROM categories WHERE id=?", (cat_id,))
    S.audit(conn, u, "category.delete", "category", cat_id, c["department_id"], {"name": c["name"]}, client_ip(request))
    return {"ok": True}


# ------------------------------------------------------------------ 매뉴얼 생성·조회
class ManualCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    department_id: int | None = None
    category_id: int | None = None
    template_id: int | None = None
    visibility: str = "company"


@router.post("/manuals")
def create_manual(body: ManualCreate, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    dept_id = body.department_id or u.department_id
    require(conn, u, "create_manual", dept_id=dept_id, msg="소속 부서(또는 관리 부서)에만 매뉴얼을 만들 수 있습니다.")
    if body.visibility not in ("company", "department"):
        raise HTTPException(422, "열람 범위가 올바르지 않습니다.")
    if body.category_id:
        c = conn.execute("SELECT department_id FROM categories WHERE id=?", (body.category_id,)).fetchone()
        if not c or c["department_id"] != dept_id:
            raise HTTPException(422, "업무분류가 올바르지 않습니다.")
    d = conn.execute("SELECT code FROM departments WHERE id=?", (dept_id,)).fetchone()
    nums = [int(r["manual_no"].split("-")[-1]) for r in conn.execute("SELECT manual_no FROM manuals WHERE department_id=?", (dept_id,))
            if r["manual_no"].split("-")[-1].isdigit()]
    no = f"{d['code']}-{(max(nums) if nums else 0) + 1:04d}"
    tpl = None
    if body.template_id:
        tpl = conn.execute("SELECT content_json FROM templates WHERE id=?", (body.template_id,)).fetchone()
    content = tpl["content_json"] if tpl else json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})
    base = (max(nums) if nums else 0) + 1
    for k in range(20):
        no = f"{d['code']}-{base + k:04d}"
        try:
            cur = conn.execute(
                "INSERT INTO manuals(manual_no, title, department_id, category_id, owner_id, visibility, created_by) VALUES (?,?,?,?,?,?,?)",
                (no, body.title.strip(), dept_id, body.category_id, u.id, body.visibility, u.id))
            break
        except sqlite3.IntegrityError:
            continue
    else:
        raise HTTPException(409, "문서 번호를 만들지 못했습니다. 다시 시도하세요.")
    mid = cur.lastrowid
    conn.execute("INSERT INTO manual_drafts(manual_id, user_id, title, content_json, saved_at) VALUES (?,?,?,?,?)",
                 (mid, u.id, body.title.strip(), content, S.now()))
    S.audit(conn, u, "manual.create", "manual", mid, dept_id, {"manual_no": no, "title": body.title}, client_ip(request))
    return {"id": mid, "manual_no": no}


@router.get("/manuals/{manual_id}")
def manual_detail(manual_id: int, view: str = "published", u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    can_pub = can(conn, u, "view_published", m)
    can_work = can(conn, u, "view_work", m)
    if not can_pub and not can_work:
        raise HTTPException(403, "이 매뉴얼을 열람할 권한이 없습니다.")
    if view == "work" and not can_work:
        view = "published"
    if view == "published" and not can_pub:
        view = "work"
    r = conn.execute(BASE_SELECT + " WHERE m.id=?", (manual_id,)).fetchone()
    content_html, toc, shown = "", [], None
    if view == "published":
        v = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["published_version_id"],)).fetchone()
        content_html, toc, shown = v["content_html"], toc_from_html(v["content_html"]), v
        conn.execute("INSERT INTO view_stats(manual_id, date, views) VALUES (?,?,1) ON CONFLICT(manual_id, date) DO UPDATE SET views=views+1",
                     (manual_id, date.today().isoformat()))
    else:
        if m["latest_version_id"]:
            v = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["latest_version_id"],)).fetchone()
            content_html, toc, shown = v["content_html"], toc_from_html(v["content_html"]), v
        else:
            dr = conn.execute("SELECT * FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone()
            if dr:
                rd = render(dr["content_json"])
                content_html, toc = rd.html, rd.toc
    pub = None
    if m["published_version_id"]:
        pv = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["published_version_id"],)).fetchone()
        pub = {"version_id": pv["id"], "version_no": pv["version_no"], "edition": pv["edition_no"],
               "published_at": pv["published_at"], "published_by_name": _user_name(conn, pv["published_by"])}
    draft = None
    pending = None
    rejection = None
    if can_work:
        dr = conn.execute("SELECT d.saved_at, u.name, d.user_id FROM manual_drafts d JOIN users u ON u.id=d.user_id WHERE d.manual_id=?",
                          (manual_id,)).fetchone()
        if dr:
            draft = {"saved_at": dr["saved_at"], "user_name": dr["name"], "mine": dr["user_id"] == u.id}
        p = conn.execute("SELECT a.*, v.version_no, ru.name AS requester FROM approvals a JOIN manual_versions v ON v.id=a.version_id"
                         " LEFT JOIN users ru ON ru.id=a.requested_by WHERE a.manual_id=? AND a.decision='pending'", (manual_id,)).fetchone()
        if p:
            pending = {"id": p["id"], "version_id": p["version_id"], "version_no": p["version_no"], "requester": p["requester"],
                       "requested_at": p["requested_at"], "comment": p["request_comment"]}
        rj = conn.execute("SELECT a.*, du.name AS decider FROM approvals a LEFT JOIN users du ON du.id=a.decided_by"
                          " WHERE a.manual_id=? AND a.decision='rejected' AND a.version_id=? ORDER BY a.id DESC LIMIT 1",
                          (manual_id, m["latest_version_id"] or -1)).fetchone()
        if rj:
            rejection = {"comment": rj["comment"], "decider": rj["decider"], "decided_at": rj["decided_at"]}
    lk = _active_lock(conn, manual_id)
    atts = conn.execute("SELECT id, kind, original_name, mime, size, uploaded_at FROM attachments WHERE manual_id=? AND kind != 'image'"
                        " ORDER BY id", (manual_id,)).fetchall()
    if not can_work or view == "published":
        refs = S.published_attachment_ids(conn, m)
        atts = [a for a in atts if a["id"] in refs]
    extra = [x["department_id"] for x in conn.execute("SELECT department_id FROM manual_extra_departments WHERE manual_id=?", (manual_id,))]
    views = conn.execute("SELECT COALESCE(SUM(views),0) FROM view_stats WHERE manual_id=? AND date >= ?",
                         (manual_id, (date.today() - timedelta(days=30)).isoformat())).fetchone()[0]
    fav = conn.execute("SELECT 1 FROM favorites WHERE user_id=? AND manual_id=?", (u.id, manual_id)).fetchone() is not None
    s = summary(r, can_work)
    s.update({
        "view": view,
        "can_view_published": can_pub,
        "content_html": content_html,
        "toc": toc,
        "shown_version_no": shown["version_no"] if shown else None,
        "shown_title": shown["title"] if shown else (m["title"]),
        "published": pub,
        "draft": draft,
        "pending": pending,
        "rejection": rejection,
        "lock": {"user_id": lk["user_id"], "user_name": lk["name"], "since": lk["acquired_at"]} if lk else None,
        "attachments": [{"id": a["id"], "kind": a["kind"], "name": a["original_name"], "mime": a["mime"], "size": a["size"],
                         "url": f"/api/files/{a['id']}", "uploaded_at": a["uploaded_at"]} for a in atts] if (can_work or can_pub) else [],
        "extra_department_ids": extra,
        "owner_id": m["owner_id"],
        "review_cycle_months": m["review_cycle_months"],
        "dept_approval_mode": r["dept_mode"],
        "is_favorite": fav,
        "views_30d": views,
        "perms": _perms(conn, m, u),
    })
    return s


@router.get("/manuals/{manual_id}/links")
def manual_links(manual_id: int, view: str = "published", u: User = Depends(current_user), conn=Depends(get_conn)):
    """이 문서가 참조하는 문서(링크)와 이 문서를 참조하는 문서(역링크). 열람 권한이 없는 문서는 제목을 보이지 않는다."""
    m = get_manual(conn, manual_id)
    can_pub = can(conn, u, "view_published", m)
    can_work = can(conn, u, "view_work", m)
    if not can_pub and not can_work:
        raise HTTPException(403, "이 매뉴얼을 열람할 권한이 없습니다.")
    scope = "latest" if (view == "work" and can_work) or not can_pub else "published"

    def brief(r, **extra):
        return {"id": r["id"], "manual_no": r["manual_no"], "title": r["title"], "department_name": r["dept_name"],
                "status": r["status"], "edition": r["edition"], **extra}

    outgoing = []
    for ln in conn.execute("SELECT * FROM manual_links WHERE source_id=? AND scope=? ORDER BY rowid", (manual_id, scope)).fetchall():
        t = conn.execute(BASE_SELECT + " WHERE m.id=?", (ln["target_id"],)).fetchone()
        if not t or t["deleted_at"]:
            outgoing.append({"id": None, "access": "missing", "link_text": ln["link_text"]})
            continue
        ok = can(conn, u, "view_published", t) or can(conn, u, "view_work", t)
        if ok:
            outgoing.append(brief(t, access="ok", link_text=ln["link_text"]))
        else:
            outgoing.append({"id": None, "access": "archived" if t["status"] == "archived" else "denied", "link_text": ""})
    backlinks, seen = [], set()
    rows = conn.execute("SELECT * FROM manual_links WHERE target_id=? ORDER BY CASE scope WHEN 'published' THEN 0 ELSE 1 END, source_id",
                        (manual_id,)).fetchall()
    for ln in rows:
        if ln["source_id"] in seen or ln["source_id"] == manual_id:
            continue
        s = conn.execute(BASE_SELECT + " WHERE m.id=?", (ln["source_id"],)).fetchone()
        if not s or s["deleted_at"] or s["status"] == "archived":
            continue
        if ln["scope"] == "published" and can(conn, u, "view_published", s):
            backlinks.append(brief(s, scope="published", link_text=ln["link_text"]))
            seen.add(s["id"])
        elif ln["scope"] == "latest" and can(conn, u, "view_work", s) and s["latest_version_id"] != s["published_version_id"]:
            backlinks.append(brief(s, scope="work", link_text=ln["link_text"]))
            seen.add(s["id"])
    return {"scope": "work" if scope == "latest" else "published", "outgoing": outgoing, "backlinks": backlinks}


class MetaIn(BaseModel):
    category_id: int | None = None
    owner_id: int | None = None
    visibility: str | None = None
    extra_department_ids: list[int] | None = None
    tags: list[str] | None = None
    review_cycle_months: int | None = Field(default=None, ge=1, le=60)
    next_review_date: str | None = None


@router.patch("/manuals/{manual_id}")
def update_meta(manual_id: int, body: MetaIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    data = body.model_dump(exclude_unset=True)
    manage_fields = {"owner_id", "visibility", "extra_department_ids", "review_cycle_months", "next_review_date", "category_id"}
    if manage_fields & data.keys():
        require(conn, u, "manage", m, msg="담당자·열람 범위·검토 주기·분류는 부서 관리자만 바꿀 수 있습니다.")
    else:
        require(conn, u, "edit", m)
    changes = {}
    if "category_id" in data and data["category_id"]:
        c = conn.execute("SELECT department_id FROM categories WHERE id=?", (data["category_id"],)).fetchone()
        if not c or c["department_id"] != m["department_id"]:
            raise HTTPException(422, "업무분류가 올바르지 않습니다.")
        conn.execute("UPDATE manuals SET category_id=? WHERE id=?", (data["category_id"], manual_id))
        changes["category_id"] = data["category_id"]
    if "owner_id" in data and data["owner_id"]:
        o = conn.execute("SELECT department_id, is_active, name FROM users WHERE id=?", (data["owner_id"],)).fetchone()
        if not o or not o["is_active"] or o["department_id"] != m["department_id"]:
            raise HTTPException(422, "담당자는 같은 부서의 재직자여야 합니다.")
        conn.execute("UPDATE manuals SET owner_id=? WHERE id=?", (data["owner_id"], manual_id))
        changes["owner"] = o["name"]
    if "visibility" in data and data["visibility"]:
        if data["visibility"] not in ("company", "department"):
            raise HTTPException(422, "열람 범위가 올바르지 않습니다.")
        conn.execute("UPDATE manuals SET visibility=? WHERE id=?", (data["visibility"], manual_id))
        changes["visibility"] = data["visibility"]
    if "extra_department_ids" in data and data["extra_department_ids"] is not None:
        conn.execute("DELETE FROM manual_extra_departments WHERE manual_id=?", (manual_id,))
        for d in set(data["extra_department_ids"]):
            if d != m["department_id"] and conn.execute("SELECT 1 FROM departments WHERE id=?", (d,)).fetchone():
                conn.execute("INSERT INTO manual_extra_departments VALUES (?,?)", (manual_id, d))
        changes["extra_departments"] = data["extra_department_ids"]
    if "tags" in data and data["tags"] is not None:
        tags = []
        for t in data["tags"]:
            t = re.sub(r"\s+", "", str(t))[:20]
            if t and t not in tags:
                tags.append(t)
        conn.execute("UPDATE manuals SET tags=? WHERE id=?", (json.dumps(tags[:15], ensure_ascii=False), manual_id))
        changes["tags"] = tags
    if "review_cycle_months" in data and data["review_cycle_months"]:
        conn.execute("UPDATE manuals SET review_cycle_months=? WHERE id=?", (data["review_cycle_months"], manual_id))
        changes["review_cycle_months"] = data["review_cycle_months"]
    if "next_review_date" in data and data["next_review_date"]:
        try:
            date.fromisoformat(data["next_review_date"])
        except ValueError:
            raise HTTPException(422, "검토일 형식이 올바르지 않습니다(YYYY-MM-DD).")
        conn.execute("UPDATE manuals SET next_review_date=? WHERE id=?", (data["next_review_date"], manual_id))
        changes["next_review_date"] = data["next_review_date"]
    conn.execute("UPDATE manuals SET updated_at=? WHERE id=?", (S.now(), manual_id))
    S.index_manual(conn, manual_id)
    S.audit(conn, u, "manual.update_meta", "manual", manual_id, m["department_id"], changes, client_ip(request))
    return {"ok": True}


@router.post("/manuals/{manual_id}/favorite")
def toggle_favorite(manual_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    if not (can(conn, u, "view_published", m) or can(conn, u, "view_work", m)):
        raise HTTPException(403, "권한이 없습니다.")
    if conn.execute("SELECT 1 FROM favorites WHERE user_id=? AND manual_id=?", (u.id, manual_id)).fetchone():
        conn.execute("DELETE FROM favorites WHERE user_id=? AND manual_id=?", (u.id, manual_id))
        return {"favorite": False}
    conn.execute("INSERT INTO favorites VALUES (?,?,?)", (u.id, manual_id, S.now()))
    return {"favorite": True}


class ReasonIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)


@router.post("/manuals/{manual_id}/archive")
def archive(manual_id: int, body: ReasonIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "manage", m, msg="폐기는 부서 관리자만 할 수 있습니다.")
    conn.execute("UPDATE manuals SET status='archived', updated_at=? WHERE id=?", (S.now(), manual_id))
    conn.execute("UPDATE approvals SET decision='cancelled', decided_at=? WHERE manual_id=? AND decision='pending'", (S.now(), manual_id))
    conn.execute("UPDATE manuals SET review_state='none' WHERE id=?", (manual_id,))
    S.audit(conn, u, "manual.archive", "manual", manual_id, m["department_id"], {"reason": body.comment}, client_ip(request))
    return {"ok": True}


@router.post("/manuals/{manual_id}/unarchive")
def unarchive(manual_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "unarchive", m, msg="폐기 해제는 부서 관리자만 할 수 있습니다.")
    if m["status"] != "archived":
        raise HTTPException(409, "폐기된 매뉴얼이 아닙니다.")
    status = "published" if m["published_version_id"] else "draft"
    conn.execute("UPDATE manuals SET status=?, updated_at=? WHERE id=?", (status, S.now(), manual_id))
    S.audit(conn, u, "manual.unarchive", "manual", manual_id, m["department_id"], {}, client_ip(request))
    return {"ok": True}


@router.delete("/manuals/{manual_id}")
def delete_manual(manual_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    if m["published_version_id"]:
        raise HTTPException(409, "게시된 적 있는 매뉴얼은 삭제하지 않고 폐기합니다.")
    if not (can(conn, u, "manage", m) or (m["created_by"] == u.id and can(conn, u, "edit", m))):
        raise HTTPException(403, "권한이 없습니다.")
    conn.execute("UPDATE manuals SET deleted_at=? WHERE id=?", (S.now(), manual_id))
    conn.execute("DELETE FROM edit_locks WHERE manual_id=?", (manual_id,))
    S.index_manual(conn, manual_id)
    S.audit(conn, u, "manual.delete", "manual", manual_id, m["department_id"], {"title": m["title"]}, client_ip(request))
    return {"ok": True}


# ------------------------------------------------------------------ 편집(잠금·자동 저장·버전)
@router.post("/manuals/{manual_id}/lock")
def acquire_lock(manual_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m, msg="이 매뉴얼을 편집할 권한이 없습니다.")
    lk = _active_lock(conn, manual_id)
    if lk and lk["user_id"] != u.id:
        return {"ok": False, "holder": {"user_name": lk["name"], "since": lk["acquired_at"]}}
    _ensure_lock(conn, m, u)
    return {"ok": True}


@router.delete("/manuals/{manual_id}/lock")
def release_lock(manual_id: int, request: Request, force: bool = False, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    lk = _active_lock(conn, manual_id)
    if not lk:
        return {"ok": True}
    if lk["user_id"] == u.id:
        conn.execute("DELETE FROM edit_locks WHERE manual_id=?", (manual_id,))
        return {"ok": True}
    if force:
        require(conn, u, "force_unlock", m, msg="편집 잠금 강제 해제는 부서 관리자만 할 수 있습니다.")
        conn.execute("DELETE FROM edit_locks WHERE manual_id=?", (manual_id,))
        S.audit(conn, u, "manual.force_unlock", "manual", manual_id, m["department_id"], {"holder": lk["name"]}, client_ip(request))
        S.notify(conn, [lk["user_id"]], "unlock", f"{u.name} 님이 '{m['title']}' 편집 잠금을 해제했습니다. 자동 저장된 내용은 남아 있습니다.", manual_id)
        return {"ok": True}
    raise HTTPException(409, "다른 사용자의 잠금입니다.")


@router.get("/manuals/{manual_id}/work-content")
def work_content(manual_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m, msg="이 매뉴얼을 편집할 권한이 없습니다.")
    dr = conn.execute("SELECT d.*, u.name FROM manual_drafts d JOIN users u ON u.id=d.user_id WHERE d.manual_id=?", (manual_id,)).fetchone()
    latest = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["latest_version_id"],)).fetchone() if m["latest_version_id"] else None
    if dr:
        return {"title": dr["title"], "content_json": json.loads(dr["content_json"]), "source": "draft",
                "draft_saved_at": dr["saved_at"], "draft_user_name": dr["name"],
                "base_version_no": latest["version_no"] if latest else None}
    if latest:
        return {"title": latest["title"], "content_json": json.loads(latest["content_json"]), "source": "version",
                "draft_saved_at": None, "draft_user_name": None, "base_version_no": latest["version_no"]}
    return {"title": m["title"], "content_json": {"type": "doc", "content": [{"type": "paragraph"}]}, "source": "empty",
            "draft_saved_at": None, "draft_user_name": None, "base_version_no": None}


class DraftIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content_json: dict


@router.put("/manuals/{manual_id}/draft")
def save_draft(manual_id: int, body: DraftIn, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m)
    _ensure_lock(conn, m, u)
    raw = json.dumps(body.content_json, ensure_ascii=False)
    if len(raw.encode()) > MAX_DOC_BYTES:
        raise HTTPException(413, "본문이 너무 큽니다. 큰 이미지는 첨부로 올려 주세요.")
    try:
        render(validate_doc(body.content_json))
    except ValueError as e:
        raise HTTPException(422, str(e))
    t = S.now()
    conn.execute("INSERT INTO manual_drafts(manual_id, user_id, title, content_json, saved_at) VALUES (?,?,?,?,?)"
                 " ON CONFLICT(manual_id) DO UPDATE SET user_id=excluded.user_id, title=excluded.title,"
                 " content_json=excluded.content_json, saved_at=excluded.saved_at",
                 (manual_id, u.id, body.title.strip(), raw, t))
    return {"saved_at": t}


@router.delete("/manuals/{manual_id}/draft")
def discard_draft(manual_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m)
    dr = conn.execute("SELECT * FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone()
    if not dr:
        return {"ok": True}
    if dr["user_id"] != u.id and not can(conn, u, "manage", m):
        raise HTTPException(403, "다른 사람의 작성 중 내용은 부서 관리자만 폐기할 수 있습니다.")
    if not m["latest_version_id"]:
        raise HTTPException(409, "아직 저장된 버전이 없는 새 매뉴얼입니다. 작성 중 내용을 폐기하려면 매뉴얼을 삭제하세요.")
    conn.execute("DELETE FROM manual_drafts WHERE manual_id=?", (manual_id,))
    S.audit(conn, u, "manual.discard_draft", "manual", manual_id, m["department_id"], {}, client_ip(request))
    return {"ok": True}


class VersionIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content_json: dict
    change_type: str
    change_reason: str = Field(default="", max_length=200)


@router.post("/manuals/{manual_id}/versions")
def save_version(manual_id: int, body: VersionIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m)
    if body.change_type not in CHANGE_TYPES:
        raise HTTPException(422, "변경 사유 유형을 선택하세요.")
    _ensure_lock(conn, m, u)
    try:
        validate_doc(body.content_json)
    except ValueError as e:
        raise HTTPException(422, str(e))
    vid = S.create_version(conn, manual_id, u.id, body.title, body.content_json, body.change_type, body.change_reason.strip())
    conn.execute("DELETE FROM manual_drafts WHERE manual_id=?", (manual_id,))
    v = conn.execute("SELECT version_no FROM manual_versions WHERE id=?", (vid,)).fetchone()
    S.audit(conn, u, "manual.save_version", "manual", manual_id, m["department_id"],
            {"version_no": v["version_no"], "change_type": body.change_type, "reason": body.change_reason}, client_ip(request))
    return {"version_id": vid, "version_no": v["version_no"]}


@router.get("/manuals/{manual_id}/versions")
def list_versions(manual_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "view_work", m, msg="버전 이력은 담당 부서만 볼 수 있습니다.")
    rows = conn.execute(
        "SELECT v.id, v.version_no, v.title, v.change_type, v.change_reason, v.created_at, v.published_at, v.edition_no,"
        " cu.name AS author, pu.name AS publisher FROM manual_versions v LEFT JOIN users cu ON cu.id=v.created_by"
        " LEFT JOIN users pu ON pu.id=v.published_by WHERE v.manual_id=? ORDER BY v.version_no DESC", (manual_id,)).fetchall()
    dr = conn.execute("SELECT d.saved_at, u.name FROM manual_drafts d JOIN users u ON u.id=d.user_id WHERE d.manual_id=?", (manual_id,)).fetchone()
    return {
        "manual": {"id": m["id"], "title": m["title"], "manual_no": m["manual_no"], "department_id": m["department_id"],
                   "published_version_id": m["published_version_id"], "latest_version_id": m["latest_version_id"]},
        "draft": {"saved_at": dr["saved_at"], "user_name": dr["name"]} if dr else None,
        "versions": [dict(r) | {"is_published": r["id"] == m["published_version_id"], "is_latest": r["id"] == m["latest_version_id"]}
                     for r in rows],
        "perms": {"edit": can(conn, u, "edit", m)},
    }


@router.get("/manuals/{manual_id}/versions/{version_id}")
def get_version(manual_id: int, version_id: int, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    if not (can(conn, u, "view_work", m) or (version_id == m["published_version_id"] and can(conn, u, "view_published", m))):
        raise HTTPException(403, "권한이 없습니다.")
    v = conn.execute("SELECT v.*, cu.name AS author FROM manual_versions v LEFT JOIN users cu ON cu.id=v.created_by"
                     " WHERE v.id=? AND v.manual_id=?", (version_id, manual_id)).fetchone()
    if not v:
        raise HTTPException(404, "버전을 찾을 수 없습니다.")
    return {"id": v["id"], "version_no": v["version_no"], "title": v["title"], "html": v["content_html"],
            "toc": toc_from_html(v["content_html"]), "created_at": v["created_at"], "author": v["author"],
            "change_type": v["change_type"], "change_reason": v["change_reason"], "edition_no": v["edition_no"],
            "published_at": v["published_at"]}


def _version_doc(conn, manual_id, ref: str):
    if ref == "draft":
        dr = conn.execute("SELECT content_json, saved_at FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone()
        if not dr:
            raise HTTPException(404, "작성 중인 내용이 없습니다.")
        return json.loads(dr["content_json"]), f"작성 중({dr['saved_at'][5:16]})"
    v = conn.execute("SELECT content_json, version_no, edition_no FROM manual_versions WHERE id=? AND manual_id=?",
                     (int(ref), manual_id)).fetchone()
    if not v:
        raise HTTPException(404, "버전을 찾을 수 없습니다.")
    label = f"v{v['version_no']}" + (f" · 제{v['edition_no']}판" if v["edition_no"] else "")
    return json.loads(v["content_json"]), label


@router.get("/manuals/{manual_id}/diff")
def diff(manual_id: int, a: str, b: str, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "view_work", m, msg="버전 비교는 담당 부서만 할 수 있습니다.")
    if not (a == "draft" or a.isdigit()) or not (b == "draft" or b.isdigit()):
        raise HTTPException(422, "비교 대상이 올바르지 않습니다.")
    da, la = _version_doc(conn, manual_id, a)
    db_, lb = _version_doc(conn, manual_id, b)
    r = diff_docs(da, db_)
    return {"from_label": la, "to_label": lb, **r}


@router.post("/manuals/{manual_id}/versions/{version_id}/restore")
def restore(manual_id: int, version_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m)
    if conn.execute("SELECT 1 FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone():
        raise HTTPException(409, "작성 중인 내용이 있습니다. 편집 화면에서 저장하거나 폐기한 뒤 복원하세요.")
    lk = _active_lock(conn, manual_id)
    if lk and lk["user_id"] != u.id:
        raise HTTPException(409, f"{lk['name']} 님이 편집 중이라 복원할 수 없습니다.")
    v = conn.execute("SELECT * FROM manual_versions WHERE id=? AND manual_id=?", (version_id, manual_id)).fetchone()
    if not v:
        raise HTTPException(404, "버전을 찾을 수 없습니다.")
    vid = S.create_version(conn, manual_id, u.id, v["title"], v["content_json"], "복원", f"v{v['version_no']}에서 복원")
    nv = conn.execute("SELECT version_no FROM manual_versions WHERE id=?", (vid,)).fetchone()
    S.audit(conn, u, "manual.restore", "manual", manual_id, m["department_id"],
            {"from_version": v["version_no"], "new_version": nv["version_no"]}, client_ip(request))
    return {"version_id": vid, "version_no": nv["version_no"]}


# ------------------------------------------------------------------ 게시·승인
@router.post("/manuals/{manual_id}/request-publish")
def request_publish(manual_id: int, body: ReasonIn, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "request_publish", m)
    if conn.execute("SELECT 1 FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone():
        raise HTTPException(409, "저장하지 않은 작성 중 내용이 있습니다. 먼저 '저장'으로 버전을 만든 뒤 요청하세요.")
    try:
        S.request_publish(conn, manual_id, u, (body.comment or "").strip() or None)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


class PublishIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)


@router.post("/manuals/{manual_id}/publish")
def publish(manual_id: int, body: PublishIn, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    if not m["latest_version_id"] or m["latest_version_id"] == m["published_version_id"]:
        raise HTTPException(409, "게시할 새 버전이 없습니다. 먼저 '저장'으로 버전을 만드세요.")
    v = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["latest_version_id"],)).fetchone()
    if not can(conn, u, "publish", m, version=v):
        if can(conn, u, "publish", m):
            raise HTTPException(403, "이 부서는 직무 분리 설정으로 본인이 만든 버전을 직접 게시할 수 없습니다. 다른 부서 관리자가 게시해야 합니다.")
        raise HTTPException(403, "게시 권한이 없습니다. '게시 요청'을 이용하세요.")
    edition = S.publish(conn, manual_id, v["id"], u, (body.comment or "").strip() or None)
    return {"ok": True, "edition": edition, "version_no": v["version_no"]}


@router.post("/manuals/{manual_id}/reject")
def reject(manual_id: int, body: ReasonIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "reject", m, msg="반려는 부서 관리자만 할 수 있습니다.")
    if not body.comment or not body.comment.strip():
        raise HTTPException(422, "반려 사유를 입력하세요.")
    p = conn.execute("SELECT * FROM approvals WHERE manual_id=? AND decision='pending'", (manual_id,)).fetchone()
    if not p:
        raise HTTPException(409, "처리할 게시 요청이 없습니다.")
    conn.execute("UPDATE approvals SET decision='rejected', decided_by=?, decided_at=?, comment=? WHERE id=?",
                 (u.id, S.now(), body.comment.strip(), p["id"]))
    conn.execute("UPDATE manuals SET review_state='none', updated_at=? WHERE id=?", (S.now(), manual_id))
    v = conn.execute("SELECT version_no FROM manual_versions WHERE id=?", (p["version_id"],)).fetchone()
    S.audit(conn, u, "manual.reject", "manual", manual_id, m["department_id"], {"version_no": v["version_no"], "comment": body.comment},
            client_ip(request))
    S.notify(conn, [p["requested_by"]], "rejected", f"'{m['title']}' v{v['version_no']} 게시 요청이 반려되었습니다: {body.comment.strip()}", manual_id)
    return {"ok": True}


# ------------------------------------------------------------------ 검색(기획서 10장)
def _highlight(text: str, terms: list[str]) -> str:
    import html as _h
    out = _h.escape(text)
    for t in sorted(terms, key=len, reverse=True):
        out = re.sub(re.escape(_h.escape(t)), lambda mm: f"<mark>{mm.group(0)}</mark>", out, flags=re.I)
    return out


def _snippet(body: str, terms: list[str]) -> str:
    low = body.lower()
    pos = min([p for p in (low.find(t.lower()) for t in terms) if p >= 0], default=-1)
    if pos < 0:
        s = body[:90].replace("\n", " ")
        return _highlight(s, terms) + ("…" if len(body) > 90 else "")
    start, end = max(0, pos - 40), min(len(body), pos + 40 + max(len(t) for t in terms))
    s = body[start:end].replace("\n", " ")
    return ("…" if start > 0 else "") + _highlight(s, terms) + ("…" if end < len(body) else "")


@router.get("/search")
def search(q: str = "", dept: int | None = None, cat: int | None = None, period: str = "", work: bool = False,
           u: User = Depends(current_user), conn=Depends(get_conn)):
    q = q.strip()[:100]
    terms = [t for t in re.split(r"\s+", q) if t][:5]
    if not terms:
        return {"results": [], "total": 0}
    params: list = []
    cond = []
    for t in terms:
        like = f"%{t.lower()}%"
        cond.append("(lower(si.title) LIKE ? OR lower(si.tags) LIKE ? OR lower(si.body_text) LIKE ?)")
        params += [like, like, like]
    where_terms = " AND ".join(cond)
    vis, vp = visible_filter_sql(u)
    dept_sql = (" AND m.department_id=?" if dept else "") + (" AND m.category_id=?" if cat else "")
    dept_p = ([dept] if dept else []) + ([cat] if cat else [])
    since = {"1m": 30, "6m": 182, "1y": 365}.get(period)
    since_s = (date.today() - timedelta(days=since)).isoformat() if since else None
    rows = conn.execute(
        BASE_SELECT.replace("FROM manuals m", ", si.title AS si_title, si.body_text, si.tags AS si_tags, 'published' AS scope FROM manuals m")
        + f" JOIN search_index si ON si.manual_id=m.id AND si.scope='published' WHERE {vis} AND m.status!='archived' AND {where_terms}{dept_sql}",
        (*vp, *params, *dept_p)).fetchall()
    results = {r["id"]: r for r in rows}
    if work:
        wk, wp = work_filter_sql(u)
        wrows = conn.execute(
            BASE_SELECT.replace("FROM manuals m", ", si.title AS si_title, si.body_text, si.tags AS si_tags, 'work' AS scope FROM manuals m")
            + f" JOIN search_index si ON si.manual_id=m.id AND si.scope='latest' WHERE {wk} AND m.status!='archived' AND {where_terms}{dept_sql}",
            (*wp, *params, *dept_p)).fetchall()
        for r in wrows:
            if r["latest_version_id"] != r["published_version_id"] or r["id"] not in results:
                results[r["id"]] = r
    if since_s:
        results = {k: r for k, r in results.items()
                   if ((r["published_at"] if r["scope"] == "published" else r["latest_at"]) or "") >= since_s}
    scored = []
    for r in results.values():
        score = 0
        for t in terms:
            tl = t.lower()
            if tl in (r["si_title"] or "").lower():
                score += 100
            if tl in (r["si_tags"] or "").lower():
                score += 30
            if tl in (r["body_text"] or "").lower():
                score += 5 + min((r["body_text"] or "").lower().count(tl), 10)
        scored.append((score, r["published_at"] or "", r))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    out = []
    for score, _, r in scored[:50]:
        s = summary(r, r["scope"] == "work")
        s.update({"scope": r["scope"], "score": score, "title_html": _highlight(r["si_title"], terms),
                  "snippet_html": _snippet(r["body_text"] or "", terms)})
        out.append(s)
    conn.execute("INSERT INTO search_logs(at, user_id, query, result_count) VALUES (?,?,?,?)", (S.now(), u.id, q, len(out)))
    return {"results": out, "total": len(out)}


# ------------------------------------------------------------------ 첨부(기획서 9.3: 허용 목록·서명 검사·권한 다운로드)
def _check_signature(ext: str, data: bytes) -> bool:
    if ext in IMAGE_EXT:
        return True  # Pillow로 다시 열어 검증
    if ext == ".pdf":
        return data[:5] == b"%PDF-"
    if ext in (".docx", ".xlsx", ".pptx", ".hwpx", ".zip"):
        return data[:4] == b"PK\x03\x04"
    if ext == ".hwp":
        return data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    if ext in (".txt", ".csv"):
        for enc in ("utf-8", "cp949"):
            try:
                data[:4096].decode(enc)
                return True
            except UnicodeDecodeError:
                continue
        return False
    return False


def _store(conn, manual_id: int, u: User, name: str, data: bytes, kind: str, mime: str) -> int:
    key = uuid.uuid4().hex
    (FILES_DIR / key).write_bytes(data)
    cur = conn.execute(
        "INSERT INTO attachments(manual_id, kind, original_name, storage_key, mime, size, sha256, uploaded_by, uploaded_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (manual_id, kind, name, key, mime, len(data), hashlib.sha256(data).hexdigest(), u.id, S.now()))
    return cur.lastrowid


def _process_image(data: bytes, ext: str) -> tuple[bytes, str]:
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(data))
        im.verify()
        im = Image.open(io.BytesIO(data))
    except Exception:
        raise HTTPException(422, "이미지 파일이 손상되었거나 형식이 맞지 않습니다.")
    fmt = (im.format or "").upper()
    if fmt not in ("PNG", "JPEG", "GIF", "WEBP"):
        raise HTTPException(422, "PNG·JPG·GIF·WEBP 이미지만 올릴 수 있습니다.")
    if fmt == "GIF" or im.width <= 1600:
        return data, Image.MIME.get(fmt, IMAGE_EXT.get(ext, "image/png"))
    im.thumbnail((1600, 1600 * 4))  # 큰 이미지는 가로 1600px로 줄인다
    buf = io.BytesIO()
    if fmt == "JPEG":
        im.convert("RGB").save(buf, "JPEG", quality=85)
    else:
        im.save(buf, fmt)
    return buf.getvalue(), Image.MIME.get(fmt, "image/png")


@router.post("/manuals/{manual_id}/attachments")
async def upload(manual_id: int, request: Request, file: UploadFile = File(...), u: User = Depends(current_user), conn=Depends(get_conn)):
    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m, msg="이 매뉴얼에 파일을 올릴 권한이 없습니다.")
    name = (file.filename or "file").replace("\\", "/").split("/")[-1][:150]
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "파일은 20MB까지 올릴 수 있습니다.")
    if ext not in IMAGE_EXT and ext not in FILE_EXT:
        raise HTTPException(422, f"허용되지 않는 파일 형식입니다({ext or '확장자 없음'}). 허용: 이미지, PDF, DOCX, XLSX, PPTX, HWP, HWPX, TXT, CSV, ZIP")
    if not _check_signature(ext, data):
        raise HTTPException(422, "파일 내용이 확장자와 맞지 않습니다.")
    if ext in IMAGE_EXT:
        data, mime = _process_image(data, ext)
        kind = "image"
    else:
        mime, kind = FILE_EXT[ext], "file"
    aid = _store(conn, manual_id, u, name, data, kind, mime)
    S.audit(conn, u, "attachment.upload", "manual", manual_id, m["department_id"], {"attachment_id": aid, "name": name, "size": len(data)},
            client_ip(request))
    return {"id": aid, "url": f"/api/files/{aid}", "name": name, "kind": kind, "size": len(data), "mime": mime}


@router.get("/files/{att_id}")
def download(att_id: int, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    a = conn.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not a:
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    m = get_manual(conn, a["manual_id"])
    if not can(conn, u, "view_work", m):
        # 담당 부서 밖 직원은 공식본 본문이 참조하는 첨부만 받을 수 있다
        if not (can(conn, u, "view_published", m) and att_id in S.published_attachment_ids(conn, m)):
            raise HTTPException(403, "이 파일을 받을 권한이 없습니다.")
    path = FILES_DIR / a["storage_key"]
    if not path.exists():
        raise HTTPException(404, "파일이 저장소에 없습니다.")
    if a["kind"] != "image":
        S.audit(conn, u, "attachment.download", "manual", m["id"], m["department_id"], {"attachment_id": att_id, "name": a["original_name"]},
                client_ip(request))
    disp = "inline" if a["kind"] == "image" else "attachment"
    headers = {"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(a['original_name'])}",
               "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"}
    return FileResponse(path, media_type=a["mime"], headers=headers)


@router.post("/manuals/{manual_id}/import-docx")
async def import_docx(manual_id: int, request: Request, file: UploadFile = File(...), u: User = Depends(current_user), conn=Depends(get_conn)):
    """DOCX 가져오기(기획서 11장): 변환기는 '초안 생성기'. 원본은 첨부로 보관한다."""
    import mammoth
    import nh3

    m = get_manual(conn, manual_id)
    require(conn, u, "edit", m)
    name = (file.filename or "document.docx").split("/")[-1].split("\\")[-1][:150]
    if not name.lower().endswith(".docx"):
        raise HTTPException(422, "DOCX 파일만 가져올 수 있습니다. HWP는 한글에서 'DOCX로 저장' 후 가져오세요.")
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD or data[:4] != b"PK\x03\x04":
        raise HTTPException(422, "DOCX 파일이 아니거나 20MB를 넘습니다.")

    def convert_image(image):
        with image.open() as f:
            raw = f.read()
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif"}.get(image.content_type)
        if not ext:
            return {}
        try:
            out, mime = _process_image(raw, ext)
        except HTTPException:
            return {}
        aid = _store(conn, manual_id, u, f"docx-image{ext}", out, "image", mime)
        return {"src": f"/api/files/{aid}"}

    try:
        res = mammoth.convert_to_html(io.BytesIO(data), convert_image=mammoth.images.img_element(convert_image))
    except Exception:
        raise HTTPException(422, "DOCX 파일을 읽지 못했습니다.")
    clean = nh3.clean(
        res.value,
        tags={"p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "strong", "b", "em", "i",
              "u", "s", "a", "img", "br", "blockquote", "pre", "code", "hr"},
        attributes={"a": {"href"}, "img": {"src", "alt"}, "td": {"colspan", "rowspan"}, "th": {"colspan", "rowspan"}},
        url_schemes={"http", "https", "mailto"},
    )
    _store(conn, manual_id, u, name, data, "source_original", FILE_EXT[".docx"])
    S.audit(conn, u, "manual.import_docx", "manual", manual_id, m["department_id"], {"name": name}, client_ip(request))
    return {"html": clean, "messages": [str(x.message) for x in res.messages][:10]}


# ------------------------------------------------------------------ 내보내기(Markdown·HTML·DOCX·PDF)
EXPORT_MIME = {"md": "text/markdown; charset=utf-8", "html": "text/html; charset=utf-8",
               "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "pdf": "application/pdf"}


@router.get("/manuals/{manual_id}/export")
def export_manual(manual_id: int, request: Request, fmt: str = Query("pdf", alias="format"), view: str = "published",
                  u: User = Depends(current_user), conn=Depends(get_conn)):
    """화면에 보이는 판(공식본 또는 작업본)을 파일로 내려받는다. 열람 권한 검사 후 감사 로그에 남긴다."""
    from . import exporters as X

    fmt = fmt.lower()
    if fmt not in EXPORT_MIME:
        raise HTTPException(422, "내보낼 형식은 md, html, docx, pdf 중 하나입니다.")
    m = get_manual(conn, manual_id)
    can_pub = can(conn, u, "view_published", m)
    can_work = can(conn, u, "view_work", m)
    if not can_pub and not can_work:
        raise HTTPException(403, "이 매뉴얼을 내려받을 권한이 없습니다.")
    use_work = (view == "work" and can_work) or not can_pub
    r = conn.execute(BASE_SELECT + " WHERE m.id=?", (manual_id,)).fetchone()
    vrow, doc, title = None, None, m["title"]
    if not use_work:
        vrow = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["published_version_id"],)).fetchone()
    elif m["latest_version_id"]:
        vrow = conn.execute("SELECT * FROM manual_versions WHERE id=?", (m["latest_version_id"],)).fetchone()
    if vrow:
        doc, title = json.loads(vrow["content_json"]), vrow["title"]
    else:
        dr = conn.execute("SELECT * FROM manual_drafts WHERE manual_id=?", (manual_id,)).fetchone()
        doc = json.loads(dr["content_json"]) if dr else {"type": "doc", "content": []}
        title = dr["title"] if dr else title
    pv = conn.execute("SELECT published_at, published_by FROM manual_versions WHERE id=?", (m["published_version_id"],)).fetchone() \
        if m["published_version_id"] else None
    extra = [x["name"] for x in conn.execute("SELECT d.name FROM manual_extra_departments e JOIN departments d ON d.id=e.department_id"
                                             " WHERE e.manual_id=? ORDER BY d.sort_order", (manual_id,))]
    meta = X.Meta(title=title, manual_no=m["manual_no"], department_name=r["dept_name"], category_name=r["cat_name"],
                  edition=m["edition"], version_no=vrow["version_no"] if vrow else None, view="work" if use_work else "published",
                  published_at=pv["published_at"] if pv else None, published_by=_user_name(conn, pv["published_by"]) if pv else None,
                  owner_name=r["owner_name"], review_cycle_months=m["review_cycle_months"], next_review_date=m["next_review_date"],
                  visibility=m["visibility"], extra_departments=extra, tags=json.loads(m["tags"] or "[]"),
                  exported_by=u.name, base_url=str(request.base_url))

    def image_bytes(aid: int):
        a = conn.execute("SELECT * FROM attachments WHERE id=? AND manual_id=? AND kind='image'", (aid, manual_id)).fetchone()
        path = FILES_DIR / a["storage_key"] if a else None
        return (path.read_bytes(), a["mime"]) if path and path.exists() else None

    def image_data(aid: int):
        got = image_bytes(aid)
        return f"data:{got[1]};base64,{__import__('base64').b64encode(got[0]).decode()}" if got else None

    try:
        if fmt == "md":
            data = X.to_markdown(doc, meta).encode("utf-8")
        elif fmt == "html":
            data = X.to_html(doc, meta, image_data).encode("utf-8")
        elif fmt == "docx":
            data = X.to_docx(doc, meta, image_bytes)
        else:
            try:
                data = X.to_pdf(doc, meta, image_bytes)
            except ImportError:
                raise HTTPException(501, "PDF 변환 모듈(reportlab)이 설치되지 않았습니다. start.bat을 다시 실행해 패키지를 설치하세요.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, "파일을 만들지 못했습니다. 본문에 손상된 그림이 있는지 확인하세요.")
    S.audit(conn, u, "manual.export", "manual", manual_id, m["department_id"],
            {"format": fmt, "view": meta.view, "version_no": meta.version_no}, client_ip(request))
    return Response(data, media_type=EXPORT_MIME[fmt], headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(meta.filename(fmt))}", "X-Content-Type-Options": "nosniff"})


# ------------------------------------------------------------------ 알림
@router.get("/notifications")
def notifications(u: User = Depends(current_user), conn=Depends(get_conn)):
    rows = conn.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30", (u.id,)).fetchall()
    unread = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (u.id,)).fetchone()[0]
    return {"items": [dict(r) for r in rows], "unread": unread}


@router.post("/notifications/read")
def read_notifications(u: User = Depends(current_user), conn=Depends(get_conn)):
    conn.execute("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (S.now(), u.id))
    return {"ok": True}
