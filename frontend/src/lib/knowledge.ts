// 문서 링크 추출 · AI 근거 문단 나누기 · 한국어 낱말 검색(BM25).
// backend/app/chunks.py, ai.py(retrieve)와 같은 규칙을 유지한다(데모 어댑터가 서버 없이 같은 결과를 내도록).

const INTERNAL_LINK_RE = /^#\/m\/(\d+)(?:[?#].*)?$/
const CALLOUT_LABEL: Record<string, string> = { warning: '주의', danger: '중요', info: '참고' }
const MAX_CHUNK = 700

export function internalTarget(href: unknown): number | null {
  if (typeof href !== 'string') return null
  const m = href.trim().match(INTERNAL_LINK_RE)
  return m ? Number(m[1]) : null
}

export function docLinks(doc: any): Map<number, string> {
  const out = new Map<number, string>()
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'text') {
      for (const mk of n.marks || []) {
        if (mk?.type === 'link') {
          const t = internalTarget(mk.attrs?.href)
          if (t != null) out.set(t, ((out.get(t) || '') + (n.text || '')).slice(0, 200))
        }
      }
    }
    ;(n.content || []).forEach(walk)
  }
  walk(doc)
  for (const [k, v] of out) out.set(k, v.trim())
  return out
}

const plain = (n: any): string => (!n ? '' : n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? ' ' : (n.content || []).map(plain).join(''))
const countHeadings = (n: any): number => (!n ? 0 : (n.type === 'heading' ? 1 : 0) + (n.content || []).reduce((s: number, c: any) => s + countHeadings(c), 0))

function listLines(node: any, depth = 0): string[] {
  const lines: string[] = []
  const start = node.attrs?.start || 1
  ;(node.content || []).forEach((li: any, i: number) => {
    const mark = node.type === 'orderedList' ? `${start + i}.` : node.type === 'taskList' ? (li.attrs?.checked ? '[x]' : '[ ]') : '-'
    let first = true
    for (const b of li.content || []) {
      if (['bulletList', 'orderedList', 'taskList'].includes(b.type)) lines.push(...listLines(b, depth + 1))
      else {
        const txt = plain(b).trim()
        if (txt) {
          lines.push('  '.repeat(depth) + (first ? `${mark} ` : '  ') + txt)
          first = false
        }
      }
    }
  })
  return lines
}

function tableLines(node: any): string[] {
  const rows: string[][] = (node.content || []).map((r: any) => (r.content || []).map((c: any) => plain(c).trim()))
  if (!rows.length) return []
  const first = node.content?.[0]
  const hasHead = (first?.content || []).every((c: any) => c?.type === 'tableHeader') && rows.length > 1
  if (!hasHead) return rows.map((r) => r.join(' | '))
  const head = rows[0]
  return rows.slice(1).map((r) => r.map((v, i) => (v ? (i < head.length && head[i] ? `${head[i]}: ${v}` : v) : '')).filter(Boolean).join(' / '))
}

function split(lines: string[], prefix = ''): string[] {
  const out: string[] = []
  let cur = ''
  for (const ln of lines) {
    if (cur && cur.length + ln.length + 1 > MAX_CHUNK) {
      out.push(cur)
      cur = prefix ? prefix + ln : ln
    } else cur = cur ? `${cur}\n${ln}` : prefix ? prefix + ln : ln
  }
  if (cur) out.push(cur)
  return out
}

export interface Chunk { ord: number; heading: string; anchor: string | null; kind: string; text: string }

export function docChunks(doc: any): Chunk[] {
  const out: Omit<Chunk, 'ord'>[] = []
  let headingNo = 0
  let path: Record<number, string> = {}
  let anchor: string | null = null
  let pendingLead: Omit<Chunk, 'ord'> | null = null
  const headPath = () => Object.keys(path).map(Number).sort((a, b) => a - b).map((k) => path[k]).filter(Boolean).join(' › ')
  for (const b of doc?.content || []) {
    if (!b || typeof b !== 'object') continue
    const t = b.type
    if (t === 'heading') {
      headingNo++
      const lv = b.attrs?.level || 2
      path = Object.fromEntries(Object.entries(path).filter(([k]) => Number(k) < lv))
      path[lv] = plain(b).trim()
      anchor = `h-${headingNo}`
      pendingLead = null
      continue
    }
    const inner = countHeadings(b)
    let texts: string[] = []
    let kind = t
    if (t === 'paragraph') {
      const s = plain(b).trim()
      if (s) texts = [s]
    } else if (['bulletList', 'orderedList', 'taskList'].includes(t)) {
      texts = split(listLines(b))
      kind = 'list'
    } else if (t === 'table') texts = split(tableLines(b))
    else if (t === 'callout') {
      const label = CALLOUT_LABEL[b.attrs?.type] || '참고'
      const body: string[] = []
      for (const c of b.content || []) {
        if (['bulletList', 'orderedList', 'taskList'].includes(c.type)) body.push(...listLines(c))
        else {
          const s = plain(c).trim()
          if (s) body.push(s)
        }
      }
      texts = body.length ? split(body, `[${label}] `) : []
      if (texts.length && !texts[0].startsWith(`[${label}]`)) texts[0] = `[${label}] ` + texts[0]
    } else if (t === 'blockquote' || t === 'codeBlock') {
      const s = t === 'blockquote' ? (b.content || []).map((c: any) => plain(c).trim()).filter(Boolean).join('\n') : plain(b).trim()
      if (s) texts = split(s.split('\n'))
    }
    headingNo += inner
    if (!texts.length) continue
    if ((kind === 'list' || kind === 'table') && pendingLead && pendingLead.anchor === anchor) {
      out.splice(out.indexOf(pendingLead), 1)
      texts[0] = pendingLead.text + '\n' + texts[0]
    }
    for (const s of texts) out.push({ heading: headPath(), anchor, kind, text: s.slice(0, MAX_CHUNK * 2) })
    pendingLead = kind === 'paragraph' && texts[0].length <= 60 ? out[out.length - 1] : null
  }
  return out.map((c, i) => ({ ...c, ord: i }))
}

