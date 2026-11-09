"""매뉴얼 내보내기: Markdown · HTML · DOCX · PDF.

- 본문은 편집기 JSON(원본)에서 만든다. HTML은 render.py(허용 목록 렌더러)를 그대로 쓴다.
- DOCX는 외부 패키지 없이 OOXML을 직접 쓴다(Word·한컴오피스·LibreOffice에서 열림).
- PDF는 reportlab(BSD)으로 만들고, 한글 글꼴은 PC에 설치된 글꼴(맑은 고딕 등)을 넣는다.
- frontend/src/lib/exporters.ts(데모 어댑터)와 같은 구성을 유지한다.
"""
from __future__ import annotations

import base64
import html as _html
import io
import json
import os
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime

from .chunks import internal_target
from .render import ALLOWED_CALLOUTS, FONT_FAMILIES, FONT_SIZES, COLOR_RE, render

FILE_RE = re.compile(r"^/api/files/(\d+)$")
WORD_FONT = {
    "Malgun Gothic, Apple SD Gothic Neo, sans-serif": "맑은 고딕",
    "Dotum, Apple SD Gothic Neo, sans-serif": "돋움",
    "Gulim, sans-serif": "굴림",
    "Batang, AppleMyungjo, serif": "바탕",
    "Gungsuh, serif": "궁서",
    "Consolas, D2Coding, monospace": "Consolas",
}
CALLOUT_COLORS = {  # (바탕, 선, 글자) — styles.css 토큰과 같은 계열
    "warning": ("FCF7E8", "8F6A12", "8F6A12"),
    "danger": ("FCF1E8", "D97736", "B4561C"),
    "info": ("E9EFF8", "263B63", "263B63"),
}


@dataclass
class Meta:
    title: str
    manual_no: str
    department_name: str
    category_name: str | None
    edition: int
    version_no: int | None
    view: str  # published | work
    published_at: str | None
    published_by: str | None
    owner_name: str | None
    review_cycle_months: int
    next_review_date: str | None
    visibility: str
    extra_departments: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    exported_by: str = ""
    exported_at: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M"))
    base_url: str = ""  # 내부 링크·첨부를 절대 주소로 바꿀 때(예: http://192.168.0.5:8000/)

    @property
    def edition_label(self) -> str:
        if self.view == "work":
            return f"작업본 v{self.version_no}(게시 전)" if self.version_no else "저장 전 초안"
        return f"제{self.edition}판 (v{self.version_no})" if self.edition else "미게시"

    @property
    def source_label(self) -> str:
        return "작업본(게시 전, 공식 문서 아님)" if self.view == "work" else "공식본"

    @property
    def visibility_label(self) -> str:
        if self.visibility == "company":
            return "전사 공개"
        return "부서 한정" + (f" (+{', '.join(self.extra_departments)})" if self.extra_departments else "")

    def rows(self) -> list[tuple[str, str, bool]]:
        """문서 관리 정보 표: (항목, 값, 강조)."""
        dept = self.department_name + (f" · {self.category_name}" if self.category_name else "")
        pub = (self.published_at or "")[:10]
        if pub and self.published_by:
            pub += f" ({self.published_by})"
        return [
            ("문서 번호", self.manual_no, False), ("현재 판", self.edition_label, False),
            ("문서 책임자", self.owner_name or "-", True), ("다음 검토일", self.next_review_date or "-", True),
            ("담당 부서", dept, False), ("최종 게시", pub or "-", False),
            ("검토 주기", f"{self.review_cycle_months}개월", False), ("열람 범위", self.visibility_label, False),
        ]

    def filename(self, ext: str) -> str:
        safe = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", self.title).strip()[:80] or "매뉴얼"
        tail = f"제{self.edition}판" if self.view == "published" and self.edition else (f"작업본 v{self.version_no}" if self.version_no else "초안")
        return f"{self.manual_no} {safe} ({tail}).{ext}"


def abs_href(href: str, meta: Meta) -> str | None:
    """본문 링크를 내보낸 파일에서도 열리는 주소로. 내부 링크·첨부는 서버 주소를 붙이고, 서버 주소를 모르면 링크를 뺀다."""
    if not href:
        return None
    if internal_target(href) is not None or FILE_RE.match(href):
        if not meta.base_url:
            return None
        base = meta.base_url.rstrip("/") + "/"
        return base + href.lstrip("/") if FILE_RE.match(href) else base + href
    if re.match(r"^(https?:|mailto:)", href, re.I):
        return href
    return None


def _link_of(marks) -> str | None:
    for m in marks or []:
        if isinstance(m, dict) and m.get("type") == "link":
            return (m.get("attrs") or {}).get("href")
    return None


def _has(marks, t) -> bool:
    return any(isinstance(m, dict) and m.get("type") == t for m in marks or [])


def _style(marks) -> dict:
    for m in marks or []:
        if isinstance(m, dict) and m.get("type") == "textStyle":
            a = m.get("attrs") or {}
            out = {}
            if isinstance(a.get("color"), str) and COLOR_RE.match(a["color"]):
                out["color"] = a["color"].lower()
            if a.get("fontFamily") in FONT_FAMILIES:
                out["font"] = a["fontFamily"]
            if a.get("fontSize") in FONT_SIZES:
                out["size"] = int(a["fontSize"][:-2])
            return out
    return {}


def plain(n) -> str:
    if not isinstance(n, dict):
        return ""
    if n.get("type") == "text":
        return n.get("text") or ""
    if n.get("type") == "hardBreak":
        return "\n"
    return "".join(plain(c) for c in n.get("content") or [])


def table_grid(node) -> tuple[int, int, list[dict]]:
    """표를 칸 격자로 편다: 병합된 칸(colspan·rowspan)의 위치를 계산한다."""
    occupied: set[tuple[int, int]] = set()
    cells = []
    rows = [r for r in node.get("content") or [] if isinstance(r, dict)]
    ncols = 0
    for ri, r in enumerate(rows):
        c = 0
        for cell in r.get("content") or []:
            if not isinstance(cell, dict):
                continue
            while (ri, c) in occupied:
                c += 1
            a = cell.get("attrs") or {}
            cs = max(1, min(50, int(a.get("colspan") or 1)))
            rs = max(1, min(len(rows) - ri, int(a.get("rowspan") or 1)))
            for dr in range(rs):
                for dc in range(cs):
                    occupied.add((ri + dr, c + dc))
            cw = a.get("colwidth") if isinstance(a.get("colwidth"), list) else None
            cells.append({"r": ri, "c": c, "rs": rs, "cs": cs, "node": cell, "header": cell.get("type") == "tableHeader", "colwidth": cw})
            c += cs
        ncols = max(ncols, c, max((cc for (rr, cc) in occupied if rr == ri), default=-1) + 1)
    return len(rows), ncols, cells


