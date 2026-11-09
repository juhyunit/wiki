// 글자 서식 허용 목록. 서버(backend/app/render.py의 FONT_FAMILIES·FONT_SIZES·COLOR_RE)와 같게 유지한다.
// 글꼴은 웹폰트 없이 PC에 설치된 글꼴만 고른다(없으면 같은 계열 기본 글꼴로 보임).

export const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: '맑은 고딕', value: 'Malgun Gothic, Apple SD Gothic Neo, sans-serif' },
  { label: '돋움', value: 'Dotum, Apple SD Gothic Neo, sans-serif' },
  { label: '굴림', value: 'Gulim, sans-serif' },
  { label: '바탕', value: 'Batang, AppleMyungjo, serif' },
  { label: '궁서', value: 'Gungsuh, serif' },
  { label: '고정폭', value: 'Consolas, D2Coding, monospace' },
]

export const FONT_SIZES = ['12px', '13px', '14px', '15px', '16px', '18px', '20px', '24px', '28px', '32px']

// 업무 문서용 절제된 팔레트(본문색은 '기본')
export const TEXT_COLORS: { label: string; value: string }[] = [
  { label: '회색', value: '#758196' },
  { label: '네이비', value: '#263b63' },
  { label: '파랑', value: '#1d5fbf' },
  { label: '초록', value: '#2e7d4f' },
  { label: '주황', value: '#d97736' },
  { label: '빨강', value: '#c0392b' },
  { label: '갈색', value: '#8a5a12' },
]

const COLOR_RE = /^#[0-9a-f]{6}$/i

// 브라우저가 style을 다시 쓰면서 rgb(r, g, b)로 바꾼 색을 #rrggbb로 되돌린다
export function cssColorToHex(v: string | null | undefined): string | null {
  const s = (v || '').trim()
  if (COLOR_RE.test(s)) return s.toLowerCase()
  const m = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i)
  if (!m) return null
  const parts = m.slice(1, 4).map(Number)
  if (parts.some((n) => n > 255)) return null
  return '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('')
}
const FAMILY_SET = new Set(FONT_FAMILIES.map((f) => f.value))
const SIZE_SET = new Set(FONT_SIZES)

export function safeTextStyleCss(a: { color?: string | null; fontFamily?: string | null; fontSize?: string | null }) {
  const out: string[] = []
  if (a.color && COLOR_RE.test(a.color)) out.push(`color:${a.color.toLowerCase()}`)
  if (a.fontFamily && FAMILY_SET.has(a.fontFamily)) out.push(`font-family:${a.fontFamily}`)
  if (a.fontSize && SIZE_SET.has(a.fontSize)) out.push(`font-size:${a.fontSize}`)
  return out.join(';')
}

// 붙여넣은 색(이름·rgb·#rgb 등)을 #rrggbb로 바꾼다. 검정에 가까운 색·자동색은 본문색으로 두려고 버린다
let ctx: CanvasRenderingContext2D | null | undefined
export function normalizePastedColor(raw: string | null | undefined): string | null {
  const v = (raw || '').trim().toLowerCase()
  if (!v || /^(windowtext|auto|inherit|initial|currentcolor|transparent)$/.test(v)) return null
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000001'
  ctx.fillStyle = v
  const hex = String(ctx.fillStyle)
  if (!COLOR_RE.test(hex) || hex === '#000001') return null
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if (Math.max(r, g, b) < 0x50) return null
  return hex.toLowerCase()
}
