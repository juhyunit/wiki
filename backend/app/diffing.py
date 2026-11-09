"""버전 비교(기획서 7.2·8.1): 블록 단위로 맞추고, 바뀐 문단은 단어 단위로 표시한다.
추가는 초록, 삭제는 빨강 취소선."""
from __future__ import annotations

import html
import re
from difflib import SequenceMatcher

from .render import INLINE, top_blocks

TEXT_BLOCKS = {"paragraph", "heading", "li-ul", "li-ol", "li-task"}


def _tokens(s: str) -> list[str]:
    return re.findall(r"\s+|[^\s]+", s)


def inline_diff(a: str, b: str) -> str:
    ta, tb = _tokens(a), _tokens(b)
    sm = SequenceMatcher(None, ta, tb, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.append(html.escape("".join(ta[i1:i2])))
        if tag in ("delete", "replace"):
            out.append(f"<del>{html.escape(''.join(ta[i1:i2]))}</del>")
        if tag in ("insert", "replace"):
            out.append(f"<ins>{html.escape(''.join(tb[j1:j2]))}</ins>")
    return "".join(out)


def _wrap(block: dict, cls: str) -> str:
    return f'<div class="diff-block {cls}">{block["html"]}</div>'


def diff_docs(doc_a, doc_b) -> dict:
    a, b = top_blocks(doc_a), top_blocks(doc_b)
    key = lambda x: f'{x["type"]}|{x.get("level")}|{x["text"]}'
    sm = SequenceMatcher(None, [key(x) for x in a], [key(x) for x in b], autojunk=False)
    out = []
    added = removed = changed = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(_wrap(x, "diff-eq") for x in b[j1:j2])
            continue
        if tag == "delete":
            removed += i2 - i1
            out.extend(_wrap(x, "diff-del") for x in a[i1:i2])
            continue
        if tag == "insert":
            added += j2 - j1
            out.extend(_wrap(x, "diff-ins") for x in b[j1:j2])
            continue
        # replace: 1:1로 짝지어지는 문단·제목은 단어 단위로
        xs, ys = a[i1:i2], b[j1:j2]
        n = min(len(xs), len(ys))
        for k in range(n):
            x, y = xs[k], ys[k]
            ratio = SequenceMatcher(None, x["text"], y["text"], autojunk=False).ratio()
            if x["type"] == y["type"] and x["type"] in TEXT_BLOCKS and x.get("level") == y.get("level") and ratio > 0.3 and y.get("inline"):
                changed += 1
                out.append(f'<div class="diff-block diff-mod">{y["inline"].replace(INLINE, inline_diff(x["text"], y["text"]))}</div>')
            else:
                removed += 1
                added += 1
                out.append(_wrap(x, "diff-del"))
                out.append(_wrap(y, "diff-ins"))
        for x in xs[n:]:
            removed += 1
            out.append(_wrap(x, "diff-del"))
        for y in ys[n:]:
            added += 1
            out.append(_wrap(y, "diff-ins"))
    return {"html": "".join(out), "stats": {"added": added, "removed": removed, "changed": changed}}
