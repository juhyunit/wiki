// 내보내기(Markdown · HTML · DOCX) — 데모 어댑터용. backend/app/exporters.py와 같은 구성을 유지한다.
// PDF는 서버(reportlab)가 만들고, 데모에서는 같은 HTML을 인쇄 창으로 열어 'PDF로 저장'을 쓴다.
import { internalTarget } from './knowledge'

export interface ExportMeta {
  title: string
  manual_no: string
  department_name: string
  category_name: string | null
  edition: number
  version_no: number | null
  view: 'published' | 'work'
  published_at: string | null
  published_by: string | null
  owner_name: string | null
  review_cycle_months: number
  next_review_date: string | null
  visibility: 'company' | 'department'
  extra_departments: string[]
  tags: string[]
  exported_by: string
  exported_at: string
}

const FILE_RE = /^\/api\/files\/(\d+)$/
const CALLOUT: Record<string, string> = { warning: '주의', danger: '중요', info: '참고' }
const CALLOUT_COLORS: Record<string, [string, string, string]> = {
  warning: ['FCF7E8', '8F6A12', '8F6A12'], danger: ['FCF1E8', 'D97736', 'B4561C'], info: ['E9EFF8', '263B63', '263B63'],
}
const WORD_FONT: Record<string, string> = {
  'Malgun Gothic, Apple SD Gothic Neo, sans-serif': '맑은 고딕', 'Dotum, Apple SD Gothic Neo, sans-serif': '돋움', 'Gulim, sans-serif': '굴림',
  'Batang, AppleMyungjo, serif': '바탕', 'Gungsuh, serif': '궁서', 'Consolas, D2Coding, monospace': 'Consolas',
}

export const editionLabel = (m: ExportMeta) =>
  m.view === 'work' ? (m.version_no ? `작업본 v${m.version_no}(게시 전)` : '저장 전 초안') : m.edition ? `제${m.edition}판 (v${m.version_no})` : '미게시'
const sourceLabel = (m: ExportMeta) => (m.view === 'work' ? '작업본(게시 전, 공식 문서 아님)' : '공식본')
const visLabel = (m: ExportMeta) => (m.visibility === 'company' ? '전사 공개' : '부서 한정' + (m.extra_departments.length ? ` (+${m.extra_departments.join(', ')})` : ''))

export function metaRows(m: ExportMeta): [string, string, boolean][] {
  let pub = (m.published_at || '').slice(0, 10)
  if (pub && m.published_by) pub += ` (${m.published_by})`
  return [
    ['문서 번호', m.manual_no, false], ['현재 판', editionLabel(m), false],
    ['문서 책임자', m.owner_name || '-', true], ['다음 검토일', m.next_review_date || '-', true],
    ['담당 부서', m.department_name + (m.category_name ? ` · ${m.category_name}` : ''), false], ['최종 게시', pub || '-', false],
    ['검토 주기', `${m.review_cycle_months}개월`, false], ['열람 범위', visLabel(m), false],
  ]
}

export function exportFilename(m: ExportMeta, ext: string) {
  const safe = m.title.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 80) || '매뉴얼'
  const tail = m.view === 'published' && m.edition ? `제${m.edition}판` : m.version_no ? `작업본 v${m.version_no}` : '초안'
  return `${m.manual_no} ${safe} (${tail}).${ext}`
}

// 데모는 서버 주소가 없어 내부 링크·첨부 링크를 뺀다(웹 링크·메일만 남김)
const absHref = (href?: string | null) => (href && /^(https?:|mailto:)/i.test(href) && internalTarget(href) == null ? href : null)
const linkOf = (marks: any[]) => marks?.find((m) => m?.type === 'link')?.attrs?.href as string | undefined
const has = (marks: any[], t: string) => !!marks?.some((m) => m?.type === t)
function styleOf(marks: any[]) {
  const a = marks?.find((m) => m?.type === 'textStyle')?.attrs || {}
  return {
    color: typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color.toLowerCase() : undefined,
    font: WORD_FONT[a.fontFamily] ? a.fontFamily : undefined,
    size: typeof a.fontSize === 'string' && /^\d+px$/.test(a.fontSize) ? parseInt(a.fontSize) : undefined,
  }
}
const plain = (n: any): string => (!n ? '' : n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? '\n' : (n.content || []).map(plain).join(''))

