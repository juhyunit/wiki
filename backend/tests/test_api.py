"""권한·버전·게시 규칙 테스트(기획서 9.1 역할별 권한 표, 14장 완료 기준 일부).
실행: backend 폴더에서  python -m pytest -q
"""
import io
import json
import os
import sqlite3
import tempfile

import pytest

_tmp = tempfile.mkdtemp()
os.environ["WORKWIKI_DATA_DIR"] = _tmp

from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402

init_db()

H = {"X-WorkWiki": "1"}


@pytest.fixture(scope="module")
def clients():
    with TestClient(app) as base:
        base.get("/api/health")
    out = {}
    for un in ["admin", "hr_lead", "hr_staff", "ln_lead", "ln_staff", "dp_lead", "dp_staff", "ga_staff", "sec_lead"]:
        c = TestClient(app)
        r = c.post("/api/auth/login", json={"username": un, "password": "1234"}, headers=H)
        assert r.status_code == 200, r.text
        out[un] = c
    return out


def mid(c, no):
    for d in c.get("/api/tree").json():
        for m in d["manuals"]:
            if m["manual_no"] == no:
                return m["id"]
    return None


def test_login_and_csrf():
    c = TestClient(app)
    assert c.post("/api/auth/login", json={"username": "hr_staff", "password": "x"}, headers=H).status_code == 401
    assert c.post("/api/auth/login", json={"username": "hr_staff", "password": "1234"}).status_code == 403  # CSRF 헤더 없음
    assert c.get("/api/home").status_code == 401


def test_visibility_rules(clients):
    ga = clients["ga_staff"]
    # 부서 한정 + 추가 열람 부서(총무부) → 열람 가능
    assert ga.get("/api/manuals/3").status_code == 200
    # 부서 한정(여신심사부) → 트리·조회·검색 모두 차단
    assert mid(ga, "LN-0002") is None
    assert ga.get("/api/manuals/6").status_code == 403
    assert all(r["manual_no"] != "LN-0002" for r in ga.get("/api/search", params={"q": "감정"}).json()["results"])
    assert any(r["manual_no"] == "LN-0002" for r in clients["ln_staff"].get("/api/search", params={"q": "감정"}).json()["results"])


@pytest.mark.parametrize("method,path,body", [
    ("get", "/api/manuals/1/versions", None),
    ("get", "/api/manuals/1/diff?a=3&b=4", None),
    ("get", "/api/manuals/1/versions/4", None),
    ("post", "/api/manuals/1/lock", None),
    ("get", "/api/manuals/1/work-content", None),
    ("put", "/api/manuals/1/draft", {"title": "x", "content_json": {"type": "doc", "content": []}}),
    ("post", "/api/manuals/1/versions", {"title": "x", "content_json": {"type": "doc", "content": []}, "change_type": "오탈자"}),
    ("post", "/api/manuals/1/request-publish", {}),
    ("post", "/api/manuals/1/publish", {}),
    ("post", "/api/manuals/1/reject", {"comment": "no"}),
    ("patch", "/api/manuals/1", {"owner_id": 2}),
    ("post", "/api/manuals/1/archive", {}),
    ("post", "/api/manuals/1/versions/1/restore", None),
    ("post", "/api/departments/1/categories", {"name": "x"}),
    ("get", "/api/admin/users", None),
    ("get", "/api/admin/audit", None),
])
def test_other_department_blocked(clients, method, path, body):
    """타 부서 직원(총무부 사원)은 인사부 매뉴얼의 작업본·편집·게시·관리를 모두 못 한다."""
    ga = clients["ga_staff"]
    kw = {"headers": H}
    if body is not None:
        kw["json"] = body
    r = getattr(ga, method)(path, **kw)
    assert r.status_code == 403, (path, r.status_code, r.text)


def test_unpublished_changes_hidden(clients):
    # DP-0002는 v2(비대면 처리)가 게시 전 → 다른 부서 화면·검색에 안 보인다
    ga, dp = clients["ga_staff"], clients["dp_staff"]
    assert "비대면" not in ga.get("/api/manuals/8").json()["content_html"]
    assert ga.get("/api/search", params={"q": "비대면"}).json()["total"] == 0
    assert dp.get("/api/search", params={"q": "비대면", "work": "true"}).json()["total"] >= 1
    assert "비대면" in dp.get("/api/manuals/8", params={"view": "work"}).json()["content_html"]


