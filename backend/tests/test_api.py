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
os.environ["WORKWIKI_AI_WORKER"] = "0"  # 임베딩은 테스트에서 직접 부른다(뒤 작업자 없이 결과가 늘 같게)

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
    assert mid(ga, "2010-0002") is None
    assert ga.get("/api/manuals/6").status_code == 403
    assert all(r["manual_no"] != "2010-0002" for r in ga.get("/api/search", params={"q": "감정"}).json()["results"])
    assert any(r["manual_no"] == "2010-0002" for r in clients["ln_staff"].get("/api/search", params={"q": "감정"}).json()["results"])


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
    # 2020-0002(수신업무부)는 v2(비대면 처리)가 게시 전 → 다른 부서 화면·검색에 안 보인다
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
    csv = "employee_no,name,department_code,position\nE1001,김지현,1010,과장\n"
    r = ad.post("/api/admin/hr-sync", files={"file": ("hr.csv", csv.encode(), "text/csv")}, data={"mode": "apply"}, headers=H)
    assert r.status_code == 409  # 대부분 비활성화 → 중단
    users = ad.get("/api/admin/users").json()
    assert sum(1 for u in users if u["is_active"]) >= 9


def test_search_korean_partial(clients):
    r = clients["ga_staff"].get("/api/search", params={"q": "결재"}).json()
    assert r["total"] >= 1 and "<mark>" in r["results"][0]["snippet_html"]
    r2 = clients["ga_staff"].get("/api/search", params={"q": "법인"}).json()
    assert r2["results"][0]["manual_no"] == "1020-0001"  # 제목 일치 우선


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
    assert clients["ga_staff"].post(f"/api/admin/departments/{depts['1020']}/move-manuals", json={"target_id": depts["3010"]}, headers=H).status_code == 403
    r = ad.post(f"/api/admin/departments/{depts['1020']}/move-manuals", json={"target_id": depts["3010"]}, headers=H)
    assert r.status_code == 200 and r.json()["moved"] == 2
    page = ad.get(f"/api/departments/{depts['3010']}").json()
    assert any(m["manual_no"] == "1020-0001" for m in page["manuals"])
    assert any(c["name"] == "경비·법인카드" for c in page["categories"])


def test_text_style_renders_only_allowed_values(clients):
    """글자색·글꼴·글자 크기는 허용 목록 값만 화면에 그린다(그 밖의 CSS는 버림)."""
    hs = clients["hr_staff"]
    m = hs.post("/api/manuals", json={"title": "서식 테스트", "visibility": "department"}, headers=H).json()["id"]
    hs.post(f"/api/manuals/{m}/lock", headers=H)
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "허용", "marks": [{"type": "textStyle", "attrs": {
            "color": "#C0392B", "fontSize": "18px", "fontFamily": "Batang, AppleMyungjo, serif"}}]},
        {"type": "text", "text": "차단", "marks": [{"type": "textStyle", "attrs": {
            "color": "red;background:url(javascript:alert(1))", "fontSize": "999px", "fontFamily": "x;position:fixed"}}]},
    ]}]}
    r = hs.post(f"/api/manuals/{m}/versions", json={"title": "서식 테스트", "content_json": doc, "change_type": "최초 작성"}, headers=H)
    assert r.status_code == 200
    html = hs.get(f"/api/manuals/{m}", params={"view": "work"}).json()["content_html"]
    assert '<span style="color:#c0392b;font-family:Batang, AppleMyungjo, serif;font-size:18px">허용</span>' in html
    assert "javascript" not in html and "position" not in html and "999px" not in html
    assert "<p>" in html and "차단" in html  # 글자는 남고 서식만 버린다