interface GridCell { r: number; c: number; rs: number; cs: number; node: any; header: boolean; colwidth: number[] | null }
export function tableGrid(node: any): { nrows: number; ncols: number; cells: GridCell[] } {
  const occ = new Set<string>()
  const cells: GridCell[] = []
  const rows = (node.content || []).filter(Boolean)
  let ncols = 0
  rows.forEach((r: any, ri: number) => {
    let c = 0
    for (const cell of r.content || []) {
      while (occ.has(`${ri},${c}`)) c++
      const a = cell.attrs || {}
      const cs = Math.max(1, Math.min(50, Number(a.colspan) || 1))
      const rs = Math.max(1, Math.min(rows.length - ri, Number(a.rowspan) || 1))
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) occ.add(`${ri + dr},${c + dc}`)
      cells.push({ r: ri, c, rs, cs, node: cell, header: cell.type === 'tableHeader', colwidth: Array.isArray(a.colwidth) ? a.colwidth : null })
      c += cs
    }
    let maxc = c
    occ.forEach((k) => { const [rr, cc] = k.split(',').map(Number); if (rr === ri) maxc = Math.max(maxc, cc + 1) })
    ncols = Math.max(ncols, maxc)
  })
  return { nrows: rows.length, ncols, cells }
}
function colWidths(ncols: number, cells: GridCell[], total: number) {
  const w: (number | null)[] = Array(ncols).fill(null)
  for (const ce of cells) {
    if (ce.colwidth && ce.colwidth.length === ce.cs && ce.colwidth.every((x) => typeof x === 'number' && x))
      ce.colwidth.forEach((x, k) => { if (w[ce.c + k] == null) w[ce.c + k] = x })
  }
  const known = w.filter((x): x is number => !!x)
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
  const ww = w.map((x) => x || avg)
  const s = ww.reduce((a, b) => a + b, 0) || 1
  return ww.map((x) => (total * x) / s)
}

// ======================================================================== Markdown
const MD_CALLOUT: Record<string, string> = { warning: 'WARNING', danger: 'IMPORTANT', info: 'NOTE' }
const mdEsc = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/~~/g, '\\~\\~')

function mdInline(nodes: any[], inTable = false): string {
  return (nodes || []).map((n) => {
    if (n.type === 'hardBreak') return inTable ? '<br>' : '  \n'
    if (n.type !== 'text') return mdInline(n.content, inTable)
    const text = n.text || ''
    const marks = n.marks || []
    let s: string
    if (has(marks, 'code')) {
      const tick = text.includes('`') ? '``' : '`'
      s = `${tick}${text}${tick}`
    } else {
      const e = mdEsc(text)
      const lead = e.length - e.trimStart().length
      const trail = e.length - e.trimEnd().length
      let core = e.trim()
      if (core) {
        if (has(marks, 'strike')) core = `~~${core}~~`
        if (has(marks, 'italic')) core = `*${core}*`
        if (has(marks, 'bold')) core = `**${core}**`
      }
      s = e.slice(0, lead) + core + (trail ? e.slice(e.length - trail) : '')
    }
    const href = absHref(linkOf(marks))
    return href ? `[${s}](${href.replace(/ /g, '%20').replace(/\)/g, '%29')})` : s
  }).join('')
}
function mdBlockLines(b: any): string[] {
  const a = b.attrs || {}
  switch (b.type) {
    case 'paragraph': {
      let s = mdInline(b.content)
      if (/^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>)/.test(s)) s = '\\' + s
      return s ? s.split('\n') : []
    }
    case 'heading': return ['#'.repeat(Math.max(1, Math.min(4, a.level || 2))) + ' ' + mdInline(b.content).replace(/\n/g, ' ')]
    case 'bulletList': case 'orderedList': case 'taskList': return mdList(b)
    case 'table': return mdTable(b)
    case 'callout': return [`> [!${MD_CALLOUT[a.type] || 'NOTE'}]`, ...mdBlocks(b.content).map((x) => ('> ' + x).trimEnd())]
    case 'blockquote': return mdBlocks(b.content).map((x) => ('> ' + x).trimEnd())
    case 'codeBlock': { const code = plain(b); const f = code.includes('```') ? '````' : '```'; return [f, ...code.split('\n'), f] }
    case 'horizontalRule': return ['---']
    case 'image': {
      const src: string = a.src || ''
      if (!src.startsWith('data:image/')) return []
      const cap = (a.title || '').trim()
      return [`![${mdEsc((a.alt || cap || '그림').trim())}](${src}${cap ? ` "${cap.replace(/"/g, '')}"` : ''})`]
    }
    default: return b.content ? mdBlocks(b.content) : []
  }
}
function mdBlocks(blocks: any[]): string[] {
  const out: string[] = []
  for (const b of blocks || []) {
    const lines = mdBlockLines(b)
    if (!lines.length) continue
    if (out.length) out.push('')
    out.push(...lines)
  }
  return out
}
function mdList(node: any): string[] {
  const start = node.attrs?.start || 1
  const out: string[] = []
  ;(node.content || []).forEach((li: any, i: number) => {
    const mark = node.type === 'orderedList' ? `${start + i}. ` : node.type === 'taskList' ? (li.attrs?.checked ? '- [x] ' : '- [ ] ') : '- '
    const pad = ' '.repeat(node.type === 'taskList' ? 2 : mark.length)
    const body: string[] = []
    for (const b of li.content || []) {
      const lines = mdBlockLines(b)
      if (body.length && !['bulletList', 'orderedList', 'taskList'].includes(b.type) && lines.length) body.push('')
      body.push(...lines)
    }
    if (!body.length) body.push('')
    out.push(mark + body[0], ...body.slice(1).map((x) => (x ? pad + x : '')))
  })
  return out
}
function mdTable(node: any): string[] {
  const { nrows, ncols, cells } = tableGrid(node)
  if (!nrows || !ncols) return []
  const grid = Array.from({ length: nrows }, () => Array(ncols).fill(''))
  for (const ce of cells) {
    grid[ce.r][ce.c] = (ce.node.content || []).map((p: any) => (['paragraph', 'heading'].includes(p.type) ? mdInline(p.content, true) : plain(p).replace(/\n/g, ' ')))
      .filter(Boolean).join('<br>').replace(/\n/g, ' ')
  }
  return ['| ' + grid[0].join(' | ') + ' |', '|' + Array(ncols).fill(' --- ').join('|') + '|', ...grid.slice(1).map((r) => '| ' + r.join(' | ') + ' |')]
}