def test_publish_flow_and_edition(clients):
    hs, hl = clients["hr_staff"], clients["hr_lead"]
    d = hs.get("/api/manuals/1", params={"view": "work"}).json()
    assert d["pending"] and d["perms"]["publish"] is False
    assert hs.post("/api/manuals/1/publish", json={}, headers=H).status_code == 403  # 승인 필요 부서의 부서원
    assert hs.post("/api/manuals/1/request-publish", json={}, headers=H).status_code == 409  # 중복 요청
    r = hl.post("/api/manuals/1/publish", json={"comment": "확인"}, headers=H)
    assert r.status_code == 200 and r.json()["edition"] == 4
    d = clients["ga_staff"].get("/api/manuals/1").json()
    assert d["published"]["version_no"] == 4 and d["edition"] == 4


def test_skip_mode_member_can_publish(clients):
    dp = clients["dp_staff"]
    d = dp.get("/api/manuals/8", params={"view": "work"}).json()
    assert d["perms"]["publish"] is True
    assert dp.post("/api/manuals/8/publish", json={}, headers=H).status_code == 200


def test_edit_lock_and_versions(clients):
    hs, hl = clients["hr_staff"], clients["hr_lead"]
    assert hs.post("/api/manuals/2/lock", headers=H).json()["ok"] is True
    other = hl.post("/api/manuals/2/lock", headers=H).json()
    assert other["ok"] is False and other["holder"]["user_name"] == "박성우"
    doc = hs.get("/api/manuals/2/work-content").json()["content_json"]
    doc["content"].append({"type": "paragraph", "content": [{"type": "text", "text": "추가 문단"}]})
    assert hl.put("/api/manuals/2/draft", json={"title": "t", "content_json": doc}, headers=H).status_code == 409
    assert hs.put("/api/manuals/2/draft", json={"title": "신규 입사자 온보딩 체크리스트", "content_json": doc}, headers=H).status_code == 200
    r = hs.post("/api/manuals/2/versions", json={"title": "신규 입사자 온보딩 체크리스트", "content_json": doc,
                                                  "change_type": "내용 보완", "change_reason": "문단 추가"}, headers=H)
    assert r.status_code == 200 and r.json()["version_no"] == 2
    df = hs.get("/api/manuals/2/diff", params={"a": "5", "b": str(r.json()["version_id"])}).json()
    assert df["stats"]["added"] == 1 and "diff-ins" in df["html"]
    # 강제 해제는 부서 관리자
    assert clients["ga_staff"].delete("/api/manuals/2/lock?force=true", headers=H).status_code == 403
    assert hl.delete("/api/manuals/2/lock?force=true", headers=H).status_code == 200


def test_restore_creates_new_version(clients):
    hs = clients["hr_staff"]
    vs = hs.get("/api/manuals/2/versions").json()["versions"]
    first = [v for v in vs if v["version_no"] == 1][0]
    r = hs.post(f"/api/manuals/2/versions/{first['id']}/restore", headers=H)
    assert r.status_code == 200 and r.json()["version_no"] == 3
    v3 = [v for v in hs.get("/api/manuals/2/versions").json()["versions"] if v["version_no"] == 3][0]
    assert v3["change_reason"] == "v1에서 복원"


def test_self_publish_blocked_by_separation(clients):
    ll = clients["ln_lead"]
    assert ll.post("/api/manuals/5/lock", headers=H).json()["ok"]
    doc = ll.get("/api/manuals/5/work-content").json()["content_json"]
    doc["content"].append({"type": "paragraph", "content": [{"type": "text", "text": "부서장 직접 수정"}]})
    ll.post("/api/manuals/5/versions", json={"title": "개인 신용대출 심사 절차", "content_json": doc, "change_type": "오탈자"}, headers=H)
    r = ll.post("/api/manuals/5/publish", json={}, headers=H)
    assert r.status_code == 403 and "직무 분리" in r.json()["detail"]


def test_sys_admin_cannot_edit_other_dept_but_can_read_history(clients):
    ad = clients["admin"]
    assert ad.get("/api/manuals/1/versions").status_code == 200
    assert ad.post("/api/manuals/1/lock", headers=H).status_code == 403


def test_immutable_tables():
    conn = sqlite3.connect(os.path.join(_tmp, "workwiki.db"))
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE manual_versions SET content_text='x' WHERE published_at IS NOT NULL")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("DELETE FROM audit_logs")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("DELETE FROM manual_versions")
    conn.close()


def test_xss_is_not_rendered(clients):
    hs = clients["hr_staff"]
    r = hs.post("/api/manuals", json={"title": "XSS 테스트", "visibility": "department"}, headers=H)
    m = r.json()["id"]
    hs.post(f"/api/manuals/{m}/lock", headers=H)
    evil = {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "<script>alert(1)</script>",
                                           "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}]}]},
        {"type": "image", "attrs": {"src": "https://evil.example/x.png", "onerror": "alert(1)"}},
        {"type": "iframe", "content": [{"type": "text", "text": "x"}]}]}
    hs.post(f"/api/manuals/{m}/versions", json={"title": "XSS 테스트", "content_json": evil, "change_type": "최초 작성"}, headers=H)
    html = hs.get(f"/api/manuals/{m}", params={"view": "work"}).json()["content_html"]
    assert "<script>" not in html and "javascript:" not in html and "evil.example" not in html and "<iframe" not in html