def col_widths(nrows: int, ncols: int, cells: list[dict], total: float) -> list[float]:
    w = [None] * ncols
    for ce in cells:
        cw = ce["colwidth"]
        if cw and len(cw) == ce["cs"] and all(isinstance(x, (int, float)) and x for x in cw):
            for k, x in enumerate(cw):
                if w[ce["c"] + k] is None:
                    w[ce["c"] + k] = float(x)
    known = [x for x in w if x]
    avg = (sum(known) / len(known)) if known else 1.0
    w = [x or avg for x in w]
    s = sum(w) or 1
    return [total * x / s for x in w]


# ======================================================================== Markdown
MD_CALLOUT = {"warning": "WARNING", "danger": "IMPORTANT", "info": "NOTE"}


def _md_esc(s: str) -> str:
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", s).replace("~~", "\\~\\~")


def md_inline(nodes, meta: Meta, in_table=False) -> str:
    out = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t == "hardBreak":
            out.append("<br>" if in_table else "  \n")
            continue
        if t != "text":
            out.append(md_inline(n.get("content"), meta, in_table))
            continue
        text = n.get("text") or ""
        marks = n.get("marks") or []
        if _has(marks, "code"):
            tick = "``" if "`" in text else "`"
            s = f"{tick}{text}{tick}"
        else:
            s = _md_esc(text)
            lead = len(s) - len(s.lstrip())
            trail = len(s) - len(s.rstrip())
            core = s.strip()
            if core:
                if _has(marks, "strike"):
                    core = f"~~{core}~~"
                if _has(marks, "italic"):
                    core = f"*{core}*"
                if _has(marks, "bold"):
                    core = f"**{core}**"
            s = s[:lead] + core + (s[len(s) - trail:] if trail else "")
        href = abs_href(_link_of(marks), meta)
        if href:
            s = f"[{s}]({href.replace(' ', '%20').replace(')', '%29')})"
        out.append(s)
    return "".join(out)


def _md_block_lines(b, meta: Meta) -> list[str]:
    t = b.get("type")
    a = b.get("attrs") or {}
    if t == "paragraph":
        s = md_inline(b.get("content"), meta)
        if re.match(r"^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>)", s):
            s = "\\" + s
        return s.split("\n") if s else []
    if t == "heading":
        lv = max(1, min(4, int(a.get("level") or 2)))
        return ["#" * lv + " " + md_inline(b.get("content"), meta).replace("\n", " ")]
    if t in ("bulletList", "orderedList", "taskList"):
        return _md_list(b, meta)
    if t == "table":
        return _md_table(b, meta)
    if t == "callout":
        kind = a.get("type") if a.get("type") in MD_CALLOUT else "info"
        inner = _md_blocks(b.get("content"), meta)
        return [f"> [!{MD_CALLOUT[kind]}]"] + [("> " + x).rstrip() for x in inner]
    if t == "blockquote":
        return [("> " + x).rstrip() for x in _md_blocks(b.get("content"), meta)]
    if t == "codeBlock":
        code = plain(b)
        fence = "````" if "```" in code else "```"
        return [fence] + code.split("\n") + [fence]
    if t == "horizontalRule":
        return ["---"]
    if t == "image":
        src = a.get("src") or ""
        url = abs_href(src, meta) if FILE_RE.match(src) else (src if src.startswith("data:image/") else None)
        if not url:
            return []
        cap = (a.get("title") or "").strip()
        alt = _md_esc((a.get("alt") or cap or "그림").strip())
        return [f'![{alt}]({url}' + (f' "{cap.replace(chr(34), "")}"' if cap else "") + ")"]
    kids = b.get("content") or []
    return _md_blocks(kids, meta) if kids else []


def _md_blocks(blocks, meta: Meta) -> list[str]:
    out: list[str] = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        lines = _md_block_lines(b, meta)
        if not lines:
            continue
        if out:
            out.append("")
        out += lines
    return out


def _md_list(node, meta: Meta) -> list[str]:
    t = node.get("type")
    start = int((node.get("attrs") or {}).get("start") or 1)
    out = []
    for i, li in enumerate(node.get("content") or []):
        if not isinstance(li, dict):
            continue
        if t == "orderedList":
            mark = f"{start + i}. "
        elif t == "taskList":
            mark = "- [x] " if (li.get("attrs") or {}).get("checked") else "- [ ] "
        else:
            mark = "- "
        pad = " " * (len(mark) if t != "taskList" else 2)
        body = []
        for b in li.get("content") or []:
            if not isinstance(b, dict):
                continue
            lines = _md_block_lines(b, meta)
            if body and b.get("type") not in ("bulletList", "orderedList", "taskList") and lines:
                body.append("")
            body += lines
        if not body:
            body = [""]
        out.append(mark + body[0])
        out += [(pad + x) if x else "" for x in body[1:]]
    return out


def _md_table(node, meta: Meta) -> list[str]:
    nrows, ncols, cells = table_grid(node)
    if not nrows or not ncols:
        return []
    grid = [[""] * ncols for _ in range(nrows)]
    for ce in cells:
        parts = [md_inline(p.get("content"), meta, True) if p.get("type") in ("paragraph", "heading") else plain(p).replace("\n", " ")
                 for p in ce["node"].get("content") or [] if isinstance(p, dict)]
        grid[ce["r"]][ce["c"]] = "<br>".join(x for x in parts if x).replace("\n", " ")
    lines = ["| " + " | ".join(grid[0]) + " |", "|" + "|".join([" --- "] * ncols) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in grid[1:]]
    return lines


def to_markdown(doc, meta: Meta) -> str:
    fm = {"title": meta.title, "manual_no": meta.manual_no, "department": meta.department_name, "category": meta.category_name or "",
          "edition": meta.edition_label, "published_at": (meta.published_at or "")[:10], "owner": meta.owner_name or "",
          "review_cycle_months": meta.review_cycle_months, "next_review_date": meta.next_review_date or "",
          "visibility": meta.visibility_label, "tags": meta.tags, "source": f"WorkWiki {meta.source_label}",
          "exported_at": meta.exported_at, "exported_by": meta.exported_by}
    head = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items()] + ["---", "", f"# {meta.title}", ""]
    body = _md_blocks((doc or {}).get("content"), meta)
    return "\n".join(head + body).rstrip() + "\n"


