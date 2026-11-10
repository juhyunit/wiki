"""wikiLink 프로토타입 서버.

실행: python -m app  (backend 폴더에서)  → http://localhost:8000
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import ai
from .db import init_db
from .routes_admin import router as admin_router
from .routes_ai import router as ai_router
from .routes_auth import router as auth_router
from .routes_manuals import router as manuals_router

STATIC_DIR = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def lifespan(_app):
    init_db()
    # 로컬 임베딩 모델이 있으면 뒤에서 근거 문단 임베딩을 채운다(모델 서버가 꺼져 있어도 서버는 정상 동작)
    if os.environ.get("WORKWIKI_AI_WORKER", "1") == "1":
        ai.start_worker()
    yield
    ai.stop_worker()


# API 문서 화면은 외부 CDN을 불러오므로 기본으로 끈다(기획서 2.2 내부망 원칙). 필요하면 WORKWIKI_API_DOCS=1
_docs = os.environ.get("WORKWIKI_API_DOCS") == "1"
app = FastAPI(title="wikiLink", version="0.2.0", docs_url="/api/docs" if _docs else None,
              openapi_url="/api/openapi.json" if _docs else None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def security(request: Request, call_next):
    # CSRF: 상태를 바꾸는 API 요청은 사용자 지정 헤더가 있어야 한다(다른 사이트의 폼 전송 차단)
    if request.url.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
        if request.headers.get("x-workwiki") != "1":
            return JSONResponse({"detail": "잘못된 요청입니다(CSRF)."}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if not request.url.path.startswith("/api/docs"):
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            "font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
        )
    if request.url.path.startswith("/api/") and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    labels = {"title": "제목", "name": "이름", "username": "아이디", "employee_no": "사번", "code": "부서 코드",
              "new": "새 비밀번호", "comment": "의견", "change_reason": "변경 내용", "content_json": "본문"}
    first = exc.errors()[0] if exc.errors() else {}
    loc = [str(x) for x in first.get("loc", [])[1:]]
    field = labels.get(loc[-1], "") if loc else ""
    # 화면에 내부 필드명·JSON 구조를 보이지 않는다(기획서 2.1)
    return JSONResponse({"detail": f"{field} 항목을 확인하세요." if field else "입력값을 확인하세요."}, status_code=422)


app.include_router(auth_router)
app.include_router(manuals_router)
app.include_router(admin_router)
app.include_router(ai_router)


@app.get("/api/health")
def health():
    return {"ok": True}


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        f = STATIC_DIR / path
        if path and f.is_file() and STATIC_DIR in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
