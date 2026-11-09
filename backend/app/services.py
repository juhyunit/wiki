"""매뉴얼 버전·게시·색인·감사로그·알림 공통 처리."""
from __future__ import annotations

import calendar
import hashlib
import hmac
import json
import os
import re
import sqlite3
from datetime import date, datetime

from .render import render

PBKDF2_ITER = 120_000


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today() -> date:
    return date.today()


def add_months(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    day = min(d.day, calendar.monthrange(y, m)[1])
    return date(y, m, day)


# ---------- 비밀번호(프로토타입용 로컬 계정. 운영은 사내 SSO로 대체) ----------
def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"pbkdf2_sha256${PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), dk)
    except Exception:
        return False


# ---------- 감사 로그·알림 ----------
def audit(conn: sqlite3.Connection, actor, action: str, target_type: str | None = None, target_id=None,
          department_id: int | None = None, detail: dict | None = None, ip: str | None = None, at: str | None = None):
    conn.execute(
        "INSERT INTO audit_logs(at, actor_id, actor_name, action, target_type, target_id, department_id, ip, detail)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (at or now(), getattr(actor, "id", None) if actor else None, getattr(actor, "name", None) if actor else "시스템",
         action, target_type, str(target_id) if target_id is not None else None, department_id, ip,
         json.dumps(detail or {}, ensure_ascii=False)),
    )


def notify(conn: sqlite3.Connection, user_ids, kind: str, message: str, manual_id: int | None = None,
           at: str | None = None):
    for uid in set(u for u in user_ids if u):
        conn.execute("INSERT INTO notifications(user_id, at, kind, message, manual_id) VALUES (?,?,?,?,?)",
                     (uid, at or now(), kind, message, manual_id))


def dept_admin_ids(conn: sqlite3.Connection, dept_id: int) -> list[int]:
    return [r["user_id"] for r in conn.execute(
        "SELECT da.user_id FROM dept_admins da JOIN users u ON u.id=da.user_id WHERE da.department_id=? AND u.is_active=1",
        (dept_id,))]


# ---------- 게시 요청 미처리 재알림(기획서 8.2: 3영업일 경과 시 부서 관리자 전원에게)
def business_days_between(start: date, end: date) -> int:
    days, d = 0, start
    while d < end:
        d = date.fromordinal(d.toordinal() + 1)
        if d.weekday() < 5:
            days += 1
    return days


def remind_stale_approvals(conn: sqlite3.Connection, threshold: int = 3) -> int:
    n = 0
    rows = conn.execute(
        "SELECT a.*, m.title, m.department_id FROM approvals a JOIN manuals m ON m.id=a.manual_id"
        " WHERE a.decision='pending' AND a.reminded_at IS NULL AND m.deleted_at IS NULL").fetchall()
    for a in rows:
        req = datetime.strptime(a["requested_at"][:10], "%Y-%m-%d").date()
        if business_days_between(req, today()) >= threshold:
            notify(conn, dept_admin_ids(conn, a["department_id"]), "reminder",
                   f"게시 요청이 {threshold}영업일 넘게 처리되지 않았습니다: '{a['title']}'", a["manual_id"])
            conn.execute("UPDATE approvals SET reminded_at=? WHERE id=?", (now(), a["id"]))
            n += 1
    return n


# ---------- 공식본이 참조하는 첨부(게시 전 첨부는 담당 부서 밖으로 노출하지 않는다)
def published_attachment_ids(conn: sqlite3.Connection, m) -> set[int]:
    if not m["published_version_id"]:
        return set()
    v = conn.execute("SELECT content_json FROM manual_versions WHERE id=?", (m["published_version_id"],)).fetchone()
    return {int(x) for x in re.findall(r"/api/files/(\d+)", v["content_json"] if v else "")}


# ---------- 색인(기획서 10장: 저장 시 같은 트랜잭션에서 갱신) ----------
# 링크·근거 문단 나누는 방식이 바뀌면 올린다 → 서버 시작 때 전체 색인을 다시 만든다
INDEX_VERSION = "2026-11-links-ai-1"


