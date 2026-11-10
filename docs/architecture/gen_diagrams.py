# stack-diagram(https://github.com/caru-ini/stack-diagram, MIT) 템플릿으로 wikiLink 구성도 두 장(As-Is·To-Be) 원본 HTML을 만든다.
# 다시 만들기:
#   git clone https://github.com/caru-ini/stack-diagram
#   SK=stack-diagram/skills/stack-diagram
#   python3 $SK/scripts/fetch_icons.py icons "fastapi=https://raw.githubusercontent.com/devicons/devicon/master/icons/fastapi/fastapi-original.svg" ...
#     (아이콘 목록과 주소는 as-is.html·to-be.html 맨 아래 출처 참고: devicon, gilbarbara/logos, vLLM 저장소, Lucide)
#   python3 gen_diagrams.py $SK .
#   python3 $SK/scripts/build.py as-is.src.html icons as-is.html --fonts $SK/assets/fonts   (to-be도 같게)
#   python3 $SK/scripts/render_png.py as-is.html as-is.png --selector .canvas --scale 2   → as-is.png, as-is-dark.png
import pathlib, re, sys

SKILL = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
tpl = (SKILL / "assets/template.html").read_text(encoding="utf-8")
head, rest = tpl.split("<body>", 1)
FONT_KO = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", '
head = head.replace('<html lang="en"><!-- set lang to the label language, e.g. "ja" for Japanese labels -->', '<html lang="ko">')
head = head.replace('--font-display: "Geist", ', '--font-display: "Geist", ' + FONT_KO)
head = head.replace('--font-body: ', '--font-body: ' + FONT_KO, 1)
# 사내망 그룹 색: 워크위키 네이비 계열로 맞춘다(그룹 팔레트 A의 색상만 바꿈)
head = head.replace("--color-g1:      oklch(68% 0.15 55);", "--color-g1:      oklch(55% 0.09 262);")
head = head.replace("--color-g1-soft: oklch(78% 0.12 55);", "--color-g1-soft: oklch(70% 0.07 262);")
head = head.replace("--color-g1-ink:  oklch(52% 0.14 50);", "--color-g1-ink:  oklch(40% 0.08 262);")
head = head.replace("--color-g1-tint: oklch(96.5% 0.015 60 / .5);", "--color-g1-tint: oklch(96.5% 0.012 262 / .55);")
head = head.replace("--color-g1:      oklch(70% 0.14 55);", "--color-g1:      oklch(68% 0.08 262);")
head = head.replace("--color-g1-soft: oklch(58% 0.11 55);", "--color-g1-soft: oklch(55% 0.06 262);")
head = head.replace("--color-g1-ink:  oklch(78% 0.12 55);", "--color-g1-ink:  oklch(80% 0.06 262);")
head = head.replace("--color-g1-tint: oklch(26% 0.030 60 / .40);", "--color-g1-tint: oklch(26% 0.03 262 / .40);")
head = head.replace(".lede { max-width: 300px;", ".lede { max-width: 380px;")


def node(cx, top, icon, name, role, tile=""):
    return (f'    <div class="node" style="left:{cx - 66}px;top:{top}px">\n'
            f'      <div class="tile{(" " + tile) if tile else ""}"><img src="%%ICON_{icon}%%" alt=""></div>\n'
            f'      <div class="name"><span>{name}</span></div><div class="role"><span>{role}</span></div>\n    </div>\n')


def group(cls, l, t, w, h, label, icon=None):
    img = f'<img class="plate" src="%%ICON_{icon}%%" alt="">' if icon else ""
    return f'    <div class="group {cls}" style="left:{l}px; top:{t}px; width:{w}px; height:{h}px;">\n      <div class="g-label">{img}{label}</div>\n    </div>\n'


