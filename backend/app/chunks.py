"""본문 JSON에서 문서 링크를 뽑고, AI 질의응답용 근거 문단으로 나누고, 한국어 검색어를 토큰으로 바꾼다.

frontend/src/lib/knowledge.ts(데모 어댑터)와 같은 규칙을 유지한다.
"""
from __future__ import annotations

import math
import re
from collections import Counter

INTERNAL_LINK_RE = re.compile(r"^#/m/(\d+)(?:[?#].*)?$")
CALLOUT_LABEL = {"warning": "주의", "danger": "중요", "info": "참고"}
MAX_CHUNK = 700


# ------------------------------------------------------------------ 링크
def internal_target(href) -> int | None:
    if not isinstance(href, str):
        return None
    m = INTERNAL_LINK_RE.match(href.strip())
    return int(m.group(1)) if m else None


def doc_links(doc) -> dict[int, str]:
    """본문 안 내부 링크: {대상 매뉴얼 id: 링크 글자}."""
    out: dict[int, str] = {}

    def walk(n):
        if not isinstance(n, dict):
            return
        if n.get("type") == "text":
            for mk in n.get("marks") or []:
                if isinstance(mk, dict) and mk.get("type") == "link":
                    t = internal_target((mk.get("attrs") or {}).get("href"))
                    if t is not None:
                        out[t] = (out.get(t, "") + (n.get("text") or ""))[:200]
        for c in n.get("content") or []:
            walk(c)

    walk(doc)
    return {k: v.strip() for k, v in out.items()}


# ------------------------------------------------------------------ 근거 문단
def _plain(n) -> str:
    if not isinstance(n, dict):
        return ""
    t = n.get("type")
    if t == "text":
        return n.get("text") or ""
    if t == "hardBreak":
        return " "
    return "".join(_plain(c) for c in n.get("content") or [])


def _count_headings(n) -> int:
    if not isinstance(n, dict):
        return 0
    return (1 if n.get("type") == "heading" else 0) + sum(_count_headings(c) for c in n.get("content") or [])


def _list_lines(node, depth=0) -> list[str]:
    lines = []
    t = node.get("type")
    start = (node.get("attrs") or {}).get("start") or 1
    for i, li in enumerate(node.get("content") or []):
        if not isinstance(li, dict):
            continue
        if t == "orderedList":
            mark = f"{start + i}."
        elif t == "taskList":
            mark = "[x]" if (li.get("attrs") or {}).get("checked") else "[ ]"
        else:
            mark = "-"
        first = True
        for b in li.get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") in ("bulletList", "orderedList", "taskList"):
                lines += _list_lines(b, depth + 1)
            else:
                txt = _plain(b).strip()
                if txt:
                    lines.append("  " * depth + (f"{mark} " if first else "  ") + txt)
                    first = False
    return lines


def _table_lines(node) -> list[str]:
    rows = []
    for r in node.get("content") or []:
        rows.append([_plain(c).strip() for c in (r.get("content") or []) if isinstance(c, dict)])
    if not rows:
        return []
    first = (node.get("content") or [{}])[0]
    has_head = all((c or {}).get("type") == "tableHeader" for c in first.get("content") or []) and len(rows) > 1
    if not has_head:
        return [" | ".join(r) for r in rows]
    head, out = rows[0], []
    for r in rows[1:]:
        parts = [f"{head[i]}: {v}" if i < len(head) and head[i] else v for i, v in enumerate(r) if v]
        out.append(" / ".join(parts))
    return out


def _split(lines: list[str], limit=MAX_CHUNK, prefix: str = "") -> list[str]:
    out, cur = [], ""
    for ln in lines:
        if cur and len(cur) + len(ln) + 1 > limit:
            out.append(cur)
            cur = prefix + ln if prefix else ln
        else:
            cur = f"{cur}\n{ln}" if cur else (prefix + ln if prefix else ln)
    if cur:
        out.append(cur)
    return out