def test_department_code_is_4_digits(clients):
    ad = clients["admin"]
    assert clients["hr_lead"].post("/api/admin/departments", json={"code": "3020", "name": "IT기획부"}, headers=H).status_code == 403
    for bad in ("IT", "302", "30201", "0302", "３０２０", "1０２０"):
        r = ad.post("/api/admin/departments", json={"code": bad, "name": "IT기획부"}, headers=H)
        assert r.status_code == 422 and "4자리" in r.json()["detail"], bad
    assert ad.post("/api/admin/departments", json={"code": "3020", "name": "IT기획부"}, headers=H).status_code == 200
    assert ad.post("/api/admin/departments", json={"code": "3020", "name": "다른부"}, headers=H).status_code == 409
    d = next(x for x in ad.get("/api/admin/departments").json() if x["code"] == "3020")
    assert d["name"] == "IT기획부"


def test_department_rename(clients):
    ad = clients["admin"]
    depts = {d["code"]: d for d in ad.get("/api/admin/departments").json()}
    if "3020" not in depts:
        ad.post("/api/admin/departments", json={"code": "3020", "name": "IT기획부"}, headers=H)
        depts = {d["code"]: d for d in ad.get("/api/admin/departments").json()}
    did = depts["3020"]["id"]
    assert clients["hr_lead"].patch(f"/api/admin/departments/{did}", json={"name": "디지털기획부"}, headers=H).status_code == 403
    assert ad.patch(f"/api/admin/departments/{did}", json={"name": "  "}, headers=H).status_code == 422
    assert ad.patch(f"/api/admin/departments/{did}", json={"name": "인사부"}, headers=H).status_code == 409
    assert ad.patch(f"/api/admin/departments/{did}", json={"name": " 디지털기획부 "}, headers=H).status_code == 200
    assert any(d["id"] == did and d["name"] == "디지털기획부" and d["code"] == "3020" for d in ad.get("/api/departments").json())
    log = ad.get("/api/admin/audit", params={"action": "dept.update"}).json()["items"][0]
    assert log["detail"]["from_name"] == "IT기획부" and log["detail"]["name"] == "디지털기획부"


def test_legacy_department_codes_migrated(tmp_path):
    """영문 부서 코드로 만든 예전 DB는 4자리 숫자 코드로 바뀌고, 문서 번호 앞자리도 함께 바뀐다."""
    import sqlite3
    from app.db import SCHEMA, migrate
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO departments(id, code, name) VALUES (1,'HR','인사부'), (2,'IT','IT부'), (3,'2010','여신심사부')")
    conn.execute("INSERT INTO manuals(manual_no, title, department_id) VALUES ('HR-0001','a',1), ('IT-0003','b',2), ('2010-0001','c',3)")
    migrate(conn)
    codes = {r["name"]: r["code"] for r in conn.execute("SELECT name, code FROM departments")}
    assert codes == {"인사부": "1010", "IT부": "9001", "여신심사부": "2010"}
    nos = sorted(r[0] for r in conn.execute("SELECT manual_no FROM manuals"))
    assert nos == ["1010-0001", "2010-0001", "9001-0003"]


# ====================================================================== 문서 링크·역링크
def test_links_and_backlinks_respect_permissions(clients):
    ls, ga, dp = clients["ln_staff"], clients["ga_staff"], clients["dp_staff"]
    # 신용대출(5) → 감정평가(6, 여신심사부 한정): 여신심사부는 제목이 보이고, 총무부는 '열람 권한 없음'만 보인다
    out = ls.get("/api/manuals/5/links").json()["outgoing"]
    assert out[0]["id"] == 6 and out[0]["access"] == "ok" and out[0]["title"]
    out = ga.get("/api/manuals/5/links").json()["outgoing"]
    assert out == [{"id": None, "access": "denied", "link_text": ""}]
    # PC 보안 점검(10)의 역링크: 온보딩(2)·개인정보 사고 대응(9)
    back = {b["id"] for b in ga.get("/api/manuals/10/links").json()["backlinks"]}
    assert back == {2, 9}
    # 온보딩(2)의 역링크: 인사발령(3, 인사부 한정 + 총무부·정보보호부 추가 열람) → 총무부는 보이고 수신업무부는 안 보인다
    assert [b["id"] for b in ga.get("/api/manuals/2/links").json()["backlinks"]] == [3]
    assert dp.get("/api/manuals/2/links").json()["backlinks"] == []