export function toMarkdown(doc: any, m: ExportMeta): string {
  const fm: Record<string, any> = {
    title: m.title, manual_no: m.manual_no, department: m.department_name, category: m.category_name || '', edition: editionLabel(m),
    published_at: (m.published_at || '').slice(0, 10), owner: m.owner_name || '', review_cycle_months: m.review_cycle_months,
    next_review_date: m.next_review_date || '', visibility: visLabel(m), tags: m.tags, source: `WorkWiki ${sourceLabel(m)}`,
    exported_at: m.exported_at, exported_by: m.exported_by,
  }
  const head = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---', '', `# ${m.title}`, '']
  return [...head, ...mdBlocks(doc?.content || [])].join('\n').trimEnd() + '\n'
}

// ======================================================================== HTML
const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const EXPORT_CSS = `:root{--primary:#263b63;--primary-light:#e9eff8;--primary-line:#c8d4e8;--accent:#d97736;--accent-text:#b4561c;--accent-light:#fcf1e8;--accent-line:#f2d4bd;--bg:#f7f8fa;--line:#e1e5eb;--text:#202b3c;--muted:#758196;--amber:#8f6a12;--amber-bg:#fcf7e8;--amber-line:#eedfb5}
*{box-sizing:border-box}body{margin:0;background:#fff;color:#2b3648;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,'Apple SD Gothic Neo','Malgun Gothic','맑은 고딕',Arial,sans-serif;font-size:15px;line-height:1.7;word-break:keep-all;overflow-wrap:anywhere}
.doc{max-width:820px;margin:0 auto;padding:40px 32px 64px}.doc-title{font-size:30px;line-height:1.3;color:var(--primary);margin:0 0 14px}
.info{border:1px solid var(--line);border-radius:4px;margin:0 0 28px}.info-head{display:flex;justify-content:space-between;gap:12px;padding:9px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.info-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 18px;padding:12px 14px;margin:0}.info-grid div{min-width:0}.info-grid dt{font-size:12px;color:var(--muted)}.info-grid dd{margin:2px 0 0;font-size:14px;color:var(--text)}.info-grid dd.em{font-weight:700}
.tags{font-size:13px;color:var(--muted);margin:-16px 0 24px}
.prose h1{font-size:25px}.prose h2{font-size:21px}.prose h3{font-size:18px}.prose h4{font-size:16px}.prose h1,.prose h2,.prose h3,.prose h4{color:var(--text);line-height:1.4;margin:1.5em 0 .4em}
.prose p{margin:.4em 0}.prose ul,.prose ol{padding-left:1.5em;margin:.4em 0}.prose li>p{margin:.08em 0}.prose a{color:var(--primary)}.prose strong{color:var(--text)}
.prose table{border-collapse:collapse;width:100%;font-size:14px;margin:1em 0}.prose th,.prose td{border:1px solid #cbd2dc;padding:7px 10px;vertical-align:top;text-align:left}.prose th{background:var(--bg)}.prose td>p,.prose th>p{margin:0}
.prose img{max-width:100%;height:auto}.prose figure{margin:1em 0}.prose figcaption{font-size:12.5px;color:var(--muted)}
.prose blockquote{margin:1em 0;padding:2px 0 2px 14px;border-left:3px solid var(--primary-line);color:#3b475a}.prose pre{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.prose code{background:var(--bg);padding:0 4px;border-radius:3px;font-size:.9em}.prose hr{border:none;border-top:1px solid var(--line);margin:2em 0}
.prose ul[data-type=taskList]{list-style:none;padding-left:0}.prose ul[data-type=taskList] li{display:flex;gap:8px}.prose ul[data-type=taskList] li>label{flex-shrink:0}.prose ul[data-type=taskList] li>div{flex:1}
.callout{margin:1em 0;padding:10px 14px;border:1px solid var(--c-line);border-radius:4px;background:var(--c-bg)}.callout-label{font-weight:700;font-size:13px;color:var(--c-accent);margin-bottom:2px}
.callout-body>:first-child{margin-top:0}.callout-body>:last-child{margin-bottom:0}.callout-warning{--c-accent:var(--amber);--c-bg:var(--amber-bg);--c-line:var(--amber-line)}.callout-danger{--c-accent:var(--accent-text);--c-bg:var(--accent-light);--c-line:var(--accent-line)}.callout-info{--c-accent:var(--primary);--c-bg:var(--primary-light);--c-line:var(--primary-line)}
.foot{margin-top:44px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
@media (max-width:640px){.info-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.doc{padding:24px 18px}}@media print{.doc{padding:0;max-width:none}@page{size:A4;margin:16mm 15mm}}`