# ======================================================================== HTML(파일 하나로 열리는 문서)
EXPORT_CSS = """
:root{--primary:#263b63;--primary-light:#e9eff8;--primary-line:#c8d4e8;--accent:#d97736;--accent-text:#b4561c;--accent-light:#fcf1e8;
--accent-line:#f2d4bd;--bg:#f7f8fa;--line:#e1e5eb;--text:#202b3c;--muted:#758196;--amber:#8f6a12;--amber-bg:#fcf7e8;--amber-line:#eedfb5}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#2b3648;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,'Apple SD Gothic Neo','Malgun Gothic','맑은 고딕',Arial,sans-serif;font-size:15px;line-height:1.7;word-break:keep-all;overflow-wrap:anywhere}
.doc{max-width:820px;margin:0 auto;padding:40px 32px 64px}
.doc-title{font-size:30px;line-height:1.3;color:var(--primary);margin:0 0 14px}
.info{border:1px solid var(--line);border-radius:4px;margin:0 0 28px}
.info-head{display:flex;justify-content:space-between;gap:12px;padding:9px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.info-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 18px;padding:12px 14px;margin:0}
.info-grid div{min-width:0}.info-grid dt{font-size:12px;color:var(--muted)}.info-grid dd{margin:2px 0 0;font-size:14px;color:var(--text)}
.info-grid dd.em{font-weight:700}
.tags{font-size:13px;color:var(--muted);margin:-16px 0 24px}
.prose h1{font-size:25px}.prose h2{font-size:21px}.prose h3{font-size:18px}.prose h4{font-size:16px}
.prose h1,.prose h2,.prose h3,.prose h4{color:var(--text);line-height:1.4;margin:1.5em 0 .4em}
.prose p{margin:.4em 0}.prose ul,.prose ol{padding-left:1.5em;margin:.4em 0}.prose li>p{margin:.08em 0}
.prose a{color:var(--primary)}.prose strong{color:var(--text)}
.prose table{border-collapse:collapse;width:100%;font-size:14px;margin:1em 0}
.prose th,.prose td{border:1px solid #cbd2dc;padding:7px 10px;vertical-align:top;text-align:left}
.prose th{background:var(--bg)}.prose td>p,.prose th>p{margin:0}
.prose img{max-width:100%;height:auto}.prose figure{margin:1em 0}.prose figcaption{font-size:12.5px;color:var(--muted)}
.prose blockquote{margin:1em 0;padding:2px 0 2px 14px;border-left:3px solid var(--primary-line);color:#3b475a}
.prose pre{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.prose code{background:var(--bg);padding:0 4px;border-radius:3px;font-size:.9em}
.prose hr{border:none;border-top:1px solid var(--line);margin:2em 0}
.prose ul[data-type=taskList]{list-style:none;padding-left:0}.prose ul[data-type=taskList] li{display:flex;gap:8px}
.prose ul[data-type=taskList] li>label{flex-shrink:0}.prose ul[data-type=taskList] li>div{flex:1}
.callout{margin:1em 0;padding:10px 14px;border:1px solid var(--c-line);border-left:3px solid var(--c-accent);border-radius:4px;background:var(--c-bg)}
.callout-label{font-weight:700;font-size:13px;color:var(--c-accent);margin-bottom:2px}
.callout-body>:first-child{margin-top:0}.callout-body>:last-child{margin-bottom:0}
.callout-warning{--c-accent:var(--amber);--c-bg:var(--amber-bg);--c-line:var(--amber-line)}
.callout-danger{--c-accent:var(--accent-text);--c-bg:var(--accent-light);--c-line:var(--accent-line)}
.callout-info{--c-accent:var(--primary);--c-bg:var(--primary-light);--c-line:var(--primary-line)}
.foot{margin-top:44px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
@media (max-width:640px){.info-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.doc{padding:24px 18px}}
@media print{.doc{padding:0;max-width:none}@page{size:A4;margin:16mm 15mm}}
"""


def to_html(doc, meta: Meta, image_data) -> str:
    """image_data(첨부 id) → data URI 또는 None. 그림은 파일 안에 넣어 따로 열어도 보이게 한다."""
    body = render(doc).html

    def img(m):
        aid = int(m.group(1))
        uri = image_data(aid)
        return f'src="{uri}"' if uri else 'src="" data-missing="1"'

    body = re.sub(r'src="/api/files/(\d+)"', img, body)

    def href(m):
        h = _html.unescape(m.group(1))
        target = abs_href(h, meta)
        return f'href="{_html.escape(target, quote=True)}"' if target else 'href="#"'

    body = re.sub(r'href="(#/m/\d+[^"]*|/api/files/\d+)"', href, body)
    esc = lambda s: _html.escape(s or "", quote=True)  # noqa: E731
    grid = "".join(f'<div><dt>{esc(k)}</dt><dd{" class=em" if em else ""}>{esc(v)}</dd></div>' for k, v, em in meta.rows())
    tags = f'<div class="tags">{" ".join("#" + esc(t) for t in meta.tags)}</div>' if meta.tags else ""
    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="WorkWiki"><title>{esc(meta.title)} ({esc(meta.manual_no)})</title><style>{EXPORT_CSS}</style></head>
