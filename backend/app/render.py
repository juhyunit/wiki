"""편집기 JSON → 표시용 HTML·검색용 평문.

기획서 6.2/9.3: 본문은 JSON이 원본이고, HTML·평문은 서버가 만든다.
허용 노드·허용 마크만 렌더링하므로 클라이언트가 보낸 HTML이 그대로 저장되는 일은 없다.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field

ALLOWED_CALLOUTS = {"warning": "주의", "danger": "중요", "info": "참고"}
FILE_URL_RE = re.compile(r"^/api/files/\d+$")

# 글자 서식(편집기 textStyle 마크): 허용 목록 밖 값은 버린다. frontend/src/editor/textStyle.ts와 같게 유지
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FONT_FAMILIES = {
    "Malgun Gothic, Apple SD Gothic Neo, sans-serif",
    "Dotum, Apple SD Gothic Neo, sans-serif",
    "Gulim, sans-serif",
    "Batang, AppleMyungjo, serif",
    "Gungsuh, serif",
    "Consolas, D2Coding, monospace",
}
FONT_SIZES = {"12px", "13px", "14px", "15px", "16px", "18px", "20px", "24px", "28px", "32px"}


def text_style_css(attrs) -> str:
    if not isinstance(attrs, dict):
        return ""
    out = []
    c = attrs.get("color")
    if isinstance(c, str) and COLOR_RE.match(c):
        out.append(f"color:{c.lower()}")
    f = attrs.get("fontFamily")
    if isinstance(f, str) and f in FONT_FAMILIES:
        out.append(f"font-family:{f}")
    s = attrs.get("fontSize")
    if isinstance(s, str) and s in FONT_SIZES:
        out.append(f"font-size:{s}")
    return ";".join(out)


def esc(s: str) -> str:
    return html.escape(s or "", quote=True)


def safe_href(href: str | None) -> str | None:
    if not href or not isinstance(href, str):
        return None
    h = href.strip()
    low = h.lower()
    if low.startswith(("http://", "https://", "mailto:")) or FILE_URL_RE.match(h) or h.startswith("#"):
        return h
    return None


def safe_src(src: str | None) -> str | None:
    if not src or not isinstance(src, str):
        return None
    s = src.strip()
    if FILE_URL_RE.match(s):
        return s
    # 데모·가져오기 호환: 작은 data URI 이미지만 허용
    if s.startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,")):
        return s
    return None


@dataclass
class RenderState:
    heading_no: int = 0
    toc: list = field(default_factory=list)


def _marks(text: str, marks: list | None) -> str:
    out = esc(text)
    link = None
    for m in marks or []:
        t = m.get("type") if isinstance(m, dict) else None
        if t == "bold":
            out = f"<strong>{out}</strong>"
        elif t == "italic":
            out = f"<em>{out}</em>"
        elif t == "underline":
            out = f"<u>{out}</u>"
        elif t == "strike":
            out = f"<s>{out}</s>"
        elif t == "code":
            out = f"<code>{out}</code>"
        elif t == "textStyle":
            css = text_style_css(m.get("attrs"))
            if css:
                out = f'<span style="{esc(css)}">{out}</span>'
        elif t == "link":
            link = safe_href((m.get("attrs") or {}).get("href"))
    if link:
        is_file = link.startswith("/api/files/")
        cls = ' class="file-link"' if is_file else (' class="manual-link"' if link.startswith("#/m/") else "")
        target = "" if is_file or link.startswith("#") else ' target="_blank" rel="noopener noreferrer"'
        out = f'<a href="{esc(link)}"{cls}{target}>{out}</a>'
    return out


def _children(node: dict, st: RenderState) -> str:
    return "".join(render_node(c, st) for c in (node.get("content") or []) if isinstance(c, dict))


def _plain(node: dict) -> str:
    if node.get("type") == "text":
        return node.get("text") or ""
    if node.get("type") == "hardBreak":
        return " "
    return "".join(_plain(c) for c in (node.get("content") or []) if isinstance(c, dict))


def _int(v, default=None, lo=None, hi=None):
    try:
        i = int(v)
    except (TypeError, ValueError):
        return default
    if lo is not None and i < lo:
        return default
    if hi is not None and i > hi:
        return default
    return i


def render_node(node: dict, st: RenderState) -> str:
    t = node.get("type")
    attrs = node.get("attrs") or {}
    if t == "doc":
        return _children(node, st)
    if t == "text":
        return _marks(node.get("text") or "", node.get("marks"))
    if t == "hardBreak":
        return "<br>"
    if t == "paragraph":
        inner = _children(node, st)
        return f"<p>{inner}</p>" if inner else "<p></p>"
    if t == "heading":
        level = _int(attrs.get("level"), 2, 1, 4)
        st.heading_no += 1
        hid = f"h-{st.heading_no}"
        text = _plain(node).strip()
        if level <= 3 and text:
            st.toc.append({"id": hid, "level": level, "text": text})
        return f'<h{level} id="{hid}">{_children(node, st)}</h{level}>'
    if t == "bulletList":
        return f"<ul>{_children(node, st)}</ul>"
    if t == "orderedList":
        start = _int(attrs.get("start"), 1, 1, 100000)
        s = f' start="{start}"' if start and start != 1 else ""
        return f"<ol{s}>{_children(node, st)}</ol>"
    if t == "listItem":
        return f"<li>{_children(node, st)}</li>"
    if t == "taskList":
        return f'<ul data-type="taskList" class="task-list">{_children(node, st)}</ul>'
    if t == "taskItem":
        checked = bool(attrs.get("checked"))
        box = '<input type="checkbox" disabled checked>' if checked else '<input type="checkbox" disabled>'
        cls = ' class="checked"' if checked else ""
        return f'<li data-type="taskItem" data-checked="{str(checked).lower()}"{cls}><label>{box}</label><div>{_children(node, st)}</div></li>'
    if t == "blockquote":
        return f"<blockquote>{_children(node, st)}</blockquote>"
    if t == "codeBlock":
        return f"<pre><code>{esc(_plain(node))}</code></pre>"
    if t == "horizontalRule":
        return "<hr>"
    if t == "image":
        src = safe_src(attrs.get("src"))
        if not src:
            return ""
        alt = esc(attrs.get("alt") or "")
        w = _int(attrs.get("width"), None, 40, 2000)
        width = f' width="{w}"' if w else ""
        img = f'<img src="{esc(src)}" alt="{alt}"{width}>'
        cap = (attrs.get("title") or "").strip()[:200] if isinstance(attrs.get("title"), str) else ""
        if cap:
            return f'<figure class="img-figure">{img}<figcaption>{esc(cap)}</figcaption></figure>'
        return img
    if t == "table":
        return f'<div class="table-wrap"><table><tbody>{_children(node, st)}</tbody></table></div>'
    if t == "tableRow":
        return f"<tr>{_children(node, st)}</tr>"
    if t in ("tableCell", "tableHeader"):
        tag = "th" if t == "tableHeader" else "td"
        cs = _int(attrs.get("colspan"), 1, 1, 50)
        rs = _int(attrs.get("rowspan"), 1, 1, 200)
        extra = (f' colspan="{cs}"' if cs and cs > 1 else "") + (f' rowspan="{rs}"' if rs and rs > 1 else "")
        cw = attrs.get("colwidth")
        if isinstance(cw, list) and cw and all(isinstance(x, (int, float)) for x in cw):
            extra += f' style="width:{int(sum(cw))}px"'
        return f"<{tag}{extra}>{_children(node, st)}</{tag}>"
    if t == "callout":
        kind = attrs.get("type") if attrs.get("type") in ALLOWED_CALLOUTS else "info"
        label = ALLOWED_CALLOUTS[kind]
        return (f'<div class="callout callout-{kind}" data-callout="{kind}">'
                f'<div class="callout-label">{label}</div><div class="callout-body">{_children(node, st)}</div></div>')
    # 허용 목록 밖 노드는 버리고 자식만 살린다
    return _children(node, st)


def block_text(node: dict) -> str:
    t = node.get("type")
    if t == "image":
        return f"[이미지 {(node.get('attrs') or {}).get('src', '')}]"
    if t in ("table",):
        rows = []
        for r in node.get("content") or []:
            rows.append(" | ".join(_plain(c).strip() for c in (r.get("content") or [])))
        return "\n".join(rows)
    parts = []
    def walk(n):
        tt = n.get("type")
        if tt == "text":
            parts.append(n.get("text") or "")
        elif tt == "hardBreak":
            parts.append(" ")
        else:
            kids = n.get("content") or []
            for k in kids:
                if isinstance(k, dict):
                    walk(k)
            if tt in ("paragraph", "heading", "listItem", "taskItem", "tableCell", "tableHeader", "codeBlock"):
                parts.append("\n")
    walk(node)
    return re.sub(r"\n{2,}", "\n", "".join(parts)).strip()


@dataclass
class Rendered:
    html: str
    text: str
    toc: list


def validate_doc(doc) -> dict:
    if isinstance(doc, str):
        doc = json.loads(doc)
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        raise ValueError("본문 형식이 올바르지 않습니다.")
    if not isinstance(doc.get("content", []), list):
        raise ValueError("본문 형식이 올바르지 않습니다.")
    return doc


def render(doc) -> Rendered:
    doc = validate_doc(doc)
    st = RenderState()
    out = render_node(doc, st)
    text = "\n".join(block_text(b) for b in doc.get("content") or [] if isinstance(b, dict))
    return Rendered(html=out, text=text, toc=st.toc)


def toc_from_html(h: str) -> list:
    toc = []
    for m in re.finditer(r'<h([1-3]) id="(h-\d+)">(.*?)</h\1>', h, re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip()
        if text:
            toc.append({"id": m.group(2), "level": int(m.group(1)), "text": text})
    return toc


LIST_TYPES = {"bulletList", "orderedList", "taskList"}
INLINE = "\x00"


def top_blocks(doc) -> list[dict]:
    """버전 비교용 블록. 목록은 항목 단위로 나눠 한 항목만 바뀌어도 그 항목만 표시한다."""
    doc = validate_doc(doc)
    st = RenderState()
    out = []
    for b in doc.get("content") or []:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t in LIST_TYPES:
            start = _int((b.get("attrs") or {}).get("start"), 1, 1, 100000) or 1
            for i, li in enumerate(b.get("content") or []):
                if not isinstance(li, dict):
                    continue
                inner = render_node(li, st)
                if t == "orderedList":
                    o = f'<ol start="{start + i}">'
                    out.append({"type": "li-ol", "level": None, "html": f"{o}{inner}</ol>", "text": block_text(li),
                                "inline": f"{o}<li><p>{INLINE}</p></li></ol>"})
                elif t == "taskList":
                    chk = " checked" if (li.get("attrs") or {}).get("checked") else ""
                    out.append({"type": "li-task", "level": None, "text": block_text(li),
                                "html": f'<ul data-type="taskList" class="task-list">{inner}</ul>',
                                "inline": f'<ul data-type="taskList" class="task-list"><li data-type="taskItem"><label><input type="checkbox" disabled{chk}></label><div><p>{INLINE}</p></div></li></ul>'})
                else:
                    out.append({"type": "li-ul", "level": None, "html": f"<ul>{inner}</ul>", "text": block_text(li),
                                "inline": f"<ul><li><p>{INLINE}</p></li></ul>"})
            continue
        level = (b.get("attrs") or {}).get("level")
        inline = None
        if t == "paragraph":
            inline = f"<p>{INLINE}</p>"
        elif t == "heading":
            lv = _int(level, 2, 1, 4)
            inline = f"<h{lv}>{INLINE}</h{lv}>"
        out.append({"type": t, "level": level, "html": render_node(b, st), "text": block_text(b), "inline": inline})
    return out