// ---------------------------------------------------------------- 한국어 토큰
const JOSA = ['으로서', '으로써', '에서는', '에게서', '이라면', '이라도', '까지는', '부터는', '으로', '에서', '에게', '한테', '까지', '부터',
  '이나', '이란', '라면', '이면', '에는', '에도', '와는', '과는', '보다', '처럼', '마다', '은', '는', '이', '가', '을', '를',
  '에', '의', '로', '와', '과', '도', '만', '요']
const QUESTION_STOP = new Set(['경우', '경우는', '경우에', '무엇', '무엇인가요', '뭐', '뭔가요', '어떻게', '어떤', '언제', '어디', '어디서', '누가', '누구',
  '왜', '알려줘', '알려주세요', '알려', '주세요', '하나요', '인가요', '있나요', '되나요', '해야', '하는', '하면', '되는',
  '방법', '방법은', '절차는', '대해', '대한', '관련', '궁금', '궁금합니다', '있어', '있는', '필요한가요', '할', '수', '때',
  '시', '및', '등', '또는', '그리고', '좀', 'the', 'a', 'an', 'is'])
const SYNONYMS = [
  ['증빙', '서류', '증명', '증명원', '증명서'], ['대출', '여신'], ['연차', '연가', '휴가'], ['소득', '급여', '근로소득', '원천징수'],
  ['결재', '승인', '전결'], ['퇴사', '퇴직'], ['전보', '발령', '인사발령'], ['계좌', '통장'], ['개인정보', '유출'], ['법인카드', '카드'],
]
const SYN = new Map<string, string[]>()
SYNONYMS.forEach((g) => g.forEach((w) => SYN.set(w, g)))
const isHangul = (w: string) => /^[가-힣]/.test(w)

function stripJosa(w: string) {
  for (const j of JOSA) if (w.length > j.length + 1 && w.endsWith(j)) return w.slice(0, -j.length)
  return w
}
export const words = (s: string) => (s || '').toLowerCase().match(/[0-9a-z]+|[가-힣]+/g) || []

export function tokens(s: string): string[] {
  const out: string[] = []
  for (const w of words(s)) {
    if (isHangul(w)) {
      if (w.length === 1) out.push(w)
      else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
    } else if (w.length > 1 || /^\d+$/.test(w)) out.push(w)
  }
  return out
}

export function queryTerms(q: string): { keys: string[]; toks: string[] } {
  const keys: string[] = []
  for (const w of words(q)) {
    if (QUESTION_STOP.has(w)) continue
    const w2 = isHangul(w) ? stripJosa(w) : w
    if (QUESTION_STOP.has(w2) || (w2.length < 2 && !/^\d+$/.test(w2))) continue
    if (!keys.includes(w2)) keys.push(w2)
  }
  const expanded = [...keys]
  for (const k of keys) for (const s of SYN.get(k) || []) if (!expanded.includes(s)) expanded.push(s)
  const toks: string[] = []
  for (const k of expanded) for (const t of tokens(k)) if (!toks.includes(t)) toks.push(t)
  return { keys, toks }
}

export function bm25(q: string[], docs: string[][], k1 = 1.2, b = 0.75): number[] {
  const n = docs.length
  if (!n || !q.length) return docs.map(() => 0)
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1)
  return docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1)
    let s = 0
    for (const t of q) {
      const f = tf.get(t) || 0
      const dft = df.get(t) || 0
      if (!f || !dft) continue
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5))
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg))
    }
    return s
  })
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export function highlightKeys(text: string, keys: string[]) {
  let out = escHtml(text)
  ;[...new Set(keys.filter((k) => k.length >= 2))].sort((a, b) => b.length - a.length).forEach((k) => {
    const re = new RegExp(escHtml(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, (m) => `<mark>${m}</mark>`)
  })
  return out
}

export interface RankRow { id: number; manual_id: number; title: string; tags: string[]; heading: string; text: string }

// 서버 ai.retrieve의 낱말 검색 부분(임베딩 없이)과 같은 순위 규칙
export function rankChunks<R extends RankRow>(rows: R[], question: string, topK = 6): { row: R; score: number }[] {
  const { keys, toks } = queryTerms(question)
  if (!rows.length) return []
  const lex = bm25(toks, rows.map((r) => tokens(`${r.title} ${r.heading} ${r.text}`)))
  rows.forEach((r, i) => {
    const meta = `${r.title} ${(r.tags || []).join(' ')}`.toLowerCase()
    const hits = keys.filter((k) => meta.includes(k)).length
    if (hits && lex[i] > 0) lex[i] *= 1 + 0.25 * hits
  })
  const order = rows.map((_, i) => i).filter((i) => lex[i] > 0).sort((a, b) => lex[b] - lex[a])
  if (!order.length) return []
  const best = lex[order[0]]
  const kept = order.filter((i) => lex[i] >= best * 0.3)
  const out: { row: R; score: number }[] = []
  const per = new Map<number, number>()
  kept.forEach((i, rank) => {
    if (out.length >= topK) return
    const r = rows[i]
    if ((per.get(r.manual_id) || 0) >= 4) return
    per.set(r.manual_id, (per.get(r.manual_id) || 0) + 1)
    out.push({ row: r, score: 1 / (60 + rank) })
  })
  return out
}