<body><article class="doc">
<h1 class="doc-title">{esc(meta.title)}</h1>
<section class="info"><div class="info-head"><span>문서 관리 정보</span><span>{esc(meta.source_label)}</span></div><dl class="info-grid">{grid}</dl></section>
{tags}<div class="prose">{body}</div>
<footer class="foot">WorkWiki에서 내보냄 · {esc(meta.exported_at)} · {esc(meta.exported_by)} · {esc(meta.manual_no)} {esc(meta.edition_label)}.
이 파일은 내보낸 시점의 사본입니다. 최신 공식본은 WorkWiki에서 확인하세요.</footer>
</article></body></html>
"""


# ======================================================================== DOCX
W_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
TEXT_W = 9638  # A4(11906) - 좌우 여백 1134*2 (twip)


def x(s) -> str:
    return _html.escape(_BAD_XML.sub("", str(s or "")), quote=True)


class Docx:
    def __init__(self, meta: Meta, image_bytes):
        self.meta = meta
        self.image_bytes = image_bytes  # 첨부 id → (bytes, mime) | None
        self.rels: list[tuple[str, str, str, bool]] = []  # id, type, target, external
        self.media: list[tuple[str, bytes]] = []
        self.nums: list[int] = []  # 번호 목록마다 시작 번호
        self.pic = 0
        self.links: dict[str, str] = {}

    # ---------------- 관계
    def _rel(self, typ, target, external=False) -> str:
        rid = f"rId{len(self.rels) + 10}"
        self.rels.append((rid, typ, target, external))
        return rid

    def link_rid(self, href: str) -> str:
        if href not in self.links:
            self.links[href] = self._rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", href, True)
        return self.links[href]

    # ---------------- 글자
    def runs(self, nodes, base: dict | None = None) -> str:
        out = []
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            t = n.get("type")
            if t == "hardBreak":
                out.append("<w:r><w:br/></w:r>")
                continue
            if t != "text":
                out.append(self.runs(n.get("content"), base))
                continue
            marks = n.get("marks") or []
            st = _style(marks)
            href = abs_href(_link_of(marks), self.meta)
            r = self.run(n.get("text") or "", bold=_has(marks, "bold") or (base or {}).get("bold", False), italic=_has(marks, "italic"),
                         underline=_has(marks, "underline") or bool(href), strike=_has(marks, "strike"), code=_has(marks, "code"),
                         color=(st.get("color") or ("#263b63" if href else None) or (base or {}).get("color")),
                         size=st.get("size") or (base or {}).get("size"), font=WORD_FONT.get(st.get("font")) if st.get("font") else None,
                         style="WWLink" if href else None)
            out.append(f'<w:hyperlink r:id="{self.link_rid(href)}" w:history="1">{r}</w:hyperlink>' if href else r)
        return "".join(out)

    @staticmethod
    def run(text, bold=False, italic=False, underline=False, strike=False, code=False, color=None, size=None, font=None, style=None) -> str:
        pr = []
        if style:
            pr.append(f'<w:rStyle w:val="{style}"/>')
        f = "Consolas" if code else font
        if f:
            pr.append(f'<w:rFonts w:ascii="{x(f)}" w:hAnsi="{x(f)}" w:eastAsia="{x(f)}"/>')
        if bold:
            pr.append("<w:b/><w:bCs/>")
        if italic:
            pr.append("<w:i/><w:iCs/>")
        if strike:
            pr.append("<w:strike/>")
        if color:
            pr.append(f'<w:color w:val="{color.lstrip("#").upper()}"/>')
        if size:
            hp = int(round(size * 1.5))  # px → 반 포인트(1px = 0.75pt)
            pr.append(f'<w:sz w:val="{hp}"/><w:szCs w:val="{hp}"/>')
        if underline:
            pr.append('<w:u w:val="single"/>')
        if code:
            pr.append('<w:shd w:val="clear" w:color="auto" w:fill="EEF1F5"/>')
        rpr = f"<w:rPr>{''.join(pr)}</w:rPr>" if pr else ""
        parts = str(text).split("\n")
        body = "<w:br/>".join(f'<w:t xml:space="preserve">{x(p)}</w:t>' for p in parts)
        return f"<w:r>{rpr}{body}</w:r>"

    @staticmethod
    def para(inner: str, style=None, num=None, ilvl=0, ind=None, hanging=None, keep_next=False, border_left=None,
             border_bottom=False, shade=None, after=None, before=None, jc=None) -> str:
        pr = []
        if style:
            pr.append(f'<w:pStyle w:val="{style}"/>')
        if keep_next:
            pr.append("<w:keepNext/>")
        if num is not None:
            pr.append(f'<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num}"/></w:numPr>')
        if border_left or border_bottom:
            b = ""
            if border_left:
                b += f'<w:left w:val="single" w:sz="12" w:space="8" w:color="{border_left}"/>'
            if border_bottom:
                b += '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="CBD2DC"/>'
            pr.append(f"<w:pBdr>{b}</w:pBdr>")
        if shade:
            pr.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>')
        if after is not None or before is not None:
            pr.append(f'<w:spacing{f" w:before={chr(34)}{before}{chr(34)}" if before is not None else ""}'
                      f'{f" w:after={chr(34)}{after}{chr(34)}" if after is not None else ""}/>')
        if ind is not None:
            pr.append(f'<w:ind w:left="{ind}"' + (f' w:hanging="{hanging}"' if hanging else "") + "/>")
        if jc:
            pr.append(f'<w:jc w:val="{jc}"/>')
        ppr = f"<w:pPr>{''.join(pr)}</w:pPr>" if pr else ""
        return f"<w:p>{ppr}{inner}</w:p>"

    # ---------------- 그림
    def image(self, attrs, max_w_emu=int(TEXT_W * 635)) -> str:
        src = (attrs or {}).get("src") or ""
        m = FILE_RE.match(src)
        got = None
        if m:
            got = self.image_bytes(int(m.group(1)))
        elif src.startswith("data:image/"):
            mm = re.match(r"^data:(image/[a-z]+);base64,(.+)$", src, re.S)
            if mm:
                try:
                    got = (base64.b64decode(mm.group(2)), mm.group(1))
                except Exception:
                    got = None
        if not got:
            return ""
        data, mime = got
        try:
            from PIL import Image as PImage
            im = PImage.open(io.BytesIO(data))
            wpx, hpx = im.size
            if mime not in ("image/png", "image/jpeg"):
                buf = io.BytesIO()
                im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB").save(buf, "PNG")
                data, mime = buf.getvalue(), "image/png"
        except Exception:
            return ""
        ext = "png" if mime == "image/png" else "jpeg"
        self.pic += 1
        name = f"image{self.pic}.{ext}"
        self.media.append((name, data))
        rid = self._rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", f"media/{name}")
        want = attrs.get("width")
        disp_w = float(want) if isinstance(want, (int, float)) and want else float(wpx)
        cx = int(disp_w * 9525)
        if cx > max_w_emu:
            cx = max_w_emu
        cy = int(cx * hpx / max(1, wpx))
        alt = x((attrs.get("alt") or attrs.get("title") or "").strip())
        return (f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:docPr id="{self.pic}" name="그림 {self.pic}" descr="{alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
                f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{self.pic}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
                f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
                f'</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')

    # ---------------- 블록
    def blocks(self, nodes, ctx=None) -> str:
        ctx = ctx or {}
        out = []
        for b in nodes or []:
            if isinstance(b, dict):
                out.append(self.block(b, ctx))
        return "".join(out)

    def block(self, b, ctx) -> str:
        t = b.get("type")
        a = b.get("attrs") or {}
        ind = ctx.get("ind")
        bl = ctx.get("border_left")
        shade = ctx.get("shade")
        if t == "paragraph":
            return self.para(self.runs(b.get("content"), ctx.get("run")), ind=ind, border_left=bl, shade=shade)
        if t == "heading":
            lv = max(1, min(4, int(a.get("level") or 2)))
            return self.para(self.runs(b.get("content")), style=f"Heading{lv}", keep_next=True)
        if t in ("bulletList", "orderedList", "taskList"):
            return self.list_(b, ctx.get("depth", 0), ctx)
        if t == "table":
            return self.table(b) + self.para("", after=60)
        if t == "callout":
            return self.callout(b)
        if t == "blockquote":
            return self.blocks(b.get("content"), {**ctx, "ind": (ind or 0) + 280, "border_left": "C8D4E8", "run": {"color": "#3b475a"}})
        if t == "codeBlock":
            return "".join(self.para(self.run(line, code=True), shade="F7F8FA", after=0, ind=ind) for line in (plain(b) or " ").split("\n"))
        if t == "horizontalRule":
            return self.para("", border_bottom=True)
        if t == "image":
            img = self.image(a)
            if not img:
                return ""
            cap = (a.get("title") or "").strip()
            return self.para(img, after=40 if cap else None, keep_next=bool(cap)) + (self.para(self.run(cap), style="WWCaption") if cap else "")
        return self.blocks(b.get("content"), ctx)

    def list_(self, node, depth, ctx) -> str:
        t = node.get("type")
        num = None
        if t == "orderedList":
            self.nums.append(int((node.get("attrs") or {}).get("start") or 1))
            num = 10 + len(self.nums)
        elif t == "bulletList":
            num = 1
        lv = min(depth, 8)
        out = []
        for li in node.get("content") or []:
            if not isinstance(li, dict):
                continue
            first = True
            for b in li.get("content") or []:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt in ("bulletList", "orderedList", "taskList"):
                    out.append(self.list_(b, depth + 1, ctx))
                    continue
                inner = self.runs(b.get("content")) if bt in ("paragraph", "heading") else self.runs([{"type": "text", "text": plain(b)}])
                left = 400 * (lv + 1) + (ctx.get("ind") or 0)
                if first and t == "taskList":
                    box = "☑ " if (li.get("attrs") or {}).get("checked") else "☐ "
                    out.append(self.para(self.run(box) + inner, ind=left, hanging=300, after=40, shade=ctx.get("shade")))
                elif first:
                    out.append(self.para(inner, num=num, ilvl=lv, after=40, shade=ctx.get("shade")))
                else:
                    out.append(self.para(inner, ind=left, after=40, shade=ctx.get("shade")))
                first = False
        return "".join(out)

    def table(self, node) -> str:
        nrows, ncols, cells = table_grid(node)
        if not nrows or not ncols:
            return ""
        widths = [int(w) for w in col_widths(nrows, ncols, cells, TEXT_W)]
        at = {(c["r"], c["c"]): c for c in cells}
        cover = {}
        for c in cells:
            for dr in range(1, c["rs"]):
                cover[(c["r"] + dr, c["c"])] = c
        header_row = all(c["header"] for c in cells if c["r"] == 0) and nrows > 1
        rows = []
        for r in range(nrows):
            tcs = []
            col = 0
            while col < ncols:
                c = at.get((r, col))
                if c:
                    w = sum(widths[col:col + c["cs"]])
                    pr = f'<w:tcW w:w="{w}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{c["cs"]}"/>' if c["cs"] > 1 else "")
                    pr += '<w:vMerge w:val="restart"/>' if c["rs"] > 1 else ""
                    pr += '<w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/>' if c["header"] else ""
                    inner = self.blocks(c["node"].get("content"), {"run": {"bold": True} if c["header"] else None}) or self.para("")
                    tcs.append(f"<w:tc><w:tcPr>{pr}</w:tcPr>{inner}</w:tc>")
                    col += c["cs"]
                    continue
                c = cover.get((r, col))
                if c:
                    w = sum(widths[col:col + c["cs"]])
                    pr = f'<w:tcW w:w="{w}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{c["cs"]}"/>' if c["cs"] > 1 else "") + "<w:vMerge/>"
                    tcs.append(f"<w:tc><w:tcPr>{pr}</w:tcPr>{self.para('')}</w:tc>")
                    col += c["cs"]
                    continue
                tcs.append(f'<w:tc><w:tcPr><w:tcW w:w="{widths[col]}" w:type="dxa"/></w:tcPr>{self.para("")}</w:tc>')
                col += 1
            trpr = "<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>" if r == 0 and header_row else "<w:trPr><w:cantSplit/></w:trPr>"
            rows.append(f"<w:tr>{trpr}{''.join(tcs)}</w:tr>")
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
        return (f'<w:tbl><w:tblPr><w:tblStyle w:val="WWTable"/><w:tblW w:w="{TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
                f'<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
                f"<w:tblGrid>{grid}</w:tblGrid>{''.join(rows)}</w:tbl>")

    def callout(self, node) -> str:
        kind = (node.get("attrs") or {}).get("type")
        kind = kind if kind in ALLOWED_CALLOUTS else "info"
        bg, line, fg = CALLOUT_COLORS[kind]
        label = self.para(self.run(ALLOWED_CALLOUTS[kind], bold=True, color="#" + fg), after=20)
        inner = label + (self.blocks(node.get("content")) or self.para(""))
        return (f'<w:tbl><w:tblPr><w:tblW w:w="{TEXT_W}" w:type="dxa"/><w:tblBorders>'
                f'<w:top w:val="single" w:sz="4" w:space="0" w:color="{bg}"/><w:left w:val="single" w:sz="24" w:space="0" w:color="{line}"/>'
                f'<w:bottom w:val="single" w:sz="4" w:space="0" w:color="{bg}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="{bg}"/>'
                f'</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="180" w:type="dxa"/>'
                f'<w:bottom w:w="100" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr>'
                f'<w:tblGrid><w:gridCol w:w="{TEXT_W}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="{TEXT_W}" w:type="dxa"/>'
                f'<w:shd w:val="clear" w:color="auto" w:fill="{bg}"/></w:tcPr>{inner}</w:tc></w:tr></w:tbl>' + self.para("", after=60))

    def info_table(self) -> str:
        rows = self.meta.rows()
        wl, wv = 1500, TEXT_W // 2 - 1500
        cell = lambda w, inner, fill=None: (f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>'  # noqa: E731
                                            + (f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>' if fill else "")
                                            + f"</w:tcPr>{inner}</w:tc>")
        trs = []
        for i in range(0, len(rows), 2):
            tcs = ""
            for k, v, em in rows[i:i + 2]:
                tcs += cell(wl, self.para(self.run(k, color="#5a6880", size=12), after=0), "E9EFF8")
                tcs += cell(wv, self.para(self.run(v, bold=em, size=13), after=0))
            trs.append(f"<w:tr><w:trPr><w:cantSplit/></w:trPr>{tcs}</w:tr>")
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in (wl, wv, wl, wv))
        return (f'<w:tbl><w:tblPr><w:tblStyle w:val="WWTable"/><w:tblW w:w="{TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
                f"<w:tblGrid>{grid}</w:tblGrid>{''.join(trs)}</w:tbl>")

    # ---------------- 파일 조립
    def build(self, doc) -> bytes:
        m = self.meta
        head = self.para(self.run(m.title), style="Title")
        head += self.para(self.run(f"문서 관리 정보 · {m.source_label}", color="#758196", size=12), after=60)
        head += self.info_table()
        if m.tags:
            head += self.para(self.run("  ".join("#" + t for t in m.tags), color="#758196", size=12), before=80)
        head += self.para("", border_bottom=True, after=200)
        body = self.blocks((doc or {}).get("content"))
        footer_rid = self._rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml")
        sect = (f'<w:sectPr><w:footerReference w:type="default" r:id="{footer_rid}"/><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1418" w:right="1134" w:bottom="1418" w:left="1134" w:header="709" w:footer="567" w:gutter="0"/></w:sectPr>')
        document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W_NS}><w:body>{head}{body}{sect}</w:body></w:document>'
        foot_text = f"WorkWiki · {m.manual_no} {m.title} · {m.edition_label} · 출력 {m.exported_at} {m.exported_by}"
        footer = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr {W_NS}>'
                  f'<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="{TEXT_W}"/></w:tabs></w:pPr>{self.run(foot_text, color="#758196", size=11)}'
                  f'<w:r><w:rPr><w:color w:val="758196"/><w:sz w:val="16"/></w:rPr><w:tab/></w:r>'
                  f'<w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:color w:val="758196"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>'
                  f'<w:r><w:rPr><w:color w:val="758196"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> / </w:t></w:r>'
                  f'<w:fldSimple w:instr="NUMPAGES"><w:r><w:rPr><w:color w:val="758196"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>')
        rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
                '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>']
        for rid, typ, target, ext in self.rels:
            rels.append(f'<Relationship Id="{rid}" Type="{typ}" Target="{x(target)}"' + (' TargetMode="External"' if ext else "") + "/>")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", CONTENT_TYPES)
            z.writestr("_rels/.rels", ROOT_RELS)
            z.writestr("docProps/core.xml", core_xml(m))
            z.writestr("docProps/app.xml", APP_XML)
            z.writestr("word/document.xml", document)
            z.writestr("word/styles.xml", STYLES_XML)
            z.writestr("word/numbering.xml", numbering_xml(self.nums))
            z.writestr("word/settings.xml", SETTINGS_XML)
            z.writestr("word/footer1.xml", footer)
            z.writestr("word/_rels/document.xml.rels",
                       '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       + "".join(rels) + "</Relationships>")
            for name, data in self.media:
                z.writestr(f"word/media/{name}", data)
        return buf.getvalue()


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"""