export function toHtml(renderedHtml: string, m: ExportMeta): string {
  const box = document.createElement('div')
  box.innerHTML = renderedHtml
  box.querySelectorAll('a').forEach((a) => {
    const h = absHref(a.getAttribute('href'))
    if (h) a.setAttribute('href', h)
    else a.removeAttribute('href')
  })
  box.querySelectorAll('img').forEach((img) => { if (!/^data:image\//.test(img.getAttribute('src') || '')) img.remove() })
  const grid = metaRows(m).map(([k, v, em]) => `<div><dt>${esc(k)}</dt><dd${em ? ' class=em' : ''}>${esc(v)}</dd></div>`).join('')
  const tags = m.tags.length ? `<div class="tags">${m.tags.map((t) => '#' + esc(t)).join(' ')}</div>` : ''
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="WorkWiki">
<title>${esc(m.title)} (${esc(m.manual_no)})</title><style>${EXPORT_CSS}</style></head>
<body><article class="doc"><h1 class="doc-title">${esc(m.title)}</h1>
<section class="info"><div class="info-head"><span>문서 관리 정보</span><span>${esc(sourceLabel(m))}</span></div><dl class="info-grid">${grid}</dl></section>
${tags}<div class="prose">${box.innerHTML}</div>
<footer class="foot">WorkWiki에서 내보냄 · ${esc(m.exported_at)} · ${esc(m.exported_by)} · ${esc(m.manual_no)} ${esc(editionLabel(m))}.
이 파일은 내보낸 시점의 사본입니다. 최신 공식본은 WorkWiki에서 확인하세요.</footer></article></body></html>
`
}

// ======================================================================== DOCX(OOXML 직접 작성 + 압축 없는 zip)
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g
const x = (s: any) => String(s ?? '').replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const TEXT_W = 9638
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

type RunOpt = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; color?: string; size?: number; font?: string; style?: string }
function run(text: string, o: RunOpt = {}) {
  const pr: string[] = []
  if (o.style) pr.push(`<w:rStyle w:val="${o.style}"/>`)
  const f = o.code ? 'Consolas' : o.font
  if (f) pr.push(`<w:rFonts w:ascii="${x(f)}" w:hAnsi="${x(f)}" w:eastAsia="${x(f)}"/>`)
  if (o.bold) pr.push('<w:b/><w:bCs/>')
  if (o.italic) pr.push('<w:i/><w:iCs/>')
  if (o.strike) pr.push('<w:strike/>')
  if (o.color) pr.push(`<w:color w:val="${o.color.replace('#', '').toUpperCase()}"/>`)
  if (o.size) { const hp = Math.round(o.size * 1.5); pr.push(`<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`) }
  if (o.underline) pr.push('<w:u w:val="single"/>')
  if (o.code) pr.push('<w:shd w:val="clear" w:color="auto" w:fill="EEF1F5"/>')
  const body = String(text).split('\n').map((p) => `<w:t xml:space="preserve">${x(p)}</w:t>`).join('<w:br/>')
  return `<w:r>${pr.length ? `<w:rPr>${pr.join('')}</w:rPr>` : ''}${body}</w:r>`
}
type ParaOpt = { style?: string; num?: number; ilvl?: number; ind?: number; hanging?: number; keepNext?: boolean; borderLeft?: string; borderBottom?: boolean; shade?: string; after?: number; before?: number }
function para(inner: string, o: ParaOpt = {}) {
  const pr: string[] = []
  if (o.style) pr.push(`<w:pStyle w:val="${o.style}"/>`)
  if (o.keepNext) pr.push('<w:keepNext/>')
  if (o.num != null) pr.push(`<w:numPr><w:ilvl w:val="${o.ilvl || 0}"/><w:numId w:val="${o.num}"/></w:numPr>`)
  if (o.borderLeft || o.borderBottom) {
    pr.push(`<w:pBdr>${o.borderLeft ? `<w:left w:val="single" w:sz="12" w:space="8" w:color="${o.borderLeft}"/>` : ''}${o.borderBottom ? '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="CBD2DC"/>' : ''}</w:pBdr>`)
  }
  if (o.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>`)
  if (o.after != null || o.before != null) pr.push(`<w:spacing${o.before != null ? ` w:before="${o.before}"` : ''}${o.after != null ? ` w:after="${o.after}"` : ''}/>`)
  if (o.ind != null) pr.push(`<w:ind w:left="${o.ind}"${o.hanging ? ` w:hanging="${o.hanging}"` : ''}/>`)
  return `<w:p>${pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : ''}${inner}</w:p>`
}

async function imageInfo(src: string): Promise<{ bytes: Uint8Array; mime: string; w: number; h: number } | null> {
  const m = src.match(/^data:(image\/[a-z]+);base64,(.+)$/s)
  if (!m) return null
  const bin = atob(m[2])
  let bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  let mime = m[1]
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
    const w = bmp.width, h = bmp.height
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      const png = c.toDataURL('image/png').split(',')[1]
      const b2 = atob(png)
      bytes = new Uint8Array(b2.length)
      for (let i = 0; i < b2.length; i++) bytes[i] = b2.charCodeAt(i)
      mime = 'image/png'
    }
    return { bytes, mime, w, h }
  } catch {
    return null
  }
}