def test_new_link_is_indexed_on_save(clients):
    hs = clients["hr_staff"]
    m = hs.post("/api/manuals", json={"title": "링크 테스트", "visibility": "company"}, headers=H).json()["id"]
    hs.post(f"/api/manuals/{m}/lock", headers=H)
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "법인카드", "marks": [{"type": "link", "attrs": {"href": "#/m/11"}}]}]}]}
    hs.post(f"/api/manuals/{m}/versions", json={"title": "링크 테스트", "content_json": doc, "change_type": "최초 작성"}, headers=H)
    html = hs.get(f"/api/manuals/{m}", params={"view": "work"}).json()["content_html"]
    assert 'href="#/m/11" class="manual-link"' in html
    # 게시 전 작업본의 링크는 담당 부서에만 '작업본' 역링크로 보인다
    assert any(b["id"] == m and b["scope"] == "work" for b in hs.get("/api/manuals/11/links").json()["backlinks"])
    assert all(b["id"] != m for b in clients["ga_staff"].get("/api/manuals/11/links").json()["backlinks"])


# ====================================================================== 내보내기
@pytest.mark.parametrize("fmt", ["md", "html", "docx", "pdf"])
def test_export_formats(clients, fmt):
    ls = clients["ln_staff"]
    r = ls.get("/api/manuals/5/export", params={"format": fmt})
    assert r.status_code == 200, r.text
    assert "attachment;" in r.headers["content-disposition"] and quote_name("2010-0001") in r.headers["content-disposition"]
    body = r.content
    if fmt == "md":
        t = body.decode()
        assert t.startswith("---\ntitle: \"개인 신용대출 심사 절차\"") and "| 소득 형태 |" in t and "> [!IMPORTANT]" in t
        assert "](http://testserver/#/m/6)" in t  # 문서 링크는 서버 주소를 붙인다
    elif fmt == "html":
        t = body.decode()
        assert "<!DOCTYPE html>" in t and "문서 관리 정보" in t and "<script" not in t and "http://testserver/#/m/6" in t
    elif fmt == "docx":
        import zipfile
        z = zipfile.ZipFile(io.BytesIO(body))
        xml = z.read("word/document.xml").decode()
        assert "개인 신용대출 심사 절차" in xml and "<w:tbl>" in xml and "word/numbering.xml" in z.namelist()
    else:
        assert body[:5] == b"%PDF-" and len(body) > 3000


def test_export_permissions_and_audit(clients):
    ga = clients["ga_staff"]
    assert ga.get("/api/manuals/6/export", params={"format": "md"}).status_code == 403  # 부서 한정 문서
    assert ga.get("/api/manuals/5/export", params={"format": "exe"}).status_code == 422
    # 작업본을 요청해도 담당 부서가 아니면 공식본만 내려받는다(게시 전 문구 없음)
    dp = clients["dp_staff"]
    dp.post("/api/manuals/7/lock", headers=H)
    doc = dp.get("/api/manuals/7/work-content").json()["content_json"]
    doc["content"].append({"type": "paragraph", "content": [{"type": "text", "text": "게시전내보내기확인문구"}]})
    assert dp.post("/api/manuals/7/versions", json={"title": "예금 계좌 개설 업무 처리", "content_json": doc, "change_type": "내용 보완"},
                   headers=H).status_code == 200
    dp.delete("/api/manuals/7/lock", headers=H)
    md = ga.get("/api/manuals/7/export", params={"format": "md", "view": "work"}).text
    assert "게시전내보내기확인문구" not in md and "공식본" in md
    md = dp.get("/api/manuals/7/export", params={"format": "md", "view": "work"}).text
    assert "게시전내보내기확인문구" in md and "작업본" in md
    logs = clients["admin"].get("/api/admin/audit", params={"action": "manual.export"}).json()["items"]
    assert any(x["detail"].get("format") == "md" for x in logs)