APP_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WorkWiki</Application></Properties>"""

SETTINGS_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="800"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"""


def core_xml(m: Meta) -> str:
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{x(m.title)}</dc:title><dc:subject>{x(m.manual_no)} {x(m.edition_label)}</dc:subject><dc:creator>WorkWiki</dc:creator>"
            f"<cp:keywords>{x(', '.join(m.tags))}</cp:keywords><cp:lastModifiedBy>{x(m.exported_by)}</cp:lastModifiedBy>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>')


def _heading_style(n, size, before, color="202B3C"):
    return (f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
            f'<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="100"/><w:outlineLvl w:val="{n - 1}"/></w:pPr>'
            f'<w:rPr><w:b/><w:bCs/><w:color w:val="{color}"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>')


STYLES_XML = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/>'
              '<w:color w:val="2B3648"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:wordWrap w:val="0"/></w:pPr></w:style>'
              '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
              '<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="263B63"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>'
              + _heading_style(1, 34, 360) + _heading_style(2, 30, 320) + _heading_style(3, 26, 260) + _heading_style(4, 23, 220) +
              '<w:style w:type="paragraph" w:styleId="WWCaption"><w:name w:val="WorkWiki Caption"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="758196"/><w:sz w:val="18"/></w:rPr></w:style>'
              '<w:style w:type="character" w:styleId="WWLink"><w:name w:val="WorkWiki Link"/><w:rPr><w:color w:val="263B63"/><w:u w:val="single"/></w:rPr></w:style>'
              '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
              '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
              '<w:style w:type="table" w:styleId="WWTable"><w:name w:val="WorkWiki Table"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr>'
              '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/>'
              '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/>'
              '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/></w:tblBorders>'
              '<w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
              '</w:styles>')