def index_manual(conn: sqlite3.Connection, manual_id: int):
    from .chunks import doc_chunks, doc_links

    m = conn.execute("SELECT * FROM manuals WHERE id=?", (manual_id,)).fetchone()
    conn.execute("DELETE FROM search_index WHERE manual_id=?", (manual_id,))
    conn.execute("DELETE FROM manual_links WHERE source_id=?", (manual_id,))
    if not m or m["deleted_at"]:
        conn.execute("DELETE FROM ai_chunks WHERE manual_id=?", (manual_id,))
        return
    tags = " ".join(json.loads(m["tags"] or "[]"))
    for scope, vid in (("published", m["published_version_id"]), ("latest", m["latest_version_id"])):
        if not vid:
            continue
        v = conn.execute("SELECT title, content_text, content_json FROM manual_versions WHERE id=?", (vid,)).fetchone()
        conn.execute("INSERT INTO search_index(manual_id, scope, title, body_text, tags) VALUES (?,?,?,?,?)",
                     (manual_id, scope, v["title"], v["content_text"], tags))
        # 문서 간 링크(자기 자신은 제외)
        for target, text in doc_links(json.loads(v["content_json"])).items():
            if target != manual_id:
                conn.execute("INSERT OR REPLACE INTO manual_links(source_id, scope, target_id, link_text) VALUES (?,?,?,?)",
                             (manual_id, scope, target, text))
    # AI 근거 문단: 공식본만. 공식본이 그대로면 임베딩을 지키려고 다시 만들지 않는다
    pvid = m["published_version_id"]
    have = conn.execute("SELECT DISTINCT version_id FROM ai_chunks WHERE manual_id=?", (manual_id,)).fetchall()
    if [r[0] for r in have] != ([pvid] if pvid else []):
        conn.execute("DELETE FROM ai_chunks WHERE manual_id=?", (manual_id,))
        if pvid:
            v = conn.execute("SELECT content_json FROM manual_versions WHERE id=?", (pvid,)).fetchone()
            for c in doc_chunks(json.loads(v["content_json"])):
                conn.execute("INSERT INTO ai_chunks(manual_id, version_id, ord, heading, anchor, kind, text) VALUES (?,?,?,?,?,?,?)",
                             (manual_id, pvid, c["ord"], c["heading"], c["anchor"], c["kind"], c["text"]))
            try:
                from . import ai
                ai.wake_worker()
            except Exception:
                pass


def reindex_all(conn: sqlite3.Connection, rechunk: bool = True):
    """검색·링크·근거 문단 색인 전체를 다시 만든다. rechunk=False면 바뀐 공식본만 근거 문단을 다시 나눈다(임베딩 유지)."""
    if rechunk:
        conn.execute("DELETE FROM ai_chunks")
    for r in conn.execute("SELECT id FROM manuals").fetchall():
        index_manual(conn, r["id"])


# ---------- 버전 ----------
def create_version(conn: sqlite3.Connection, manual_id: int, user_id: int, title: str, content_json,
                   change_type: str, change_reason: str, at: str | None = None) -> int:
    doc = content_json if isinstance(content_json, dict) else json.loads(content_json)
    r = render(doc)
    at = at or now()
    no = conn.execute("SELECT COALESCE(MAX(version_no),0)+1 FROM manual_versions WHERE manual_id=?",
                      (manual_id,)).fetchone()[0]
    cur = conn.execute(
        "INSERT INTO manual_versions(manual_id, version_no, title, content_json, content_html, content_text,"
        " change_type, change_reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (manual_id, no, title.strip(), json.dumps(doc, ensure_ascii=False), r.html, r.text,
         change_type, change_reason, user_id, at),
    )
    vid = cur.lastrowid
    m = conn.execute("SELECT status FROM manuals WHERE id=?", (manual_id,)).fetchone()
    if m["status"] == "draft":
        conn.execute("UPDATE manuals SET title=? WHERE id=?", (title.strip(), manual_id))
    # 새 버전이 생기면 이전 게시 요청은 무효(작업본이 다시 '작성 중'으로)
    conn.execute("UPDATE approvals SET decision='cancelled', decided_at=? WHERE manual_id=? AND decision='pending'",
                 (at, manual_id))
    conn.execute("UPDATE manuals SET latest_version_id=?, review_state='none', updated_at=? WHERE id=?",
                 (vid, at, manual_id))
    index_manual(conn, manual_id)
    return vid