def doc_chunks(doc) -> list[dict]:
    """최상위 블록 단위 근거 문단. 제목 경로(heading)와 앵커(렌더링한 제목 id h-N)를 붙인다."""
    out: list[dict] = []
    heading_no = 0
    path: dict[int, str] = {}
    anchor = None

    def head_path():
        return " › ".join(path[k] for k in sorted(path) if path[k])

    pending_lead = None  # 목록·표 바로 앞의 짧은 안내 문장은 함께 묶는다
    for b in (doc or {}).get("content") or []:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "heading":
            heading_no += 1
            lv = (b.get("attrs") or {}).get("level") or 2
            path = {k: v for k, v in path.items() if k < lv}
            path[lv] = _plain(b).strip()
            anchor = f"h-{heading_no}"
            pending_lead = None
            continue
        inner_headings = _count_headings(b)
        texts: list[str] = []
        kind = t
        if t == "paragraph":
            s = _plain(b).strip()
            if s:
                texts = [s]
        elif t in ("bulletList", "orderedList", "taskList"):
            texts = _split(_list_lines(b))
            kind = "list"
        elif t == "table":
            texts = _split(_table_lines(b))
        elif t == "callout":
            typ = (b.get("attrs") or {}).get("type")
            label = CALLOUT_LABEL.get(typ, "참고")
            body = []
            for c in b.get("content") or []:
                if isinstance(c, dict) and c.get("type") in ("bulletList", "orderedList", "taskList"):
                    body += _list_lines(c)
                else:
                    s = _plain(c).strip()
                    if s:
                        body.append(s)
            texts = _split(body, prefix=f"[{label}] ") if body else []
            if texts and not texts[0].startswith(f"[{label}]"):
                texts[0] = f"[{label}] " + texts[0]
        elif t in ("blockquote", "codeBlock"):
            s = "\n".join(x for x in (_plain(c).strip() for c in (b.get("content") or [])) if x) if t == "blockquote" else _plain(b).strip()
            if s:
                texts = _split(s.split("\n"))
        heading_no += inner_headings
        if not texts:
            continue
        if kind in ("list", "table") and pending_lead and pending_lead["anchor"] == anchor:
            out.remove(pending_lead)
            texts[0] = pending_lead["text"] + "\n" + texts[0]
        for s in texts:
            out.append({"heading": head_path(), "anchor": anchor, "kind": kind, "text": s[:MAX_CHUNK * 2]})
        pending_lead = out[-1] if kind == "paragraph" and len(texts[0]) <= 60 else None
    for i, c in enumerate(out):
        c["ord"] = i
    return out


# ------------------------------------------------------------------ 한국어 토큰(글자 2개씩 + 영문·숫자 낱말)
JOSA = ("으로서", "으로써", "에서는", "에게서", "이라면", "이라도", "까지는", "부터는", "으로", "에서", "에게", "한테", "까지", "부터",
        "이나", "이란", "라면", "이면", "에는", "에도", "와는", "과는", "보다", "처럼", "마다", "은", "는", "이", "가", "을", "를",
        "에", "의", "로", "와", "과", "도", "만", "요")
QUESTION_STOP = {"경우", "경우는", "경우에", "무엇", "무엇인가요", "뭐", "뭔가요", "어떻게", "어떤", "언제", "어디", "어디서", "누가", "누구",
                 "왜", "알려줘", "알려주세요", "알려", "주세요", "하나요", "인가요", "있나요", "되나요", "해야", "하는", "하면", "되는",
                 "방법", "방법은", "절차는", "대해", "대한", "관련", "궁금", "궁금합니다", "있어", "있는", "필요한가요", "할", "수", "때",
                 "시", "및", "등", "또는", "그리고", "좀", "the", "a", "an", "is"}

# 업무 용어 동의어(검색어 확장용, 작은 기본 사전)
SYNONYMS = [
    {"증빙", "서류", "증명", "증명원", "증명서"},
    {"대출", "여신"},
    {"연차", "연가", "휴가"},
    {"소득", "급여", "근로소득", "원천징수"},
    {"결재", "승인", "전결"},
    {"퇴사", "퇴직"},
    {"전보", "발령", "인사발령"},
    {"계좌", "통장"},
    {"개인정보", "유출"},
    {"법인카드", "카드"},
]
_SYN = {}
for g in SYNONYMS:
    for w in g:
        _SYN[w] = g


def _strip_josa(w: str) -> str:
    for j in JOSA:
        if len(w) > len(j) + 1 and w.endswith(j):
            return w[: -len(j)]
    return w


def words(s: str) -> list[str]:
    return re.findall(r"[0-9a-z]+|[가-힣]+", (s or "").lower())


def tokens(s: str) -> list[str]:
    out = []
    for w in words(s):
        if re.match(r"[가-힣]", w):
            if len(w) == 1:
                out.append(w)
            else:
                out += [w[i:i + 2] for i in range(len(w) - 1)]
        elif len(w) > 1 or w.isdigit():
            out.append(w)
    return out


def query_terms(q: str) -> tuple[list[str], list[str]]:
    """질문 → (핵심 낱말, 검색 토큰). 조사·의문사를 빼고 동의어를 더한다."""
    keys: list[str] = []
    for w in words(q):
        if w in QUESTION_STOP:
            continue
        w2 = _strip_josa(w) if re.match(r"[가-힣]", w) else w
        if w2 in QUESTION_STOP or (len(w2) < 2 and not w2.isdigit()):
            continue
        if w2 not in keys:
            keys.append(w2)
    expanded = list(keys)
    for k in keys:
        for s in _SYN.get(k, ()):
            if s not in expanded:
                expanded.append(s)
    toks = []
    for k in expanded:
        for t in tokens(k):
            if t not in toks:
                toks.append(t)
    return keys, toks


def bm25(query_tokens: list[str], docs: list[list[str]], k1=1.2, b=0.75) -> list[float]:
    n = len(docs)
    if not n or not query_tokens:
        return [0.0] * n
    avg = sum(len(d) for d in docs) / n or 1
    df = Counter()
    for d in docs:
        for t in set(d):
            df[t] += 1
    scores = []
    for d in docs:
        tf = Counter(d)
        s = 0.0
        for t in query_tokens:
            if not df[t] or not tf[t]:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * len(d) / avg))
        scores.append(s)
    return scores