def numbering_xml(starts: list[int]) -> str:
    bullets = ["•", "◦", "▪"]
    def lvls(fmt):
        out = []
        for i in range(9):
            if fmt == "bullet":
                out.append(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{bullets[i % 3]}"/><w:lvlJc w:val="left"/>'
                           f'<w:pPr><w:ind w:left="{400 * (i + 1)}" w:hanging="300"/></w:pPr></w:lvl>')
            else:
                out.append(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%{i + 1}."/><w:lvlJc w:val="left"/>'
                           f'<w:pPr><w:ind w:left="{400 * (i + 1)}" w:hanging="340"/></w:pPr></w:lvl>')
        return "".join(out)
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>{lvls("bullet")}</w:abstractNum>'
           f'<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>{lvls("decimal")}</w:abstractNum>'
           '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>')
    for i, s in enumerate(starts, 1):
        over = "".join(f'<w:lvlOverride w:ilvl="{lv}"><w:startOverride w:val="{s}"/></w:lvlOverride>' for lv in range(9))
        xml += f'<w:num w:numId="{10 + i}"><w:abstractNumId w:val="1"/>{over}</w:num>'
    return xml + "</w:numbering>"


def to_docx(doc, meta: Meta, image_bytes) -> bytes:
    return Docx(meta, image_bytes).build(doc)


# ======================================================================== PDF(reportlab)
_pdf_font: tuple | None = None


def pdf_fonts() -> tuple[str, str, bool]:
    """(본문 글꼴, 굵은 글꼴, 파일에 넣었는지). 맑은 고딕 → 애플 고딕 → 나눔고딕 → 문천 → 내장 CID 글꼴 순."""
    global _pdf_font
    if _pdf_font:
        return _pdf_font
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.fonts import addMapping

    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    cands = []
    if os.environ.get("WORKWIKI_PDF_FONT"):
        cands.append((os.environ["WORKWIKI_PDF_FONT"], os.environ.get("WORKWIKI_PDF_FONT_BOLD")))
    cands += [
        (os.path.join(win, "malgun.ttf"), os.path.join(win, "malgunbd.ttf")),
        ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", None),
        ("/Library/Fonts/AppleGothic.ttf", None),
        ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf"),
        ("/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf", "/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf"),
        ("/usr/share/fonts/truetype/unfonts-core/UnDotum.ttf", "/usr/share/fonts/truetype/unfonts-core/UnDotumBold.ttf"),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", None),
    ]
    for reg, bold in cands:
        if not reg or not os.path.exists(reg):
            continue
        try:
            kw = {"subfontIndex": 0} if reg.lower().endswith(".ttc") else {}
            pdfmetrics.registerFont(TTFont("WWSans", reg, **kw))
            bname = "WWSans"
            if bold and os.path.exists(bold):
                pdfmetrics.registerFont(TTFont("WWSans-Bold", bold))
                bname = "WWSans-Bold"
            for b_ in (0, 1):
                for i_ in (0, 1):
                    addMapping("WWSans", b_, i_, bname if b_ else "WWSans")
            _pdf_font = ("WWSans", bname, True)
            return _pdf_font
        except Exception:
            continue
    pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
    for b_ in (0, 1):
        for i_ in (0, 1):
            addMapping("HYGothic-Medium", b_, i_, "HYGothic-Medium")
    _pdf_font = ("HYGothic-Medium", "HYGothic-Medium", False)
    return _pdf_font


