"""데모(브라우저 전용) 빌드에 넣을 예시 데이터를 JSON으로 내보낸다. 비밀번호·세션은 넣지 않는다."""
import json, os, sys, tempfile
from datetime import datetime

tmp = tempfile.mkdtemp()
os.environ["WORKWIKI_DATA_DIR"] = tmp
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.db import init_db, connect  # noqa: E402

init_db()
conn = connect()
out = {"exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
tables = ["departments", "users", "dept_admins", "system_roles", "categories", "manuals", "manual_versions", "manual_drafts",
          "approvals", "manual_extra_departments", "templates", "favorites", "view_stats", "audit_logs", "hr_sync_runs",
          "search_logs", "notifications"]
for t in tables:
    rows = [dict(r) for r in conn.execute(f"SELECT * FROM {t}")]
    for r in rows:
        r.pop("password_hash", None)
        for k in ("content_json", "tags", "detail"):
            if k in r and isinstance(r[k], str):
                r[k] = json.loads(r[k])
        r.pop("content_text", None)
    out[t] = rows
dest = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "api", "demo-seed.json")
json.dump(out, open(dest, "w"), ensure_ascii=False, separators=(",", ":"))
print("wrote", dest, os.path.getsize(dest), "bytes")
