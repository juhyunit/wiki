"""목록·요약 조회 공통 SQL."""
from __future__ import annotations

import json
from datetime import date

BASE_SELECT = """
SELECT m.*, d.name AS dept_name, d.code AS dept_code, d.approval_mode AS dept_mode,
       c.name AS cat_name, o.name AS owner_name, o.is_active AS owner_active,
       pv.version_no AS pub_version_no, pv.published_at AS published_at,
       lv.version_no AS latest_version_no, lv.created_at AS latest_at,
       (SELECT 1 FROM manual_drafts dr WHERE dr.manual_id = m.id) AS has_draft
FROM manuals m
JOIN departments d ON d.id = m.department_id
LEFT JOIN categories c ON c.id = m.category_id
LEFT JOIN users o ON o.id = m.owner_id
LEFT JOIN manual_versions pv ON pv.id = m.published_version_id
LEFT JOIN manual_versions lv ON lv.id = m.latest_version_id
"""


def summary(r, work_visible: bool = False) -> dict:
    today = date.today().isoformat()
    has_work = bool(r["has_draft"]) or (r["latest_version_id"] is not None and r["latest_version_id"] != r["published_version_id"])
    return {
        "id": r["id"],
        "manual_no": r["manual_no"],
        "title": r["title"],
        "department_id": r["department_id"],
        "department_name": r["dept_name"],
        "category_id": r["category_id"],
        "category_name": r["cat_name"],
        "owner_name": r["owner_name"],
        "owner_active": bool(r["owner_active"]) if r["owner_active"] is not None else True,
        "status": r["status"],
        "review_state": r["review_state"],
        "visibility": r["visibility"],
        "edition": r["edition"],
        "version_no": r["pub_version_no"],
        "latest_version_no": r["latest_version_no"] if work_visible else None,
        "published_at": r["published_at"],
        "updated_at": r["updated_at"],
        "next_review_date": r["next_review_date"],
        "review_overdue": bool(r["next_review_date"] and r["next_review_date"] < today and r["status"] == "published"),
        "has_work": has_work if work_visible else False,
        "tags": json.loads(r["tags"] or "[]"),
    }
