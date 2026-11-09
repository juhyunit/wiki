"""AI 문서 검색·질의응답 API와 관리자용 모델 관리 API."""
from __future__ import annotations

import json
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import ai
from . import services as S
from .db import connect
from .deps import client_ip, current_user, get_conn, get_manual, require
from .policy import User, can, visible_filter_sql

router = APIRouter(prefix="/api")
_recent: dict[int, list[float]] = defaultdict(list)
RATE_PER_MIN = 20


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    manual_id: int | None = None
    dept: int | None = None


def _line(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def _log(user_id, question, mode, sources, model, started, error=None):
    conn = connect()
    try:
        conn.execute("INSERT INTO ai_logs(at, user_id, question, mode, source_count, manual_ids, model, ms, error) VALUES (?,?,?,?,?,?,?,?,?)",
                     (S.now(), user_id, question, mode, len(sources), json.dumps(sorted({s["manual_id"] for s in sources})),
                      model, int((time.time() - started) * 1000), error))
        conn.commit()
    finally:
        conn.close()


@router.get("/ai/status")
def ai_status(u: User = Depends(current_user), conn=Depends(get_conn)):
    conn.commit()  # 모델 서버에 묻는 동안 DB 쓰기 잠금(세션 연장)을 잡고 있지 않는다
    cfg = ai.get_settings(conn)
    mode, notice = ai.answer_mode(cfg)
    st = ai.server_status(cfg) if cfg["enabled"] else {}
    return {"enabled": cfg["enabled"], "mode": mode, "notice": notice,
            "chat_model": cfg["chat_model"] if mode == "generate" else None,
            "semantic": bool(st.get("embed_ready"))}


@router.post("/ai/ask")
def ask(body: AskIn, u: User = Depends(current_user), conn=Depends(get_conn)):
    """질문 → 근거 문단(권한 안에서만) → 로컬 모델 답변(있을 때). 결과는 한 줄에 하나씩 JSON(NDJSON)으로 흘려보낸다."""
    started = time.time()
    conn.commit()  # 모델 서버(상태 확인·질문 임베딩·답변)를 부르는 동안 DB 쓰기 잠금을 잡고 있지 않는다
    cfg = ai.get_settings(conn)
    mode, notice = ai.answer_mode(cfg)
    if mode == "off":
        raise HTTPException(409, notice)
    q = body.question.strip()
    if not q:
        raise HTTPException(422, "질문을 입력하세요.")
    hits = [t for t in _recent[u.id] if t > started - 60]
    if len(hits) >= RATE_PER_MIN:
        raise HTTPException(429, "질문이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.")
    _recent[u.id] = hits + [started]

    if body.manual_id:
        m = get_manual(conn, body.manual_id)
        require(conn, u, "view_published", m, msg="이 매뉴얼을 열람할 권한이 없습니다.")
    vis, vp = visible_filter_sql(u)
    sql = ("SELECT c.*, m.title, m.manual_no, m.tags, m.edition, d.name AS dept_name, v.version_no FROM ai_chunks c"
           " JOIN manuals m ON m.id=c.manual_id JOIN departments d ON d.id=m.department_id JOIN manual_versions v ON v.id=c.version_id"
           f" WHERE {vis} AND m.status != 'archived' AND c.version_id = m.published_version_id")
    params = list(vp)
    if body.manual_id:
        sql += " AND m.id=?"
        params.append(body.manual_id)
    if body.dept:
        sql += " AND m.department_id=?"
        params.append(body.dept)
    rows = conn.execute(sql + " ORDER BY c.manual_id, c.ord", params).fetchall()
    # SQL 조건과 별도로 문서마다 can()을 다시 확인한다(권한 없는 문단이 모델에 들어가지 않게)
    allowed = {}
    for mid in {r["manual_id"] for r in rows}:
        mr = conn.execute("SELECT * FROM manuals WHERE id=?", (mid,)).fetchone()
        allowed[mid] = can(conn, u, "view_published", mr)
    rows = [r for r in rows if allowed.get(r["manual_id"])]
    sources, info = ai.retrieve(conn, rows, q, cfg)
    public = [{k: s[k] for k in ("n", "manual_id", "manual_no", "title", "department_name", "edition", "version_no", "heading",
                                 "anchor", "kind", "text", "text_html", "match")} for s in sources]

    def stream():
        model = cfg["chat_model"] if mode == "generate" and sources else None
        yield _line({"type": "meta", "mode": mode if sources else "none", "notice": notice if sources else None,
                     "model": model, "semantic": info.get("semantic", False), "keys": info.get("keys", [])})
        yield _line({"type": "sources", "sources": public})
        if not sources:
            yield _line({"type": "done", "answer": "", "cited": [],
                         "notice": "질문과 관련된 공식 매뉴얼 문단을 찾지 못했습니다. 다른 낱말로 다시 물어보세요."})
            _log(u.id, q, "none", [], None, started)
            return
        if mode != "generate":
            yield _line({"type": "done", "answer": "", "cited": [], "notice": notice})
            _log(u.id, q, "extractive", sources, None, started)
            return
        if not ai.GEN_SLOTS.acquire(timeout=30):
            msg = "다른 질문의 답을 만드는 중이라 근거 문단만 보여 드립니다. 잠시 뒤에 다시 물어보세요."
            yield _line({"type": "done", "answer": "", "cited": [], "notice": msg})
            _log(u.id, q, "busy", sources, model, started)
            return
        flt = ai.ThinkFilter()
        err = None
        try:
            for piece in ai.Provider(cfg).chat(ai.build_messages(q, sources), cfg["chat_model"]):
                out = flt.feed(piece)
                if out:
                    yield _line({"type": "delta", "text": out})
        except ai.ModelError as e:
            err = str(e)
        except Exception as e:  # 연결이 끊기는 등
            err = f"답변을 만들다 멈췄습니다({type(e).__name__})."
        finally:
            ai.GEN_SLOTS.release()
        answer, cited = ai.clean_answer(flt.raw, len(sources))
        yield _line({"type": "done", "answer": answer, "cited": cited,
                     "notice": (f"답변을 만들지 못했습니다: {err} 근거 문단을 확인하세요." if err else None)})
        _log(u.id, q, "generate" if not err else "error", sources, model, started, err)

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ 관리자: 모델 설정·내려받기·삭제
class AiSettingsIn(BaseModel):
    enabled: bool | None = None
    provider: str | None = None
    base_url: str | None = Field(default=None, max_length=200)
    chat_model: str | None = Field(default=None, max_length=100)
    embed_model: str | None = Field(default=None, max_length=100)
    top_k: int | None = None
    temperature: float | None = None
    timeout: int | None = None


class ModelIn(BaseModel):
    model: str = Field(min_length=1, max_length=100)


class ReindexIn(BaseModel):
    reset: bool = False


def _admin_payload(conn):
    conn.commit()  # 설정 저장 등을 확정한 뒤 모델 서버에 묻는다
    cfg = ai.get_settings(conn)
    st = ai.server_status(cfg, fresh=True)
    logs = [dict(r) | {"manual_ids": json.loads(r["manual_ids"] or "[]")} for r in conn.execute(
        "SELECT l.*, u.name AS user_name FROM ai_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 30")]
    mode, notice = ai.answer_mode(cfg)
    week = conn.execute("SELECT COUNT(*) FROM ai_logs WHERE at >= datetime('now','localtime','-7 days')").fetchone()[0]
    return {"settings": cfg, "presets": ai.PRESETS, "status": st, "mode": mode, "notice": notice,
            "progress": ai.embed_progress(conn, cfg), "pull": dict(ai.pull_job), "logs": logs, "questions_7d": week}


@router.get("/admin/ai")
def admin_ai(u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin", msg="AI 모델 설정은 시스템 관리자만 볼 수 있습니다.")
    return _admin_payload(conn)


@router.put("/admin/ai")
def admin_ai_save(body: AiSettingsIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin", msg="AI 모델 설정은 시스템 관리자만 바꿀 수 있습니다.")
    before = ai.get_settings(conn)
    try:
        cfg = ai.save_settings(conn, body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(422, str(e))
    changes = {k: {"from": before[k], "to": cfg[k]} for k in cfg if before.get(k) != cfg[k]}
    S.audit(conn, u, "ai.settings", "ai", None, None, changes, client_ip(request))
    payload = _admin_payload(conn)  # 여기서 확정(commit)한 뒤 작업자를 깨운다
    ai.wake_worker()
    return payload


@router.post("/admin/ai/pull")
def admin_ai_pull(body: ModelIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin", msg="모델 내려받기는 시스템 관리자만 할 수 있습니다.")
    name = body.model.strip()
    if not ai.MODEL_RE.match(name):
        raise HTTPException(422, "모델 이름에 쓸 수 없는 글자가 있습니다.")
    cfg = ai.get_settings(conn)
    if cfg["provider"] != "ollama":
        raise HTTPException(409, "모델 내려받기는 Ollama 서버에서만 됩니다.")
    try:
        job = ai.start_pull(cfg, name)
    except ai.ModelError as e:
        raise HTTPException(409, str(e))
    S.audit(conn, u, "ai.model_pull", "ai", None, None, {"model": name}, client_ip(request))
    return job


@router.get("/admin/ai/pull")
def admin_ai_pull_status(u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin")
    return dict(ai.pull_job)


@router.post("/admin/ai/delete-model")
def admin_ai_delete(body: ModelIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin", msg="모델 삭제는 시스템 관리자만 할 수 있습니다.")
    cfg = ai.get_settings(conn)
    name = body.model.strip()
    conn.commit()
    try:
        ai.Provider(cfg).delete(name)
    except ai.ModelError as e:
        raise HTTPException(409, str(e))
    # 지금 쓰는 모델을 지웠으면 설정에서도 뺀다(빈 값 = 그 기능 끔)
    cleared = {k: "" for k in ("chat_model", "embed_model") if cfg[k] and (cfg[k] == name or f"{cfg[k]}:latest" == name)}
    if cleared:
        ai.save_settings(conn, cleared)
    S.audit(conn, u, "ai.model_delete", "ai", None, None, {"model": name, "cleared": list(cleared)}, client_ip(request))
    ai._status_cache.clear()
    return _admin_payload(conn)


@router.post("/admin/ai/reindex")
def admin_ai_reindex(body: ReindexIn, request: Request, u: User = Depends(current_user), conn=Depends(get_conn)):
    require(conn, u, "admin", msg="색인 다시 만들기는 시스템 관리자만 할 수 있습니다.")
    S.reindex_all(conn, rechunk=body.reset)
    S.audit(conn, u, "ai.reindex", "ai", None, None, {"reset": body.reset}, client_ip(request))
    payload = _admin_payload(conn)
    ai.wake_worker()
    return payload