def test_export_embeds_images(clients):
    ls = clients["ln_staff"]
    png = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (40, 20), "blue").save(png, "PNG")
    up = ls.post("/api/manuals/6/attachments", files={"file": ("p.png", png.getvalue(), "image/png")}, headers=H).json()
    ls.post("/api/manuals/6/lock", headers=H)
    doc = ls.get("/api/manuals/6/work-content").json()["content_json"]
    doc["content"].append({"type": "image", "attrs": {"src": up["url"], "alt": "그림", "title": "캡션"}})
    ls.post("/api/manuals/6/versions", json={"title": "담보대출 감정평가 의뢰 방법", "content_json": doc, "change_type": "내용 보완"}, headers=H)
    ls.delete("/api/manuals/6/lock", headers=H)
    html = ls.get("/api/manuals/6/export", params={"format": "html", "view": "work"}).text
    assert "data:image/png;base64," in html and "/api/files/" not in html
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(ls.get("/api/manuals/6/export", params={"format": "docx", "view": "work"}).content))
    assert any(n.startswith("word/media/") for n in z.namelist())
    assert ls.get("/api/manuals/6/export", params={"format": "pdf", "view": "work"}).status_code == 200


def quote_name(s):
    from urllib.parse import quote
    return quote(s)


# ====================================================================== 새 API 권한(403)
@pytest.mark.parametrize("who,method,path,body", [
    ("ga_staff", "get", "/api/manuals/6/links", None),
    ("ga_staff", "get", "/api/manuals/6/export?format=pdf", None),
    ("ga_staff", "post", "/api/ai/ask", {"question": "감정평가", "manual_id": 6}),
    ("hr_lead", "get", "/api/admin/ai", None),
    ("hr_lead", "put", "/api/admin/ai", {"enabled": False}),
    ("hr_lead", "post", "/api/admin/ai/pull", {"model": "qwen3:4b"}),
    ("hr_lead", "get", "/api/admin/ai/pull", None),
    ("hr_lead", "post", "/api/admin/ai/delete-model", {"model": "qwen3:4b"}),
    ("hr_lead", "post", "/api/admin/ai/reindex", {"reset": True}),
    ("ga_staff", "get", "/api/admin/ai", None),
])
def test_new_apis_forbidden(clients, who, method, path, body):
    kw = {"headers": H}
    if body is not None:
        kw["json"] = body
    r = getattr(clients[who], method)(path, **kw)
    assert r.status_code == 403, (path, r.status_code, r.text)


# ====================================================================== AI 질의응답(가짜 로컬 모델 서버)
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class FakeOllama(BaseHTTPRequestHandler):
    models = ["qwen3:4b", "bge-m3:latest"]
    prompts: list = []

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/api/tags":
            return self._send({"models": [{"name": m, "size": 1000, "details": {"family": "qwen3"}} for m in FakeOllama.models]})
        if self.path == "/api/version":
            return self._send({"version": "0.12.0"})
        self._send({"error": "not found"}, 404)

    def _stream(self, lines):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for ln in lines:
            self.wfile.write((json.dumps(ln) + "\n").encode())
            self.wfile.flush()

    def do_POST(self):
        b = self._body()
        if self.path == "/api/chat":
            FakeOllama.prompts.append(b)
            parts = ["<think>생각 중", "</think>", "모든 신청 건은 소득 증빙을 받습니다 [2].", " 연소득의 1.5배를 넘으면 추가로 받습니다 [3][9]."]
            return self._stream([{"message": {"content": p}, "done": False} for p in parts] + [{"message": {"content": ""}, "done": True}])
        if self.path == "/api/embed":
            from app.chunks import tokens
            def vec(t):
                v = [0.0] * 32
                for tok in tokens(t):
                    v[hash(tok) % 32] += 1
                return v
            return self._send({"embeddings": [vec(t) for t in b["input"]]})
        if self.path == "/api/pull":
            FakeOllama.models.append(b["model"])
            return self._stream([{"status": "pulling manifest"}, {"status": "downloading", "total": 100, "completed": 100}, {"status": "success"}])
        self._send({"error": "not found"}, 404)

    def do_DELETE(self):
        b = self._body()
        if b.get("model") in FakeOllama.models:
            FakeOllama.models.remove(b["model"])
            return self._send({})
        self._send({"error": "model not found"}, 404)