class DocxWriter {
  rels: [string, string, string, boolean][] = []
  media: [string, Uint8Array][] = []
  nums: number[] = []
  pic = 0
  links = new Map<string, string>()
  images = new Map<string, Awaited<ReturnType<typeof imageInfo>>>()
  constructor(public meta: ExportMeta) {}
  rel(type: string, target: string, ext = false) {
    const id = `rId${this.rels.length + 10}`
    this.rels.push([id, type, target, ext])
    return id
  }
  linkRid(href: string) {
    if (!this.links.has(href)) this.links.set(href, this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', href, true))
    return this.links.get(href)!
  }
  runs(nodes: any[], base: RunOpt = {}): string {
    return (nodes || []).map((n) => {
      if (n.type === 'hardBreak') return '<w:r><w:br/></w:r>'
      if (n.type !== 'text') return this.runs(n.content, base)
      const marks = n.marks || []
      const st = styleOf(marks)
      const href = absHref(linkOf(marks))
      const r = run(n.text || '', {
        bold: has(marks, 'bold') || base.bold, italic: has(marks, 'italic'), underline: has(marks, 'underline') || !!href, strike: has(marks, 'strike'),
        code: has(marks, 'code'), color: st.color || (href ? '#263b63' : base.color), size: st.size || base.size, font: st.font ? WORD_FONT[st.font] : undefined,
        style: href ? 'WWLink' : undefined,
      })
      return href ? `<w:hyperlink r:id="${this.linkRid(href)}" w:history="1">${r}</w:hyperlink>` : r
    }).join('')
  }
  image(a: any): string {
    const info = this.images.get(a.src || '')
    if (!info) return ''
    this.pic++
    const ext = info.mime === 'image/png' ? 'png' : 'jpeg'
    const name = `image${this.pic}.${ext}`
    this.media.push([name, info.bytes])
    const rid = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `media/${name}`)
    let cx = Math.round((typeof a.width === 'number' && a.width ? a.width : info.w) * 9525)
    cx = Math.min(cx, TEXT_W * 635)
    const cy = Math.round((cx * info.h) / Math.max(1, info.w))
    const alt = x((a.alt || a.title || '').trim())
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${this.pic}" name="그림 ${this.pic}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${this.pic}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  }
  blocks(nodes: any[], ctx: any = {}): string {
    return (nodes || []).map((b) => this.block(b, ctx)).join('')
  }
  block(b: any, ctx: any): string {
    const a = b.attrs || {}
    switch (b.type) {
      case 'paragraph': return para(this.runs(b.content, ctx.run), { ind: ctx.ind, borderLeft: ctx.borderLeft, shade: ctx.shade })
      case 'heading': return para(this.runs(b.content), { style: `Heading${Math.max(1, Math.min(4, a.level || 2))}`, keepNext: true })
      case 'bulletList': case 'orderedList': case 'taskList': return this.list(b, ctx.depth || 0, ctx)
      case 'table': return this.table(b) + para('', { after: 60 })
      case 'callout': return this.callout(b)
      case 'blockquote': return this.blocks(b.content, { ...ctx, ind: (ctx.ind || 0) + 280, borderLeft: 'C8D4E8', run: { color: '#3b475a' } })
      case 'codeBlock': return (plain(b) || ' ').split('\n').map((ln) => para(run(ln, { code: true }), { shade: 'F7F8FA', after: 0, ind: ctx.ind })).join('')
      case 'horizontalRule': return para('', { borderBottom: true })
      case 'image': {
        const img = this.image(a)
        if (!img) return ''
        const cap = (a.title || '').trim()
        return para(img, { after: cap ? 40 : undefined, keepNext: !!cap }) + (cap ? para(run(cap), { style: 'WWCaption' }) : '')
      }
      default: return this.blocks(b.content, ctx)
    }
  }
  list(node: any, depth: number, ctx: any): string {
    let num: number | undefined
    if (node.type === 'orderedList') { this.nums.push(node.attrs?.start || 1); num = 10 + this.nums.length } else if (node.type === 'bulletList') num = 1
    const lv = Math.min(depth, 8)
    const out: string[] = []
    for (const li of node.content || []) {
      let first = true
      for (const b of li.content || []) {
        if (['bulletList', 'orderedList', 'taskList'].includes(b.type)) { out.push(this.list(b, depth + 1, ctx)); continue }
        const inner = ['paragraph', 'heading'].includes(b.type) ? this.runs(b.content) : this.runs([{ type: 'text', text: plain(b) }])
        const left = 400 * (lv + 1) + (ctx.ind || 0)
        if (first && node.type === 'taskList') out.push(para(run(li.attrs?.checked ? '☑ ' : '☐ ') + inner, { ind: left, hanging: 300, after: 40 }))
        else if (first) out.push(para(inner, { num, ilvl: lv, after: 40 }))
        else out.push(para(inner, { ind: left, after: 40 }))
        first = false
      }
    }
    return out.join('')
  }
  table(node: any): string {
    const { nrows, ncols, cells } = tableGrid(node)
    if (!nrows || !ncols) return ''
    const widths = colWidths(ncols, cells, TEXT_W).map((w) => Math.round(w))
    const at = new Map(cells.map((c) => [`${c.r},${c.c}`, c]))
    const cover = new Map<string, GridCell>()
    cells.forEach((c) => { for (let dr = 1; dr < c.rs; dr++) cover.set(`${c.r + dr},${c.c}`, c) })
    const headerRow = cells.filter((c) => c.r === 0).every((c) => c.header) && nrows > 1
    const sum = (a: number, n: number) => widths.slice(a, a + n).reduce((s, v) => s + v, 0)
    const rows: string[] = []
    for (let r = 0; r < nrows; r++) {
      const tcs: string[] = []
      for (let col = 0; col < ncols;) {
        const c = at.get(`${r},${col}`)
        if (c) {
          let pr = `<w:tcW w:w="${sum(col, c.cs)}" w:type="dxa"/>${c.cs > 1 ? `<w:gridSpan w:val="${c.cs}"/>` : ''}${c.rs > 1 ? '<w:vMerge w:val="restart"/>' : ''}`
          if (c.header) pr += '<w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/>'
          tcs.push(`<w:tc><w:tcPr>${pr}</w:tcPr>${this.blocks(c.node.content, { run: c.header ? { bold: true } : {} }) || para('')}</w:tc>`)
          col += c.cs
          continue
        }
        const cv = cover.get(`${r},${col}`)
        if (cv) {
          tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${sum(col, cv.cs)}" w:type="dxa"/>${cv.cs > 1 ? `<w:gridSpan w:val="${cv.cs}"/>` : ''}<w:vMerge/></w:tcPr>${para('')}</w:tc>`)
          col += cv.cs
          continue
        }
        tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/></w:tcPr>${para('')}</w:tc>`)
        col++
      }
      rows.push(`<w:tr>${r === 0 && headerRow ? '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${tcs.join('')}</w:tr>`)
    }
    return `<w:tbl><w:tblPr><w:tblStyle w:val="WWTable"/><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  }
  callout(node: any): string {
    const kind = CALLOUT[node.attrs?.type] ? node.attrs.type : 'info'
    const [bg, , fg] = CALLOUT_COLORS[kind]
    const inner = para(run(CALLOUT[kind], { bold: true, color: '#' + fg }), { after: 20 }) + (this.blocks(node.content) || para(''))
    return `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="${bg}"/><w:left w:val="single" w:sz="4" w:space="0" w:color="${bg}"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="${bg}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="${bg}"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${TEXT_W}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${TEXT_W}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${bg}"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>` + para('', { after: 60 })
  }
  infoTable(): string {
    const rows = metaRows(this.meta)
    const wl = 1500, wv = TEXT_W / 2 - 1500
    const cell = (w: number, inner: string, fill?: string) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner}</w:tc>`
    const trs: string[] = []
    for (let i = 0; i < rows.length; i += 2) {
      trs.push(`<w:tr><w:trPr><w:cantSplit/></w:trPr>${rows.slice(i, i + 2).map(([k, v, em]) => cell(wl, para(run(k, { color: '#5a6880', size: 12 }), { after: 0 }), 'E9EFF8') + cell(wv, para(run(v, { bold: em, size: 13 }), { after: 0 }))).join('')}</w:tr>`)
    }
    return `<w:tbl><w:tblPr><w:tblStyle w:val="WWTable"/><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${[wl, wv, wl, wv].map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs.join('')}</w:tbl>`
  }
  async build(doc: any): Promise<Blob> {
    const walk = (n: any) => { if (n?.type === 'image' && n.attrs?.src) this.images.set(n.attrs.src, null); (n?.content || []).forEach(walk) }
    walk(doc)
    for (const src of this.images.keys()) this.images.set(src, await imageInfo(src))
    const m = this.meta
    let head = para(run(m.title), { style: 'Title' }) + para(run(`문서 관리 정보 · ${sourceLabel(m)}`, { color: '#758196', size: 12 }), { after: 60 }) + this.infoTable()
    if (m.tags.length) head += para(run(m.tags.map((t) => '#' + t).join('  '), { color: '#758196', size: 12 }), { before: 80 })
    head += para('', { borderBottom: true, after: 200 })
    const body = this.blocks(doc?.content || [])
    const footerRid = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer1.xml')
    const sect = `<w:sectPr><w:footerReference w:type="default" r:id="${footerRid}"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1418" w:left="1134" w:header="709" w:footer="567" w:gutter="0"/></w:sectPr>`
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${head}${body}${sect}</w:body></w:document>`
    const fr = '<w:rPr><w:color w:val="758196"/><w:sz w:val="16"/></w:rPr>'
    const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W_NS}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${TEXT_W}"/></w:tabs></w:pPr>${run(`WorkWiki · ${m.manual_no} ${m.title} · ${editionLabel(m)} · 출력 ${m.exported_at} ${m.exported_by}`, { color: '#758196', size: 11 })}<w:r>${fr}<w:tab/></w:r><w:fldSimple w:instr="PAGE"><w:r>${fr}<w:t>1</w:t></w:r></w:fldSimple><w:r>${fr}<w:t xml:space="preserve"> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r>${fr}<w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`
    const rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
      ...this.rels.map(([id, t, target, ext]) => `<Relationship Id="${id}" Type="${t}" Target="${x(target)}"${ext ? ' TargetMode="External"' : ''}/>`)]
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const files: [string, string | Uint8Array][] = [
      ['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', ROOT_RELS],
      ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(m.title)}</dc:title><dc:subject>${x(m.manual_no)} ${x(editionLabel(m))}</dc:subject><dc:creator>WorkWiki</dc:creator><cp:keywords>${x(m.tags.join(', '))}</cp:keywords><cp:lastModifiedBy>${x(m.exported_by)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`],
      ['docProps/app.xml', APP_XML], ['word/document.xml', document], ['word/styles.xml', STYLES_XML], ['word/numbering.xml', numberingXml(this.nums)],
      ['word/settings.xml', SETTINGS_XML], ['word/footer1.xml', footer],
      ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`],
      ...this.media.map(([n, d]) => [`word/media/${n}`, d] as [string, Uint8Array]),
    ]
    return new Blob([zipStore(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  }
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WorkWiki</Application></Properties>`
const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="800"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`
const headingStyle = (n: number, size: number, before: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="100"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="202B3C"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:color w:val="2B3648"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:wordWrap w:val="0"/></w:pPr></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="263B63"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>${headingStyle(1, 34, 360)}${headingStyle(2, 30, 320)}${headingStyle(3, 26, 260)}${headingStyle(4, 23, 220)}<w:style w:type="paragraph" w:styleId="WWCaption"><w:name w:val="WorkWiki Caption"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="758196"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="character" w:styleId="WWLink"><w:name w:val="WorkWiki Link"/><w:rPr><w:color w:val="263B63"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="WWTable"><w:name w:val="WorkWiki Table"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD2DC"/></w:tblBorders><w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`
function numberingXml(starts: number[]) {
  const bullets = ['•', '◦', '▪']
  const lvls = (fmt: 'bullet' | 'decimal') => Array.from({ length: 9 }, (_, i) => fmt === 'bullet'
    ? `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${400 * (i + 1)}" w:hanging="300"/></w:pPr></w:lvl>`
    : `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${400 * (i + 1)}" w:hanging="340"/></w:pPr></w:lvl>`).join('')
  let s = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
  starts.forEach((st, i) => {
    s += `<w:num w:numId="${11 + i}"><w:abstractNumId w:val="1"/>${Array.from({ length: 9 }, (_, lv) => `<w:lvlOverride w:ilvl="${lv}"><w:startOverride w:val="${st}"/></w:lvlOverride>`).join('')}</w:num>`
  })
  return s + '</w:numbering>'
}

export const toDocx = (doc: any, m: ExportMeta) => new DocxWriter(m).build(doc)

// ---------------------------------------------------------------- 압축 없는 zip(STORE)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export function zipStore(files: [string, string | Uint8Array][]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    const nm = enc.encode(name)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true)
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true); local.setUint16(26, nm.length, true); local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), nm, data)
    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true)
    cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true); cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true)
    cen.setUint16(28, nm.length, true); cen.setUint16(30, 0, true); cen.setUint16(32, 0, true); cen.setUint16(34, 0, true); cen.setUint16(36, 0, true)
    cen.setUint32(38, 0, true); cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), nm)
    offset += 30 + nm.length + data.length
  }
  const cenSize = central.reduce((s, p) => s + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let p = 0
  for (const a of all) { out.set(a, p); p += a.length }
  return out
}

// ---------------------------------------------------------------- 화면 도우미
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// 내보낸 HTML을 숨은 틀에 넣고 인쇄 창을 연다(데모의 PDF 저장)
export function printHtml(html: string) {
  const f = document.createElement('iframe')
  f.setAttribute('aria-hidden', 'true')
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(f)
  const d = f.contentDocument!
  d.open()
  d.write(html)
  d.close()
  setTimeout(() => {
    f.contentWindow?.focus()
    f.contentWindow?.print()
    setTimeout(() => f.remove(), 60000)
  }, 250)
}