def _pdf_text(s: str) -> str:
    # 글꼴에 없는 그림 글자(이모지·체크 표시)는 바꾼다
    s = s.replace("📎", "").replace("☐", "□").replace("☑", "■").replace("✔", "√")
    return _html.escape(_BAD_XML.sub("", s), quote=False)


def pdf_inline(nodes, meta: Meta) -> str:
    out = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t == "hardBreak":
            out.append("<br/>")
            continue
        if t != "text":
            out.append(pdf_inline(n.get("content"), meta))
            continue
        marks = n.get("marks") or []
        s = _pdf_text(n.get("text") or "")
        st = _style(marks)
        if _has(marks, "code"):
            s = f'<font color="#3b475a" backColor="#eef1f5">{s}</font>'
        if _has(marks, "bold"):
            s = f"<b>{s}</b>"
        if _has(marks, "italic"):
            s = f"<i>{s}</i>"
        if _has(marks, "underline"):
            s = f"<u>{s}</u>"
        if _has(marks, "strike"):
            s = f"<strike>{s}</strike>"
        if st.get("color") or st.get("size"):
            attrs = (f' color="{st["color"]}"' if st.get("color") else "") + (f' size="{st["size"] * 0.75:.1f}"' if st.get("size") else "")
            s = f"<font{attrs}>{s}</font>"
        href = abs_href(_link_of(marks), meta)
        if href:
            s = f'<a href="{_html.escape(href, quote=True)}" color="#263b63"><u>{s}</u></a>'
        out.append(s)
    return "".join(out)


