"""SQLite 연결과 스키마.

기획서 6장 데이터 모델을 PC 1대용으로 옮긴 것이다.
운영 전환 시 PostgreSQL(asyncpg) + pg_trgm으로 교체한다.
"""
import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("WORKWIKI_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "workwiki.db"
FILES_DIR = DATA_DIR / "files"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    approval_mode TEXT NOT NULL DEFAULT 'required' CHECK (approval_mode IN ('required','skip')),
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    employee_no TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    position TEXT,
    department_id INTEGER REFERENCES departments(id),
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_local_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dept_admins (
    department_id INTEGER NOT NULL REFERENCES departments(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    can_self_publish INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (department_id, user_id)
);

CREATE TABLE IF NOT EXISTS system_roles (
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('sys_admin','auditor')),
    PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    parent_id INTEGER REFERENCES categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manuals (
    id INTEGER PRIMARY KEY,
    manual_no TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    category_id INTEGER REFERENCES categories(id),
    owner_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    review_state TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','in_review')),
    visibility TEXT NOT NULL DEFAULT 'company' CHECK (visibility IN ('company','department')),
    published_version_id INTEGER,
    latest_version_id INTEGER,
    edition INTEGER NOT NULL DEFAULT 0,
    review_cycle_months INTEGER NOT NULL DEFAULT 12,
    next_review_date TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS manual_versions (
    id INTEGER PRIMARY KEY,
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    version_no INTEGER NOT NULL,
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    content_html TEXT NOT NULL,
    content_text TEXT NOT NULL,
    change_type TEXT,
    change_reason TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    published_at TEXT,
    published_by INTEGER REFERENCES users(id),
    edition_no INTEGER,
    UNIQUE (manual_id, version_no)
);

-- 게시된 버전은 본문을 고칠 수 없다(기획서 6.1)
CREATE TRIGGER IF NOT EXISTS trg_published_version_immutable
BEFORE UPDATE OF content_json, content_html, content_text, title ON manual_versions
WHEN OLD.published_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'published version is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_version_no_delete
BEFORE DELETE ON manual_versions
BEGIN
    SELECT RAISE(ABORT, 'versions are never deleted');
END;

CREATE TABLE IF NOT EXISTS manual_drafts (
    manual_id INTEGER PRIMARY KEY REFERENCES manuals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    saved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edit_locks (
    manual_id INTEGER PRIMARY KEY REFERENCES manuals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY,
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    version_id INTEGER NOT NULL REFERENCES manual_versions(id),
    requested_by INTEGER REFERENCES users(id),
    requested_at TEXT NOT NULL,
    request_comment TEXT,
    reminded_at TEXT,
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT,
    decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','cancelled')),
    comment TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    kind TEXT NOT NULL CHECK (kind IN ('image','file','source_original')),
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_extra_departments (
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    department_id INTEGER NOT NULL REFERENCES departments(id),
    PRIMARY KEY (manual_id, department_id)
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    department_id INTEGER REFERENCES departments(id),
    content_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id),
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, manual_id)
);

CREATE TABLE IF NOT EXISTS view_stats (
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    date TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (manual_id, date)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    department_id INTEGER,
    ip TEXT,
    detail TEXT
);

-- 감사 로그는 추가만 가능(기획서 6.1: 앱 계정에는 INSERT만)
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS hr_sync_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    run_by INTEGER,
    created INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    deactivated INTEGER DEFAULT 0,
    status TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS search_index (
    manual_id INTEGER NOT NULL REFERENCES manuals(id),
    scope TEXT NOT NULL CHECK (scope IN ('published','latest')),
    title TEXT NOT NULL,
    body_text TEXT NOT NULL,
    tags TEXT NOT NULL,
    PRIMARY KEY (manual_id, scope)
);

CREATE TABLE IF NOT EXISTS search_logs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user_id INTEGER,
    query TEXT NOT NULL,
    result_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    manual_id INTEGER,
    read_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_manuals_dept ON manuals(department_id);
CREATE INDEX IF NOT EXISTS ix_versions_manual ON manual_versions(manual_id);
CREATE INDEX IF NOT EXISTS ix_approvals_manual ON approvals(manual_id, decision);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_logs(at);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, read_at);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def migrate(conn: sqlite3.Connection):
    """이전 버전에서 만든 DB에 빠진 컬럼을 추가한다."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(approvals)")}
    if "reminded_at" not in cols:
        conn.execute("ALTER TABLE approvals ADD COLUMN reminded_at TEXT")
    conn.commit()


def init_db() -> bool:
    """스키마를 만들고, 비어 있으면 예시 데이터를 넣는다. 새로 만들었으면 True."""
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        empty = conn.execute("SELECT COUNT(*) FROM departments").fetchone()[0] == 0
        if empty:
            from .seed import seed
            seed(conn)
            conn.commit()
        return empty
    finally:
        conn.close()