def test_attachment_permissions(clients):
    ls = clients["ln_staff"]
    png = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (10, 10), "red").save(png, "PNG")
    r = ls.post("/api/manuals/6/attachments", files={"file": ("a.png", png.getvalue(), "image/png")}, headers=H)
    assert r.status_code == 200
    url = r.json()["url"]
    assert ls.get(url).status_code == 200
    assert clients["ga_staff"].get(url).status_code == 403
    bad = ls.post("/api/manuals/6/attachments", files={"file": ("x.exe", b"MZ....", "application/octet-stream")}, headers=H)
    assert bad.status_code == 422
    fake = ls.post("/api/manuals/6/attachments", files={"file": ("x.pdf", b"not a pdf", "application/pdf")}, headers=H)
    assert fake.status_code == 422


def test_hr_sync_mass_deactivation_guard(clients):
    ad = clients["admin"]
    csv = "employee_no,name,department_code,position\nE1001,김지현,HR,과장\n"
    r = ad.post("/api/admin/hr-sync", files={"file": ("hr.csv", csv.encode(), "text/csv")}, data={"mode": "apply"}, headers=H)
    assert r.status_code == 409  # 대부분 비활성화 → 중단
    users = ad.get("/api/admin/users").json()
    assert sum(1 for u in users if u["is_active"]) >= 9


def test_search_korean_partial(clients):
    r = clients["ga_staff"].get("/api/search", params={"q": "결재"}).json()
    assert r["total"] >= 1 and "<mark>" in r["results"][0]["snippet_html"]
    r2 = clients["ga_staff"].get("/api/search", params={"q": "법인"}).json()
    assert r2["results"][0]["manual_no"] == "GA-0001"  # 제목 일치 우선


def test_unpublished_attachment_hidden_from_other_departments(clients):
    """게시 전에 올린 첨부는 공식본에 들어가기 전까지 타 부서에 보이지 않는다(기획서 14장)."""
    ls, ga = clients["ln_staff"], clients["ga_staff"]
    r = ls.post("/api/manuals/5/attachments", files={"file": ("draft.pdf", b"%PDF-1.4 x", "application/pdf")}, headers=H).json()
    assert all(a["id"] != r["id"] for a in ga.get("/api/manuals/5").json()["attachments"])
    assert ga.get(r["url"]).status_code == 403
    assert ls.get(r["url"]).status_code == 200  # 담당 부서는 작업 중에도 받을 수 있다


def test_list_item_level_diff(clients):
    df = clients["hr_staff"].get("/api/manuals/1/diff", params={"a": "3", "b": "4"}).json()
    assert df["stats"]["changed"] >= 1 and "<ins>" in df["html"] and "본부장" in df["html"]


def test_search_filters(clients):
    ga = clients["ga_staff"]
    assert ga.get("/api/search", params={"q": "신청", "cat": 999999}).json()["total"] == 0
    all_ = ga.get("/api/search", params={"q": "신청"}).json()["total"]
    recent = ga.get("/api/search", params={"q": "신청", "period": "1m"}).json()["total"]
    assert all_ >= recent


def test_validation_message_hides_internal_names(clients):
    msg = clients["hr_staff"].put("/api/manuals/1/draft", json={"title": "x"}, headers=H).json()["detail"]
    assert "content_json" not in msg


def test_stale_approval_reminder():
    from datetime import date
    from app import services as S
    assert S.business_days_between(date(2026, 11, 6), date(2026, 11, 11)) == 3  # 금→수: 월·화·수


def test_move_manuals_between_departments(clients):
    ad = clients["admin"]
    depts = {d["code"]: d["id"] for d in ad.get("/api/admin/departments").json()}
    assert clients["ga_staff"].post(f"/api/admin/departments/{depts['GA']}/move-manuals", json={"target_id": depts["SEC"]}, headers=H).status_code == 403
    r = ad.post(f"/api/admin/departments/{depts['GA']}/move-manuals", json={"target_id": depts["SEC"]}, headers=H)
    assert r.status_code == 200 and r.json()["moved"] == 2
    page = ad.get(f"/api/departments/{depts['SEC']}").json()
    assert any(m["manual_no"] == "GA-0001" for m in page["manuals"])
    assert any(c["name"] == "경비·법인카드" for c in page["categories"])