def to_pdf(doc, meta: Meta, image_bytes) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import (CondPageBreak, Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)
    from reportlab.platypus.flowables import HRFlowable

    font, bold, _embedded = pdf_fonts()
    W, H = A4
    margin_x, margin_y = 18 * mm, 20 * mm
    text_w = W - 2 * margin_x
    navy, muted, line = colors.HexColor("#263b63"), colors.HexColor("#758196"), colors.HexColor("#cbd2dc")
    body = ParagraphStyle("body", fontName=font, fontSize=10.5, leading=16.5, textColor=colors.HexColor("#2b3648"), alignment=TA_LEFT,
                          spaceAfter=4)
    cell = ParagraphStyle("cell", parent=body, fontSize=9.5, leading=14, spaceAfter=0, wordWrap="CJK")
    hs = {1: ParagraphStyle("h1", parent=body, fontName=bold, fontSize=17, leading=23, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#202b3c")),
          2: ParagraphStyle("h2", parent=body, fontName=bold, fontSize=14.5, leading=20, spaceBefore=12, spaceAfter=5, textColor=colors.HexColor("#202b3c")),
          3: ParagraphStyle("h3", parent=body, fontName=bold, fontSize=12.5, leading=18, spaceBefore=9, spaceAfter=4, textColor=colors.HexColor("#202b3c")),
          4: ParagraphStyle("h4", parent=body, fontName=bold, fontSize=11, leading=16, spaceBefore=8, spaceAfter=3, textColor=colors.HexColor("#202b3c"))}
    title_st = ParagraphStyle("title", parent=body, fontName=bold, fontSize=20, leading=26, textColor=navy, spaceAfter=8)
    small = ParagraphStyle("small", parent=body, fontSize=8.5, leading=12, textColor=muted, spaceAfter=0)
    lab = ParagraphStyle("lab", parent=small, fontSize=8.5)
    val = ParagraphStyle("val", parent=body, fontSize=10, leading=14, spaceAfter=0, wordWrap="CJK")
    val_em = ParagraphStyle("val_em", parent=val, fontName=bold)
    cap = ParagraphStyle("cap", parent=small, spaceBefore=2, spaceAfter=6)

    def para(html_, st=body, **kw):
        return Paragraph(html_ or "&nbsp;", st, **kw)

    def image_flow(attrs, max_w):
        src = (attrs or {}).get("src") or ""
        got = None
        m = FILE_RE.match(src)
        if m:
            got = image_bytes(int(m.group(1)))
        elif src.startswith("data:image/"):
            mm_ = re.match(r"^data:(image/[a-z]+);base64,(.+)$", src, re.S)
            if mm_:
                got = (base64.b64decode(mm_.group(2)), mm_.group(1))
        if not got:
            return None
        from PIL import Image as PImage
        try:
            im = PImage.open(io.BytesIO(got[0]))
            wpx, hpx = im.size
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "PNG") if im.mode not in ("RGB", "L") else im.save(buf, "PNG")
            buf.seek(0)
        except Exception:
            return None
        want = attrs.get("width")
        w = (float(want) if isinstance(want, (int, float)) and want else float(wpx)) * 0.75
        w = min(w, max_w)
        h = w * hpx / max(1, wpx)
        if h > H * 0.55:
            h = H * 0.55
            w = h * wpx / max(1, hpx)
        return Image(buf, width=w, height=h, hAlign="LEFT")

    def list_flows(node, depth, max_w):
        t = node.get("type")
        start = int((node.get("attrs") or {}).get("start") or 1)
        out = []
        for i, li in enumerate(node.get("content") or []):
            if not isinstance(li, dict):
                continue
            if t == "orderedList":
                bullet = f"{start + i}."
            elif t == "taskList":
                bullet = "■" if (li.get("attrs") or {}).get("checked") else "□"
            else:
                bullet = "•" if depth % 2 == 0 else "◦"
            first = True
            st = ParagraphStyle(f"li{depth}", parent=body, leftIndent=16 * (depth + 1), bulletIndent=16 * depth + 2, spaceAfter=2)
            for b in li.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") in ("bulletList", "orderedList", "taskList"):
                    out += list_flows(b, depth + 1, max_w)
                    continue
                html_ = pdf_inline(b.get("content"), meta) if b.get("type") in ("paragraph", "heading") else _pdf_text(plain(b))
                out.append(para(html_, st, bulletText=bullet if first else None))
                first = False
        return out

    def table_flow(node, max_w):
        nrows, ncols, cells = table_grid(node)
        if not nrows or not ncols:
            return None
        widths = col_widths(nrows, ncols, cells, max_w)
        data = [[""] * ncols for _ in range(nrows)]
        style = [("GRID", (0, 0), (-1, -1), 0.6, line), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                 ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                 ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
        for ce in cells:
            w = sum(widths[ce["c"]:ce["c"] + ce["cs"]]) - 10
            st = ParagraphStyle("th", parent=cell, fontName=bold) if ce["header"] else cell
            flows = blocks(ce["node"].get("content"), w, st)
            data[ce["r"]][ce["c"]] = flows or ""
            if ce["cs"] > 1 or ce["rs"] > 1:
                style.append(("SPAN", (ce["c"], ce["r"]), (ce["c"] + ce["cs"] - 1, ce["r"] + ce["rs"] - 1)))
            if ce["header"]:
                style.append(("BACKGROUND", (ce["c"], ce["r"]), (ce["c"] + ce["cs"] - 1, ce["r"] + ce["rs"] - 1), colors.HexColor("#f7f8fa")))
        header = all(c["header"] for c in cells if c["r"] == 0) and nrows > 1
        return Table(data, colWidths=widths, style=TableStyle(style), repeatRows=1 if header else 0, hAlign="LEFT")

    def callout_flow(node, max_w):
        kind = (node.get("attrs") or {}).get("type")
        kind = kind if kind in ALLOWED_CALLOUTS else "info"
        bg, ln, fg = CALLOUT_COLORS[kind]
        inner = [para(f'<b>{ALLOWED_CALLOUTS[kind]}</b>', ParagraphStyle("cl", parent=body, fontName=bold, fontSize=9.5, leading=13,
                                                                         textColor=colors.HexColor("#" + fg), spaceAfter=2))]
        inner += blocks(node.get("content"), max_w - 24)
        t = Table([[inner]], colWidths=[max_w], hAlign="LEFT")
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#" + bg)), ("LINEBEFORE", (0, 0), (0, -1), 2.5, colors.HexColor("#" + ln)),
                               ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                               ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        return t

    def blocks(nodes, max_w, st=body):
        out = []
        for b in nodes or []:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            a = b.get("attrs") or {}
            if t == "paragraph":
                out.append(para(pdf_inline(b.get("content"), meta), st))
            elif t == "heading":
                lv = max(1, min(4, int(a.get("level") or 2)))
                out.append(CondPageBreak(40))
                out.append(para(pdf_inline(b.get("content"), meta), hs[lv] if st is body else ParagraphStyle("hc", parent=st, fontName=bold)))
            elif t in ("bulletList", "orderedList", "taskList"):
                out += list_flows(b, 0, max_w)
            elif t == "table":
                tf = table_flow(b, max_w)
                if tf:
                    out += [Spacer(1, 3), tf, Spacer(1, 6)]
            elif t == "callout":
                out += [Spacer(1, 3), callout_flow(b, max_w), Spacer(1, 6)]
            elif t == "blockquote":
                inner = blocks(b.get("content"), max_w - 14, ParagraphStyle("bq", parent=st, textColor=colors.HexColor("#3b475a")))
                tq = Table([[inner]], colWidths=[max_w], hAlign="LEFT")
                tq.setStyle(TableStyle([("LINEBEFORE", (0, 0), (0, -1), 2, colors.HexColor("#c8d4e8")), ("LEFTPADDING", (0, 0), (-1, -1), 10)]))
                out.append(tq)
            elif t == "codeBlock":
                code = "<br/>".join(_pdf_text(ln).replace(" ", "&nbsp;") for ln in plain(b).split("\n"))
                tc = Table([[para(code, ParagraphStyle("code", parent=cell, textColor=colors.HexColor("#3b475a")))]], colWidths=[max_w], hAlign="LEFT")
                tc.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f7f8fa")), ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e1e5eb"))]))
                out.append(tc)
            elif t == "horizontalRule":
                out.append(HRFlowable(width="100%", thickness=0.6, color=line, spaceBefore=6, spaceAfter=6))
            elif t == "image":
                im = image_flow(a, max_w)
                if im:
                    caption = (a.get("title") or "").strip()
                    out.append(KeepTogether([im, para(_pdf_text(caption), cap)]) if caption else im)
            else:
                out += blocks(b.get("content"), max_w, st)
        return out

    story = [para(_pdf_text(meta.title), title_st)]
    rows = meta.rows()
    data, style = [], [("BOX", (0, 0), (-1, -1), 0.6, line), ("INNERGRID", (0, 0), (-1, -1), 0.6, line),
                       ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]
    for i in range(0, len(rows), 2):
        r = []
        for k, v, em in rows[i:i + 2]:
            r += [para(_pdf_text(k), lab), para(_pdf_text(v), val_em if em else val)]
        data.append(r)
    for ri in range(len(data)):
        style += [("BACKGROUND", (0, ri), (0, ri), colors.HexColor("#e9eff8")), ("BACKGROUND", (2, ri), (2, ri), colors.HexColor("#e9eff8"))]
    lw = 62
    info = Table(data, colWidths=[lw, text_w / 2 - lw, lw, text_w / 2 - lw], style=TableStyle(style), hAlign="LEFT")
    story += [para(f"문서 관리 정보 · {_pdf_text(meta.source_label)}", small), Spacer(1, 3), info]
    if meta.tags:
        story += [Spacer(1, 5), para(_pdf_text("  ".join("#" + t for t in meta.tags)), small)]
    story += [Spacer(1, 6), HRFlowable(width="100%", thickness=0.8, color=navy, spaceBefore=4, spaceAfter=10)]
    story += blocks((doc or {}).get("content"), text_w)

    foot = f"WorkWiki · {meta.manual_no} {meta.title} · {meta.edition_label}"
    stamp = f"출력 {meta.exported_at} {meta.exported_by}"

    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._pages = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            n = len(self._pages)
            for st in self._pages:
                self.__dict__.update(st)
                self.setFont(font, 7.5)
                self.setFillColor(muted)
                self.setStrokeColor(line)
                self.line(margin_x, margin_y - 8, W - margin_x, margin_y - 8)
                self.drawString(margin_x, margin_y - 19, foot[:90])
                self.drawRightString(W - margin_x, margin_y - 19, f"{self._pageNumber} / {n}")
                self.drawString(margin_x, H - margin_y + 10, stamp)
                super().showPage()
            super().save()

    buf = io.BytesIO()
    d = SimpleDocTemplate(buf, pagesize=A4, leftMargin=margin_x, rightMargin=margin_x, topMargin=margin_y, bottomMargin=margin_y,
                          title=meta.title, author="WorkWiki", subject=f"{meta.manual_no} {meta.edition_label}", creator="WorkWiki")
    d.build(story, canvasmaker=NumberedCanvas)
    return buf.getvalue()