def publish(conn: sqlite3.Connection, manual_id: int, version_id: int, user, comment: str | None = None,
            at: str | None = None) -> int:
    at = at or now()
    m = conn.execute("SELECT * FROM manuals WHERE id=?", (manual_id,)).fetchone()
    v = conn.execute("SELECT * FROM manual_versions WHERE id=? AND manual_id=?", (version_id, manual_id)).fetchone()
    if not v:
        raise ValueError("버전을 찾을 수 없습니다.")
    if v["published_at"]:
        raise ValueError("이미 게시된 버전입니다.")
    edition = (m["edition"] or 0) + 1
    conn.execute("UPDATE manual_versions SET published_at=?, published_by=?, edition_no=? WHERE id=?",
                 (at, user.id, edition, version_id))
    next_review = add_months(datetime.strptime(at[:10], "%Y-%m-%d").date(), m["review_cycle_months"] or 12)
    conn.execute(
        "UPDATE manuals SET published_version_id=?, edition=?, status='published', review_state='none', title=?,"
        " next_review_date=?, updated_at=? WHERE id=?",
        (version_id, edition, v["title"], next_review.isoformat(), at, manual_id),
    )
    pending = conn.execute("SELECT * FROM approvals WHERE manual_id=? AND decision='pending'", (manual_id,)).fetchone()
    if pending:
        conn.execute("UPDATE approvals SET decision='approved', decided_by=?, decided_at=?, comment=?, version_id=? WHERE id=?",
                     (user.id, at, comment, version_id, pending["id"]))
        requester = pending["requested_by"]
    else:
        conn.execute(
            "INSERT INTO approvals(manual_id, version_id, requested_by, requested_at, decided_by, decided_at, decision, comment)"
            " VALUES (?,?,?,?,?,?, 'approved', ?)",
            (manual_id, version_id, user.id, at, user.id, at, comment))
        requester = None
    index_manual(conn, manual_id)
    audit(conn, user, "manual.publish", "manual", manual_id, m["department_id"],
          {"version_no": v["version_no"], "edition": edition, "comment": comment}, at=at)
    notify(conn, [requester, m["owner_id"]], "published",
           f"'{v['title']}' 제{edition}판(v{v['version_no']})이 게시되었습니다.", manual_id, at=at)
    return edition


def request_publish(conn: sqlite3.Connection, manual_id: int, user, comment: str | None = None,
                    at: str | None = None):
    at = at or now()
    m = conn.execute("SELECT * FROM manuals WHERE id=?", (manual_id,)).fetchone()
    vid = m["latest_version_id"]
    if not vid or vid == m["published_version_id"]:
        raise ValueError("게시할 새 버전이 없습니다. 먼저 저장(버전 만들기)을 하세요.")
    if conn.execute("SELECT 1 FROM approvals WHERE manual_id=? AND decision='pending'", (manual_id,)).fetchone():
        raise ValueError("이미 게시 요청 중입니다.")
    v = conn.execute("SELECT version_no, title FROM manual_versions WHERE id=?", (vid,)).fetchone()
    conn.execute("INSERT INTO approvals(manual_id, version_id, requested_by, requested_at, request_comment) VALUES (?,?,?,?,?)",
                 (manual_id, vid, user.id, at, comment))
    conn.execute("UPDATE manuals SET review_state='in_review', updated_at=? WHERE id=?", (at, manual_id))
    audit(conn, user, "manual.request_publish", "manual", manual_id, m["department_id"],
          {"version_no": v["version_no"], "comment": comment}, at=at)
    notify(conn, dept_admin_ids(conn, m["department_id"]), "request",
           f"{user.name} 님이 '{v['title']}' v{v['version_no']} 게시를 요청했습니다.", manual_id, at=at)