def page(w, h, kicker, title, lede, groups, edges, nodes, legend, foot_left):
    css = head.replace(".canvas { position: relative; width: 1000px; height: 540px;", f".canvas {{ position: relative; width: {w}px; height: {h}px;")
    css = css.replace("svg.edges { position:absolute; inset:0; width:1000px; height:540px;", f"svg.edges {{ position:absolute; inset:0; width:{w}px; height:{h}px;")
    css = css.replace("<title><!-- TITLE --></title>", f"<title>{title}</title>")
    return f"""{css}<body>
<div class="page">
  <header class="head">
    <div>
      <div class="kicker">{kicker}</div>
      <h1>{title}</h1>
    </div>
    <p class="lede">{lede}</p>
  </header>
  <div class="scroller">
  <div class="canvas">
{''.join(groups)}
    <svg class="edges" viewBox="0 0 {w} {h}" aria-hidden="true">
      <defs>
        <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/>
        </marker>
      </defs>
{edges}
    </svg>
{''.join(nodes)}
  </div>
  </div>
  <div class="legend">{legend}</div>
  <div class="foot">
    <span>{foot_left}</span>
    <span>icons: devicon / gilbarbara/logos / vLLM / Lucide · made with <a href="https://github.com/caru-ini/stack-diagram" target="_blank" rel="noopener">stack-diagram</a></span>
  </div>
</div>
</body>
</html>
"""


LEGEND = ('<span><span class="sw"></span>사용자 요청 흐름</span><span><span class="sw n"></span>내부 연결</span>'
          '<span><span class="sw n dash"></span>빌드·배포</span>')

# ------------------------------------------------------------------ As-Is: 현재 프로토타입
R1, R2, R3 = 120, 330, 560
asis_groups = [
    group("gb", 40, 60, 360, 210, "직원 PC 브라우저"),
    group("ga", 410, 60, 510, 420, "사내 PC 1대 · Windows (start.bat → python -m app)", "pc"),
    group("gb", 40, 500, 360, 210, "GitHub · Cloudflare — 시연용 데모", "github"),
]
asis_nodes = [
    node(130, R1, "user", "직원", "사내망 · 몇 명"),
    node(310, R1, "react", "React + TipTap", "화면 · 편집기"),
    node(580, R1, "fastapi", "FastAPI", "API · 권한 can()"),
    node(830, R1, "ollama", "Ollama", "qwen3:4b · bge-m3"),
    node(500, R2, "sqlite", "SQLite", "매뉴얼·버전·감사·색인"),
    node(660, R2, "folder", "첨부 파일", "data/files"),
    node(830, R2, "worker", "임베딩 작업자", "근거 문단 → 벡터"),
    node(130, R3, "github", "GitHub", "juhyunit/wiki"),
    node(310, R3, "workers", "Cloudflare Workers", "정적 데모 사이트"),
]
asis_edges = """      <path class="e" d="M166 150 H274" marker-end="url(#ar)"/>
      <path class="e" d="M346 150 H544" marker-end="url(#ar)"/>
      <text class="el a" x="445" y="142" text-anchor="middle">REST /api</text>
      <path class="e" d="M616 150 H794" marker-end="url(#ar)"/>
      <text class="el a" x="705" y="142" text-anchor="middle">답변 생성</text>
      <path class="n" d="M580 226 V280 H500 V324" marker-end="url(#ar)"/>
      <text class="el" x="540" y="272" text-anchor="middle">SQL</text>
      <path class="n" d="M580 280 H660 V324" marker-end="url(#ar)"/>
      <text class="el" x="620" y="272" text-anchor="middle">파일</text>
      <path class="n" d="M830 324 V228" marker-end="url(#ar)"/>
      <text class="el" x="840" y="280">embed</text>
      <path class="n" d="M830 436 V456 H500 V438" marker-end="url(#ar)"/>
      <text class="el" x="665" y="449" text-anchor="middle">근거 문단·벡터</text>
      <path class="n dash" d="M166 590 H274" marker-end="url(#ar)"/>
      <text class="el" x="220" y="582" text-anchor="middle">Workers Builds</text>"""