@pytest.fixture(scope="module")
def fake_model():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def ask(c, q, **kw):
    r = c.post("/api/ai/ask", json={"question": q, **kw}, headers=H)
    assert r.status_code == 200, r.text
    return [json.loads(x) for x in r.text.splitlines() if x.strip()]


def test_ai_extractive_without_model(clients):
    """모델 서버가 없으면 근거 문단만 준다(추측 답변 없음). 예시 질문에 신용대출 매뉴얼의 소득 확인 문단이 나온다."""
    ev = ask(clients["ga_staff"], "대출 심사 시 소득 증빙이 필요한 경우는?")
    meta, sources, done = ev[0], ev[1]["sources"], ev[-1]
    assert meta["mode"] == "extractive" and done["answer"] == "" and done["notice"]
    assert sources and sources[0]["manual_no"] == "2010-0001"
    assert any("1.5배" in s["text"] for s in sources) and any("<mark>" in s["text_html"] for s in sources)


def test_ai_admin_settings_validation(clients, fake_model):
    ad = clients["admin"]
    r = ad.put("/api/admin/ai", json={"base_url": "https://api.example.com"}, headers=H)
    assert r.status_code == 422 and "외부" in r.json()["detail"]
    r = ad.put("/api/admin/ai", json={"chat_model": "bad model;rm"}, headers=H)
    assert r.status_code == 422
    r = ad.put("/api/admin/ai", json={"base_url": fake_model, "provider": "ollama", "chat_model": "qwen3:4b", "embed_model": "bge-m3"}, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"]["reachable"] and d["status"]["chat_ready"] and d["status"]["embed_ready"] and d["mode"] == "generate"
    assert ad.get("/api/admin/audit", params={"action": "ai.settings"}).json()["items"]


def test_ai_generate_answer_with_citations_and_permissions(clients, fake_model):
    from app import ai
    from app.db import connect
    conn = connect()
    try:
        assert ai.embed_pending(conn, ai.get_settings(conn), limit=1000) > 0
    finally:
        conn.close()
    FakeOllama.prompts.clear()
    ev = ask(clients["ga_staff"], "대출 심사 시 소득 증빙이 필요한 경우는?")
    meta, sources = ev[0], ev[1]["sources"]
    deltas = "".join(e["text"] for e in ev if e["type"] == "delta")
    done = ev[-1]
    assert meta["mode"] == "generate" and meta["model"] == "qwen3:4b" and meta["semantic"] is True
    assert "생각" not in deltas and "<think>" not in deltas  # 생각 과정은 보이지 않는다
    assert done["cited"] == [2, 3] and "[9]" not in done["answer"]  # 없는 근거 번호는 지운다
    prompt = FakeOllama.prompts[-1]["messages"][1]["content"]
    assert "[근거]" in prompt and "대출 심사 시 소득 증빙" in prompt and FakeOllama.prompts[-1]["think"] is False
    # 부서 한정 문서(감정평가, 여신심사부)는 총무부 직원의 근거·모델 입력에 들어가지 않는다
    FakeOllama.prompts.clear()
    ev = ask(clients["ga_staff"], "담보대출 감정평가 의뢰 절차와 협약 법인 배정 방법은?")
    assert all(s["manual_no"] != "2010-0002" for s in ev[1]["sources"])
    assert all("감정평가 의뢰서" not in p["messages"][1]["content"] for p in FakeOllama.prompts)
    ev = ask(clients["ln_staff"], "담보대출 감정평가 의뢰 절차와 협약 법인 배정 방법은?")
    assert ev[1]["sources"][0]["manual_no"] == "2010-0002"
    # 한 문서 안에서만 묻기
    ev = ask(clients["ln_staff"], "소득 증빙", manual_id=5)
    assert {s["manual_id"] for s in ev[1]["sources"]} == {5}
    logs = clients["admin"].get("/api/admin/ai").json()["logs"]
    assert logs and logs[0]["mode"] in ("generate", "extractive")


def test_ai_worker_fills_embeddings_after_commit(clients, fake_model):
    """설정을 바꾸거나 다시 만들면 뒤 작업자가 '확정된' 설정을 읽고 임베딩을 채운다(깨우는 시점 경쟁 방지)."""
    import time
    from app import ai
    ad = clients["admin"]
    ai.start_worker()
    try:
        # 임베딩 모델을 바꾸면 기존 임베딩은 모두 다시 만들어야 한다
        d = ad.put("/api/admin/ai", json={"embed_model": "bge-m3:latest"}, headers=H).json()
        assert d["progress"]["done"] == 0 and d["progress"]["total"] > 0
        for _ in range(40):
            p = ad.get("/api/admin/ai").json()["progress"]
            if p["done"] == p["total"]:
                break
            time.sleep(0.25)
        assert p["done"] == p["total"], p
    finally:
        ai.stop_worker()
        ad.put("/api/admin/ai", json={"embed_model": "bge-m3"}, headers=H)


def test_ai_model_pull_delete_and_off(clients, fake_model):
    import time
    ad = clients["admin"]
    assert ad.post("/api/admin/ai/pull", json={"model": "qwen3:1.7b"}, headers=H).status_code == 200
    for _ in range(50):
        st = ad.get("/api/admin/ai/pull").json()
        if not st.get("running"):
            break
        time.sleep(0.05)
    assert st["status"] == "완료" and "qwen3:1.7b" in FakeOllama.models
    # 쓰는 답변 모델을 지우면 설정에서도 빠지고 근거 문단만 보여 준다
    d = ad.post("/api/admin/ai/delete-model", json={"model": "qwen3:4b"}, headers=H).json()
    assert d["settings"]["chat_model"] == "" and d["mode"] == "extractive"
    assert ask(clients["hr_staff"], "연차 신청 기한")[0]["mode"] == "extractive"
    # 끄면 질의응답 API가 막힌다
    ad.put("/api/admin/ai", json={"enabled": False}, headers=H)
    assert clients["hr_staff"].post("/api/ai/ask", json={"question": "연차"}, headers=H).status_code == 409
    assert clients["hr_staff"].get("/api/ai/status").json()["mode"] == "off"
    ad.put("/api/admin/ai", json={"enabled": True, "chat_model": "qwen3:4b", "base_url": "http://127.0.0.1:11434"}, headers=H)


def test_chunking_and_query_terms():
    from app.chunks import doc_chunks, query_terms
    from app.seed import LOAN_V2
    ch = doc_chunks(LOAN_V2)
    assert any(c["heading"] == "4. 소득 확인 기준" and c["kind"] == "table" and c["text"].startswith("모든 신청 건은") for c in ch)
    assert all(c["anchor"] and c["anchor"].startswith("h-") for c in ch)
    keys, toks = query_terms("대출 심사 시 소득 증빙이 필요한 경우는?")
    assert keys[:4] == ["대출", "심사", "소득", "증빙"] and "서류" in [k for k in toks]