(OUT / "as-is.src.html").write_text(page(
    960, 740, "wikiLink · As-Is · 2026-11", "현재 구성: 프로토타입(PC 1대)",
    "서버·DB·파일·로컬 모델이 PC 한 대에서 함께 동작합니다. 외부 API는 부르지 않습니다. 시연용 데모는 서버 없이 브라우저에만 저장합니다.",
    asis_groups, asis_edges, asis_nodes, LEGEND, "wikiLink 프로토타입 · FastAPI + SQLite + Ollama"), encoding="utf-8")

# ------------------------------------------------------------------ To-Be: 사내 수천 명
T1, T2, T3 = 120, 360, 600
tobe_groups = [
    group("ga", 190, 60, 360, 210, "웹·앱 계층 — 서버 2대 이상", "lan"),
    group("ga", 690, 60, 180, 210, "AI 추론 — GPU 서버", "worker"),
    group("ga", 530, 300, 340, 210, "데이터", "hrdb"),
    group("ga", 370, 540, 500, 210, "배치·연계"),
]
tobe_nodes = [
    node(100, T1, "user", "직원 수천 명", "사내 PC 브라우저"),
    node(280, T1, "nginx", "Nginx", "TLS · 부하 분산"),
    node(460, T1, "fastapi", "FastAPI ×N", "무상태 앱 서버"),
    node(780, T1, "vllm", "vLLM", "답변·임베딩 모델"),
    node(280, T2, "sso", "사내 SSO", "OIDC · AD (기존)"),
    node(620, T2, "postgresql", "PostgreSQL 16", "이중화 · pgvector"),
    node(780, T2, "nas", "NAS 공유 볼륨", "첨부·원본 파일"),
    node(460, T3, "hrdb", "인사 DB", "기존 시스템"),
    node(620, T3, "worker", "작업 워커", "임베딩·동기화·알림"),
    node(780, T3, "mail", "사내 메일", "검토 지연 요약"),
]
tobe_edges = """      <path class="e" d="M136 150 H244" marker-end="url(#ar)"/>
      <text class="el a" x="142" y="142">HTTPS</text>
      <path class="e" d="M316 150 H424" marker-end="url(#ar)"/>
      <path class="e" d="M496 150 H744" marker-end="url(#ar)"/>
      <text class="el a" x="620" y="142" text-anchor="middle">OpenAI 호환 API</text>
      <path class="n" d="M460 226 V285 H280 V354" marker-end="url(#ar)"/>
      <text class="el" x="290" y="326">OIDC</text>
      <path class="n" d="M460 285 H620 V354" marker-end="url(#ar)"/>
      <text class="el" x="630" y="335">SQL</text>
      <path class="n" d="M620 285 H780 V354" marker-end="url(#ar)"/>
      <text class="el" x="790" y="335">파일</text>
      <path class="n" d="M620 594 V468" marker-end="url(#ar)"/>
      <text class="el" x="630" y="530">작업 큐</text>
      <path class="n" d="M496 630 H584" marker-end="url(#ar)"/>
      <text class="el" x="540" y="622" text-anchor="middle">일 1회</text>
      <path class="n" d="M656 630 H744" marker-end="url(#ar)"/>
      <text class="el" x="700" y="622" text-anchor="middle">SMTP</text>"""
(OUT / "to-be.src.html").write_text(page(
    960, 780, "wikiLink · To-Be · 사내 수천 명", "목표 구성: 사내 운영(수천 명)",
    "모두 사내망 안에서만 동작합니다. 앱 서버는 상태를 두지 않아 늘릴 수 있고, 데이터·파일은 이중화하며, 모델은 GPU 서버 한 곳에서 제공합니다.",
    tobe_groups, tobe_edges, tobe_nodes, LEGEND, "wikiLink 운영 전환안 · 사내 SSO · PostgreSQL · vLLM"), encoding="utf-8")
print("ok")
