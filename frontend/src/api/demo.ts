/* 데모 모드: 서버 없이 브라우저 안에서 같은 API를 흉내 낸다(권한 규칙·버전·게시·검색 포함).
   데이터는 이 브라우저의 localStorage에만 저장된다. 실제 운영 규칙은 backend/app/policy.py가 기준이다. */
import { generateHTML } from '@tiptap/html'
import { Api, ApiError } from './client'
import type * as T from './types'
import seedJson from './demo-seed.json'
const seedData: any = seedJson
import { buildExtensions } from '../editor/extensions'
import { cssColorToHex, safeTextStyleCss } from '../editor/textStyle'
import { nowStr, storage } from '../lib/util'

// v2: 부서 코드 4자리 숫자 체계로 바뀐 예시 데이터(예전 브라우저 데이터는 새 예시로 다시 시작)
const KEY = 'ww-demo-v2'
const USER_KEY = 'ww-demo-user'
type Row = Record<string, any>
type DB = Record<string, Row[]> & { exported_at: string; seq: Record<string, number> }

let db: DB
let mem: { userId: number | null } = { userId: null }

// ------------------------------------------------------------------ 저장소
function shiftDates(d: DB) {
  // 예시 데이터 날짜를 오늘 기준으로 옮긴다(내보낸 날과 오늘의 차이만큼)
  const exp = new Date(d.exported_at.slice(0, 10) + 'T00:00:00').getTime()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - exp) / 86400000)
  if (!days) return
  const fields = ['created_at', 'updated_at', 'published_at', 'saved_at', 'requested_at', 'decided_at', 'at', 'started_at', 'finished_at', 'next_review_date', 'date', 'uploaded_at']
  const shift = (s: string) => {
    const dt = new Date(s.slice(0, 10) + 'T00:00:00')
    dt.setDate(dt.getDate() + days)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}${s.slice(10)}`
  }
  for (const t of Object.keys(d)) {
    if (!Array.isArray(d[t])) continue
    for (const r of d[t]) for (const f of fields) if (typeof r[f] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r[f])) r[f] = shift(r[f])
  }
}

function fresh(): DB {
  const d = JSON.parse(JSON.stringify(seedData)) as DB
  shiftDates(d)
  d.attachments = []
  d.seq = {}
  for (const t of Object.keys(d)) if (Array.isArray(d[t])) d.seq[t] = Math.max(0, ...d[t].map((r: Row) => r.id || 0))
  return d
}

function load() {
  try {
    const raw = storage.get(KEY)
    db = raw ? JSON.parse(raw) : fresh()
  } catch {
    db = fresh()
  }
  const u = storage.get(USER_KEY)
  mem.userId = u ? Number(u) : null
}

function save() {
  if (!storage.set(KEY, JSON.stringify(db))) console.warn('데모 데이터를 브라우저에 저장하지 못했습니다(용량 초과 등). 새로고침하면 사라집니다.')
}

const nextId = (t: string) => (db.seq[t] = (db.seq[t] || 0) + 1)
const delay = <X>(v: X) => new Promise<X>((r) => setTimeout(() => r(v), 60))
const fail = (status: number, msg: string): never => {
  throw new ApiError(status, msg)
}
const today = () => nowStr().slice(0, 10)
const addMonths = (d: string, n: number) => {
  const dt = new Date(d + 'T00:00:00')
  const day = dt.getDate()
  dt.setDate(1)
  dt.setMonth(dt.getMonth() + n)
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate()
  dt.setDate(Math.min(day, last))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}
const addDays = (n: number) => {
  const dt = new Date()
  dt.setDate(dt.getDate() + n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

// ------------------------------------------------------------------ 조회 도우미
const T_ = (t: string) => db[t] as Row[]
const byId = (t: string, id: any) => T_(t).find((r) => r.id === id)
const dept = (id: number) => byId('departments', id)
const userRow = (id: number | null | undefined) => (id ? byId('users', id) : undefined)
const uname = (id: number | null | undefined) => userRow(id)?.name ?? null

interface U { id: number; name: string; department_id: number | null; is_active: boolean; roles: Set<string>; admin: Map<number, boolean> }
function loadUser(id: number | null): U | null {
  const r = userRow(id)
  if (!r) return null
  return {
    id: r.id, name: r.name, department_id: r.department_id, is_active: !!r.is_active,
    roles: new Set(T_('system_roles').filter((x) => x.user_id === r.id).map((x) => x.role)),
    admin: new Map(T_('dept_admins').filter((x) => x.user_id === r.id).map((x) => [x.department_id, !!x.can_self_publish])),
  }
}
function cur(): U {
  const u = loadUser(mem.userId)
  if (!u || !u.is_active) fail(401, '로그인이 필요합니다.')
  return u!
}
const isSys = (u: U) => u.roles.has('sys_admin')

// ------------------------------------------------------------------ 권한(backend/app/policy.py와 같은 규칙)
function can(u: U, action: string, m?: Row | null, deptId?: number | null, version?: Row | null): boolean {
  if (!u?.is_active) return false
  if (action === 'admin') return isSys(u)
  if (action === 'audit_all') return u.roles.has('auditor')
  if (m) {
    if (m.deleted_at) return false
    deptId = m.department_id
  }
  if (deptId == null) return false
  const member = u.department_id === deptId
  const dadmin = u.admin.has(deptId)
  if (action === 'create_manual') return member || dadmin
  if (['manage_categories', 'audit_dept', 'approve_queue'].includes(action)) return dadmin
  if (!m) return false
  const archived = m.status === 'archived'
  if (action === 'view_published') {
    if (!m.published_version_id) return false
    if (member || dadmin || isSys(u)) return true
    if (archived) return false
    if (m.visibility === 'company') return true
    return T_('manual_extra_departments').some((x) => x.manual_id === m.id && x.department_id === u.department_id)
  }
  if (action === 'view_work') return member || dadmin || isSys(u)
  if (action === 'unarchive') return dadmin
  if (archived) return false
  if (action === 'edit' || action === 'request_publish') return member || dadmin
  if (action === 'publish') {
    const skip = dept(deptId)?.approval_mode === 'skip'
    if (skip && (member || dadmin)) return true
    if (!dadmin) return false
    if (version && version.created_by === u.id && u.admin.get(deptId) === false) return false
    return true
  }
  if (['reject', 'manage', 'force_unlock'].includes(action)) return dadmin
  return false
}
function require_(ok: boolean, msg = '권한이 없습니다.') {
  if (!ok) fail(403, msg)
}

// ------------------------------------------------------------------ 본문 렌더링·텍스트·비교
const EXT = buildExtensions()
const CALLOUT_LABEL: Record<string, string> = { warning: '주의', danger: '중요', info: '참고' }

function postProcess(html: string): { html: string; toc: T.TocItem[] } {
  const box = document.createElement('div')
  box.innerHTML = html
  const toc: T.TocItem[] = []
  let n = 0
  box.querySelectorAll('h1,h2,h3,h4').forEach((h) => {
    n++
    h.id = `h-${n}`
    const lv = Number(h.tagName[1])
    if (lv <= 3 && h.textContent?.trim()) toc.push({ id: h.id, level: lv, text: h.textContent.trim() })
  })
  box.querySelectorAll('div[data-callout]').forEach((c) => {
    if (c.querySelector(':scope > .callout-body')) return
    const t = c.getAttribute('data-callout') || 'info'
    const body = document.createElement('div')
    body.className = 'callout-body'
    while (c.firstChild) body.appendChild(c.firstChild)
    const label = document.createElement('div')
    label.className = 'callout-label'
    label.textContent = CALLOUT_LABEL[t] || '참고'
    c.className = `callout callout-${t}`
    c.append(label, body)
  })
  box.querySelectorAll('table').forEach((t) => {
    if (t.parentElement?.classList.contains('table-wrap')) return
    t.querySelectorAll('colgroup').forEach((cg) => cg.remove())
    t.removeAttribute('style')
    const w = document.createElement('div')
    w.className = 'table-wrap'
    t.replaceWith(w)
    w.appendChild(t)
  })
  box.querySelectorAll('li[data-type="taskItem"] input').forEach((i) => i.setAttribute('disabled', ''))
  box.querySelectorAll('img[title]').forEach((img) => {
    if (img.parentElement?.tagName === 'FIGURE') return
    const fig = document.createElement('figure')
    fig.className = 'img-figure'
    const cap = document.createElement('figcaption')
    cap.textContent = img.getAttribute('title') || ''
    img.replaceWith(fig)
    fig.append(img, cap)
  })
  box.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (!/^(https?:|mailto:|#|data:)/i.test(href)) a.removeAttribute('href')
    else if (/^https?:/i.test(href)) a.setAttribute('target', '_blank')
  })
  box.querySelectorAll('script,iframe,object,embed').forEach((x) => x.remove())
  // 글자 서식: 서버(render.py text_style_css)와 같은 허용 목록 값만 남긴다
  box.querySelectorAll('span[style]').forEach((el) => {
    const st = el.getAttribute('style') || ''
    const get = (p: string) => st.match(new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim()
    const css = safeTextStyleCss({ color: cssColorToHex(get('color')), fontFamily: get('font-family'), fontSize: get('font-size') })
    if (css) el.setAttribute('style', css)
    else el.removeAttribute('style')
  })
  return { html: box.innerHTML, toc }
}

function render(doc: T.Doc) {
  let html = ''
  try {
    html = generateHTML(doc as any, EXT)
  } catch {
    fail(422, '본문 형식이 올바르지 않습니다.')
  }
  return postProcess(html)
}

function plain(n: any): string {
  if (!n) return ''
  if (n.type === 'text') return n.text || ''
  if (n.type === 'hardBreak') return ' '
  return (n.content || []).map(plain).join('')
}
function blockText(b: any): string {
  if (b.type === 'image') return `[이미지 ${(b.attrs?.src || '').slice(0, 40)}]`
  if (b.type === 'table') return (b.content || []).map((r: any) => (r.content || []).map((c: any) => plain(c).trim()).join(' | ')).join('\n')
  const parts: string[] = []
  const walk = (x: any) => {
    if (x.type === 'text') parts.push(x.text || '')
    else if (x.type === 'hardBreak') parts.push(' ')
    else {
      ;(x.content || []).forEach(walk)
      if (['paragraph', 'heading', 'listItem', 'taskItem', 'tableCell', 'tableHeader', 'codeBlock'].includes(x.type)) parts.push('\n')
    }
  }
  walk(b)
  return parts.join('').replace(/\n{2,}/g, '\n').trim()
}
const docText = (doc: T.Doc) => (doc.content || []).map(blockText).join('\n')
const toc = (html: string) => postProcess(html).toc

// LCS 기반 비교(SequenceMatcher 대용)
function opcodes(a: string[], b: string[]) {
  const n = a.length, m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: [string, number, number, number, number][] = []
  let i = 0, j = 0
  const push = (tag: string, i1: number, i2: number, j1: number, j2: number) => {
    const last = ops[ops.length - 1]
    if (last && last[0] === tag) { last[2] = i2; last[4] = j2 } else ops.push([tag, i1, i2, j1, j2])
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push('equal', i, i + 1, j, j + 1); i++; j++ }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { push('insert', i, i, j, j + 1); j++ }
    else { push('delete', i, i + 1, j, j); i++ }
  }
  // 이웃한 삭제·추가는 '바뀜'으로 묶는다
  const out: [string, number, number, number, number][] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (last && last[0] !== 'equal' && op[0] !== 'equal' && last[0] !== op[0]) {
      out[out.length - 1] = ['replace', Math.min(last[1], op[1]), Math.max(last[2], op[2]), Math.min(last[3], op[3]), Math.max(last[4], op[4])]
    } else if (last && last[0] === 'replace' && op[0] !== 'equal') {
      last[2] = Math.max(last[2], op[2]); last[4] = Math.max(last[4], op[4])
    } else out.push([...op])
  }
  return out
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function ratio(a: string, b: string) {
  if (!a && !b) return 1
  const ta = a.split(''), tb = b.split('')
  if (ta.length * tb.length > 250000) return 0.5
  let eq = 0
  opcodes(ta, tb).forEach((o) => o[0] === 'equal' && (eq += o[2] - o[1]))
  return (2 * eq) / (ta.length + tb.length)
}
function inlineDiff(a: string, b: string) {
  const tk = (s: string) => s.match(/\s+|[^\s]+/g) || []
  const ta = tk(a), tb = tk(b)
  return opcodes(ta, tb).map(([tag, i1, i2, j1, j2]) => {
    if (tag === 'equal') return esc(ta.slice(i1, i2).join(''))
    let s = ''
    if (tag === 'delete' || tag === 'replace') s += `<del>${esc(ta.slice(i1, i2).join(''))}</del>`
    if (tag === 'insert' || tag === 'replace') s += `<ins>${esc(tb.slice(j1, j2).join(''))}</ins>`
    return s
  }).join('')
}
const INL = '\u0000'
function topBlocks(doc: T.Doc) {
  const out: { type: string; level?: number; html: string; text: string; inline?: string }[] = []
  for (const b of (doc.content || []) as any[]) {
    if (['bulletList', 'orderedList', 'taskList'].includes(b.type)) {
      const start = b.attrs?.start || 1
      ;(b.content || []).forEach((li: any, i: number) => {
        const one = { type: b.type, attrs: b.type === 'orderedList' ? { start: start + i } : b.attrs, content: [li] }
        const html = render({ type: 'doc', content: [one] }).html
        const inline = b.type === 'orderedList' ? `<ol start="${start + i}"><li><p>${INL}</p></li></ol>`
          : b.type === 'taskList' ? `<ul data-type="taskList" class="task-list"><li data-type="taskItem"><label><input type="checkbox" disabled${li.attrs?.checked ? ' checked' : ''}></label><div><p>${INL}</p></div></li></ul>`
          : `<ul><li><p>${INL}</p></li></ul>`
        out.push({ type: 'li-' + b.type, html, text: blockText(li), inline })
      })
      continue
    }
    const inline = b.type === 'paragraph' ? `<p>${INL}</p>` : b.type === 'heading' ? `<h${b.attrs?.level || 2}>${INL}</h${b.attrs?.level || 2}>` : undefined
    out.push({ type: b.type, level: b.attrs?.level, html: render({ type: 'doc', content: [b] }).html, text: blockText(b), inline })
  }
  return out
}
function diffDocs(da: T.Doc, dbb: T.Doc) {
  const a = topBlocks(da), b = topBlocks(dbb)
  const key = (x: any) => `${x.type}|${x.level}|${x.text}`
  const wrap = (x: any, cls: string) => `<div class="diff-block ${cls}">${x.html}</div>`
  const out: string[] = []
  let added = 0, removed = 0, changed = 0
  for (const [tag, i1, i2, j1, j2] of opcodes(a.map(key), b.map(key))) {
    if (tag === 'equal') { b.slice(j1, j2).forEach((x) => out.push(wrap(x, 'diff-eq'))); continue }
    if (tag === 'delete') { removed += i2 - i1; a.slice(i1, i2).forEach((x) => out.push(wrap(x, 'diff-del'))); continue }
    if (tag === 'insert') { added += j2 - j1; b.slice(j1, j2).forEach((x) => out.push(wrap(x, 'diff-ins'))); continue }
    const xs = a.slice(i1, i2), ys = b.slice(j1, j2)
    const k = Math.min(xs.length, ys.length)
    for (let q = 0; q < k; q++) {
      const x = xs[q], y = ys[q]
      if (x.type === y.type && y.inline && x.level === y.level && ratio(x.text, y.text) > 0.3) {
        changed++
        out.push(`<div class="diff-block diff-mod">${y.inline.replace(INL, inlineDiff(x.text, y.text))}</div>`)
      } else { removed++; added++; out.push(wrap(x, 'diff-del'), wrap(y, 'diff-ins')) }
    }
    xs.slice(k).forEach((x) => { removed++; out.push(wrap(x, 'diff-del')) })
    ys.slice(k).forEach((y) => { added++; out.push(wrap(y, 'diff-ins')) })
  }
  return { html: out.join(''), stats: { added, removed, changed } }
}

// ------------------------------------------------------------------ 공통 처리(services.py와 같은 흐름)
function audit(u: U | null, action: string, targetType: string | null, targetId: any, deptId: number | null, detail: Row = {}) {
  T_('audit_logs').push({ id: nextId('audit_logs'), at: nowStr(), actor_id: u?.id ?? null, actor_name: u?.name ?? '시스템', action, target_type: targetType, target_id: targetId != null ? String(targetId) : null, department_id: deptId, ip: '데모', detail })
}
function notify(ids: (number | null | undefined)[], kind: string, message: string, manualId: number | null = null) {
  ;[...new Set(ids.filter(Boolean))].forEach((uid) => T_('notifications').push({ id: nextId('notifications'), user_id: uid, at: nowStr(), kind, message, manual_id: manualId, read_at: null }))
}
const deptAdminIds = (deptId: number) => T_('dept_admins').filter((x) => x.department_id === deptId && userRow(x.user_id)?.is_active).map((x) => x.user_id)
const getManual = (id: number) => {
  const m = byId('manuals', id)
  if (!m || m.deleted_at) fail(404, '매뉴얼을 찾을 수 없습니다.')
  return m!
}
const draftOf = (mid: number) => T_('manual_drafts').find((d) => d.manual_id === mid)
const pendingOf = (mid: number) => T_('approvals').find((a) => a.manual_id === mid && a.decision === 'pending')
const versionsOf = (mid: number) => T_('manual_versions').filter((v) => v.manual_id === mid)

function createVersion(m: Row, u: U, title: string, doc: T.Doc, ctype: string, reason: string) {
  const r = render(doc)
  const no = Math.max(0, ...versionsOf(m.id).map((v) => v.version_no)) + 1
  const v = { id: nextId('manual_versions'), manual_id: m.id, version_no: no, title: title.trim(), content_json: doc, content_html: r.html, change_type: ctype, change_reason: reason, created_by: u.id, created_at: nowStr(), published_at: null, published_by: null, edition_no: null }
  T_('manual_versions').push(v)
  if (m.status === 'draft') m.title = title.trim()
  T_('approvals').forEach((a) => { if (a.manual_id === m.id && a.decision === 'pending') { a.decision = 'cancelled'; a.decided_at = nowStr() } })
  Object.assign(m, { latest_version_id: v.id, review_state: 'none', updated_at: nowStr() })
  return v
}
function publishVersion(m: Row, v: Row, u: U, comment?: string) {
  const edition = (m.edition || 0) + 1
  Object.assign(v, { published_at: nowStr(), published_by: u.id, edition_no: edition })
  Object.assign(m, { published_version_id: v.id, edition, status: 'published', review_state: 'none', title: v.title, next_review_date: addMonths(today(), m.review_cycle_months || 12), updated_at: nowStr() })
  const p = pendingOf(m.id)
  let requester = null
  if (p) { Object.assign(p, { decision: 'approved', decided_by: u.id, decided_at: nowStr(), comment: comment || null, version_id: v.id }); requester = p.requested_by }
  else T_('approvals').push({ id: nextId('approvals'), manual_id: m.id, version_id: v.id, requested_by: u.id, requested_at: nowStr(), request_comment: null, decided_by: u.id, decided_at: nowStr(), decision: 'approved', comment: comment || null })
  audit(u, 'manual.publish', 'manual', m.id, m.department_id, { version_no: v.version_no, edition, comment: comment || null })
  notify([requester, m.owner_id], 'published', `'${v.title}' 제${edition}판(v${v.version_no})이 게시되었습니다.`, m.id)
  return edition
}

function summary(m: Row, workVisible = false): T.Summary {
  const d = dept(m.department_id)
  const c = m.category_id ? byId('categories', m.category_id) : null
  const o = userRow(m.owner_id)
  const pv = m.published_version_id ? byId('manual_versions', m.published_version_id) : null
  const lv = m.latest_version_id ? byId('manual_versions', m.latest_version_id) : null
  const hasWork = !!draftOf(m.id) || (m.latest_version_id != null && m.latest_version_id !== m.published_version_id)
  return {
    id: m.id, manual_no: m.manual_no, title: m.title, department_id: m.department_id, department_name: d?.name, category_id: m.category_id,
    category_name: c?.name ?? null, owner_name: o?.name ?? null, owner_active: o ? !!o.is_active : true, status: m.status, review_state: m.review_state,
    visibility: m.visibility, edition: m.edition, version_no: pv?.version_no ?? null, latest_version_no: workVisible ? lv?.version_no ?? null : null,
    published_at: pv?.published_at ?? null, updated_at: m.updated_at, next_review_date: m.next_review_date,
    review_overdue: !!(m.next_review_date && m.next_review_date < today() && m.status === 'published'), has_work: workVisible ? hasWork : false, tags: m.tags || [],
  }
}
const liveManuals = () => T_('manuals').filter((m) => !m.deleted_at)
const meOut = (u: U): T.Me => {
  const r = userRow(u.id)!
  return {
    id: u.id, username: r.username, name: r.name, position: r.position, department_id: r.department_id, department_name: dept(r.department_id)?.name ?? null,
    roles: [...u.roles].sort(), admin_depts: [...u.admin.entries()].map(([id, cs]) => ({ id, name: dept(id)?.name, can_self_publish: cs })),
    unread: T_('notifications').filter((n) => n.user_id === u.id && !n.read_at).length,
  }
}
const activeLock = (mid: number) => {
  const l = (db.locks || []).find((x: Row) => x.manual_id === mid)
  if (l && l.expires_at < Date.now()) { db.locks = db.locks.filter((x: Row) => x !== l); return null }
  return l || null
}
function ensureLock(m: Row, u: U) {
  db.locks = db.locks || []
  const l = activeLock(m.id)
  if (l && l.user_id !== u.id) fail(409, `${uname(l.user_id)} 님이 편집 중입니다.`)
  if (l) l.expires_at = Date.now() + 15 * 60000
  else db.locks.push({ manual_id: m.id, user_id: u.id, acquired_at: nowStr(), expires_at: Date.now() + 15 * 60000 })
}

function highlight(text: string, terms: string[]) {
  let out = esc(text)
  ;[...terms].sort((a, b) => b.length - a.length).forEach((t) => {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, (mm) => `<mark>${mm}</mark>`)
  })
  return out
}
function snippet(body: string, terms: string[]) {
  const low = body.toLowerCase()
  const ps = terms.map((t) => low.indexOf(t.toLowerCase())).filter((p) => p >= 0)
  if (!ps.length) return highlight(body.slice(0, 90).replace(/\n/g, ' '), terms) + (body.length > 90 ? '…' : '')
  const pos = Math.min(...ps)
  const start = Math.max(0, pos - 40), end = Math.min(body.length, pos + 40 + Math.max(...terms.map((t) => t.length)))
  return (start > 0 ? '…' : '') + highlight(body.slice(start, end).replace(/\n/g, ' '), terms) + (end < body.length ? '…' : '')
}

async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
    const scale = Math.min(1, 1200 / img.naturalWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.82)
  } catch {
    fail(422, '이미지를 읽지 못했습니다.')
    return ''
  } finally {
    URL.revokeObjectURL(url)
  }
}

function csvParse(text: string): Row[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const head = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((l) => {
    const cells = l.split(',')
    const r: Row = {}
    head.forEach((h, i) => (r[h] = (cells[i] || '').trim()))
    return r
  })
}

function afterUserChange(before: Row, afterDept: number | null, afterActive: boolean) {
  const moved = afterDept !== before.department_id
  const left = !!before.is_active && !afterActive
  if (!moved && !left) return
  db.locks = (db.locks || []).filter((l: Row) => l.user_id !== before.id)
  const reason = left ? '퇴사(비활성화)' : '전보'
  liveManuals().filter((m) => m.owner_id === before.id && m.status !== 'archived' && m.department_id === before.department_id)
    .forEach((m) => notify(deptAdminIds(m.department_id), 'owner', `담당자 재지정 필요: '${m.title}' — 담당 ${before.name} 님 ${reason}`, m.id))
}

// ------------------------------------------------------------------ API 구현
export async function createDemoApi(): Promise<Api> {
  load()
  const W = <X>(fn: () => X): Promise<X> => {
    try {
      const v = fn()
      save()
      return delay(v)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  const api: Api = {
    mode: 'demo',
    me: () => W(() => (mem.userId ? (() => { const u = loadUser(mem.userId); return u && u.is_active ? meOut(u) : null })() : null)),
    login: (username) => W(() => {
      const r = T_('users').find((x) => x.username.toLowerCase() === username.toLowerCase())
      if (!r || !r.is_active) fail(401, '아이디가 맞지 않습니다.')
      mem.userId = r!.id
      storage.set(USER_KEY, String(r!.id))
      const u = loadUser(r!.id)!
      audit(u, 'auth.login', 'user', u.id, u.department_id)
      return meOut(u)
    }),
    logout: () => W(() => { mem.userId = null; storage.del(USER_KEY) }),
    demoUsers: () => W(() => ({
      enabled: true, password_hint: '',
      users: T_('users').filter((r) => r.is_active).sort((a, b) => (dept(a.department_id)?.sort_order ?? 0) - (dept(b.department_id)?.sort_order ?? 0) || a.id - b.id).slice(0, 20).map((r) => {
        const u = loadUser(r.id)!
        return { username: r.username, name: r.name, position: r.position, department: dept(r.department_id)?.name, role: isSys(u) ? '시스템 관리자' : u.admin.size ? '부서 관리자' : '부서원' }
      }),
    })),
    changePassword: () => W(() => fail(400, '데모에는 비밀번호가 없습니다.')),
    resetDemo: async () => { storage.del(KEY); storage.del(USER_KEY); db = fresh(); mem.userId = null; save() },

    tree: () => W(() => {
      const u = cur()
      const items = liveManuals().filter((m) => m.status !== 'archived' && (can(u, 'view_published', m) || can(u, 'view_work', m))).sort((a, b) => a.manual_no.localeCompare(b.manual_no))
      return T_('departments').filter((d) => d.is_active).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((d) => {
        const wv = isSys(u) || d.id === u.department_id || u.admin.has(d.id)
        return {
          id: d.id, code: d.code, name: d.name,
          categories: T_('categories').filter((c) => c.department_id === d.id).sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ id: c.id, name: c.name })),
          manuals: items.filter((m) => m.department_id === d.id).map((m) => { const s = summary(m, wv); return { id: s.id, manual_no: s.manual_no, title: s.title, category_id: s.category_id, status: s.status, has_work: s.has_work, review_state: s.review_state } }),
        }
      })
    }),
    home: () => W(() => {
      const u = cur()
      T_('approvals').filter((a) => a.decision === 'pending' && !a.reminded_at).forEach((a) => {
        let bd = 0
        const d = new Date(a.requested_at.slice(0, 10) + 'T00:00:00'), end = new Date(today() + 'T00:00:00')
        while (d < end) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) bd++ }
        const m = byId('manuals', a.manual_id)
        if (bd >= 3 && m && !m.deleted_at) {
          notify(deptAdminIds(m.department_id), 'reminder', `게시 요청이 3영업일 넘게 처리되지 않았습니다: '${m.title}'`, m.id)
          a.reminded_at = nowStr()
        }
      })
      const vis = liveManuals().filter((m) => can(u, 'view_published', m))
      const recent = vis.filter((m) => m.status === 'published').map((m) => summary(m)).sort((a, b) => (b.published_at || '').localeCompare(a.published_at || '')).slice(0, 8)
      const favs = T_('favorites').filter((f) => f.user_id === u.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((f) => byId('manuals', f.manual_id))
        .filter((m) => m && !m.deleted_at && (can(u, 'view_published', m) || can(u, 'view_work', m))).map((m) => summary(m!, can(u, 'view_work', m)))
      const myDepts = new Set([u.department_id, ...u.admin.keys()])
      const drafts = liveManuals().filter((m) => m.status !== 'archived' && (T_('manual_drafts').some((d) => d.manual_id === m.id && d.user_id === u.id)
        || (byId('manual_versions', m.latest_version_id)?.created_by === u.id && (!m.published_version_id || m.latest_version_id !== m.published_version_id))))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 10).map((m) => summary(m, true))
      const decide = u.admin.size > 0
      const pending = T_('approvals').filter((a) => a.decision === 'pending').map((a) => ({ a, m: byId('manuals', a.manual_id)! }))
        .filter(({ a, m }) => m && !m.deleted_at && (decide ? u.admin.has(m.department_id) : a.requested_by === u.id))
        .map(({ a, m }) => ({ id: a.id, manual_id: m.id, title: m.title, manual_no: m.manual_no, department_name: dept(m.department_id)?.name, version_no: byId('manual_versions', a.version_id)?.version_no, requester: uname(a.requested_by), requested_at: a.requested_at, comment: a.request_comment }))
      const soon = addDays(30)
      const review = liveManuals().filter((m) => m.status === 'published' && myDepts.has(m.department_id) && m.next_review_date && m.next_review_date <= soon)
        .sort((a, b) => a.next_review_date.localeCompare(b.next_review_date)).slice(0, 10).map((m) => summary(m, true))
      const since = addDays(-14)
      const views: Record<number, number> = {}
      T_('view_stats').filter((v) => v.date >= since).forEach((v) => (views[v.manual_id] = (views[v.manual_id] || 0) + v.views))
      const popular = vis.filter((m) => m.status === 'published' && views[m.id]).sort((a, b) => views[b.id] - views[a.id]).slice(0, 5).map((m) => summary(m))
      return {
        recent, favorites: favs, my_drafts: drafts, pending_role: decide ? 'decide' : 'mine', pending: pending as any, review_due: review, popular,
        counts: { published: vis.filter((m) => m.status === 'published').length, my_dept: liveManuals().filter((m) => m.department_id === u.department_id && m.status === 'published').length, pending: pending.length, overdue: review.filter((m) => (m.next_review_date || '') < today()).length },
      } as T.HomeData
    }),
    templates: () => W(() => T_('templates').map((t) => ({ id: t.id, name: t.name, description: t.description, department_id: t.department_id }))),
    departments: () => W(() => T_('departments').filter((d) => d.is_active).map((d) => ({ id: d.id, code: d.code, name: d.name, approval_mode: d.approval_mode }))),
    department: (id) => W(() => {
      const u = cur()
      const d = dept(id) || fail(404, '부서를 찾을 수 없습니다.')
      const wv = can(u, 'create_manual', null, id) || isSys(u)
      let items = liveManuals().filter((m) => m.department_id === id && (can(u, 'view_published', m) || can(u, 'view_work', m))).sort((a, b) => a.manual_no.localeCompare(b.manual_no)).map((m) => summary(m, wv))
      if (!wv) items = items.filter((x) => x.status !== 'archived')
      return {
        id: d.id, code: d.code, name: d.name, approval_mode: d.approval_mode,
        categories: T_('categories').filter((c) => c.department_id === id).sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ id: c.id, name: c.name, sort_order: c.sort_order })),
        admins: T_('dept_admins').filter((x) => x.department_id === id).map((x) => userRow(x.user_id)).filter((r) => r?.is_active).map((r) => `${r!.name} ${r!.position || ''}`.trim()),
        manuals: items, perms: { create: can(u, 'create_manual', null, id), manage_categories: can(u, 'manage_categories', null, id) },
      }
    }),
    deptMembers: (id) => W(() => T_('users').filter((r) => r.department_id === id && r.is_active).map((r) => ({ id: r.id, name: r.name, position: r.position }))),
    addCategory: (deptId, name) => W(() => {
      const u = cur()
      require_(can(u, 'manage_categories', null, deptId), '업무분류는 부서 관리자만 관리할 수 있습니다.')
      const so = Math.max(0, ...T_('categories').filter((c) => c.department_id === deptId).map((c) => c.sort_order)) + 1
      const id = nextId('categories')
      T_('categories').push({ id, department_id: deptId, parent_id: null, name, sort_order: so })
      audit(u, 'category.create', 'category', id, deptId, { name })
    }),
    editCategory: (id, name) => W(() => {
      const u = cur()
      const c = byId('categories', id) || fail(404, '분류를 찾을 수 없습니다.')
      require_(can(u, 'manage_categories', null, c.department_id))
      audit(u, 'category.update', 'category', id, c.department_id, { from: c.name, to: name })
      c.name = name
    }),
    deleteCategory: (id) => W(() => {
      const u = cur()
      const c = byId('categories', id) || fail(404, '분류를 찾을 수 없습니다.')
      require_(can(u, 'manage_categories', null, c.department_id))
      if (liveManuals().some((m) => m.category_id === id)) fail(409, '이 분류에 매뉴얼이 있어 삭제할 수 없습니다.')
      db.categories = T_('categories').filter((x) => x.id !== id)
      audit(u, 'category.delete', 'category', id, c.department_id, { name: c.name })
    }),

    createManual: (body) => W(() => {
      const u = cur()
      const deptId = body.department_id || u.department_id!
      require_(can(u, 'create_manual', null, deptId), '소속 부서(또는 관리 부서)에만 매뉴얼을 만들 수 있습니다.')
      const d = dept(deptId)!
      const nums = T_('manuals').filter((m) => m.department_id === deptId).map((m) => Number(m.manual_no.split('-').pop()) || 0)
      const no = `${d.code}-${String(Math.max(0, ...nums) + 1).padStart(4, '0')}`
      const tpl = body.template_id ? byId('templates', body.template_id) : null
      const id = nextId('manuals')
      T_('manuals').push({ id, manual_no: no, title: body.title, department_id: deptId, category_id: body.category_id || null, owner_id: u.id, status: 'draft', review_state: 'none', visibility: body.visibility, published_version_id: null, latest_version_id: null, edition: 0, review_cycle_months: 12, next_review_date: null, tags: [], created_by: u.id, created_at: nowStr(), updated_at: nowStr(), deleted_at: null })
      T_('manual_drafts').push({ manual_id: id, user_id: u.id, title: body.title, content_json: tpl ? JSON.parse(JSON.stringify(tpl.content_json)) : { type: 'doc', content: [{ type: 'paragraph' }] }, saved_at: nowStr() })
      audit(u, 'manual.create', 'manual', id, deptId, { manual_no: no, title: body.title })
      return { id }
    }),
    manual: (id, view = 'published') => W(() => {
      const u = cur()
      const m = getManual(id)
      const canPub = can(u, 'view_published', m), canWork = can(u, 'view_work', m)
      if (!canPub && !canWork) fail(403, '이 매뉴얼을 열람할 권한이 없습니다.')
      if (view === 'work' && !canWork) view = 'published'
      if (view === 'published' && !canPub) view = 'work'
      let html = '', tc: T.TocItem[] = [], shown: Row | null = null
      if (view === 'published') {
        shown = byId('manual_versions', m.published_version_id)!
        html = shown.content_html
        const vs = T_('view_stats').find((v) => v.manual_id === id && v.date === today())
        if (vs) vs.views++
        else T_('view_stats').push({ manual_id: id, date: today(), views: 1 })
      } else if (m.latest_version_id) {
        shown = byId('manual_versions', m.latest_version_id)!
        html = shown.content_html
      } else {
        const dr = draftOf(id)
        if (dr) html = render(dr.content_json).html
      }
      const r = postProcess(html)
      html = r.html
      tc = r.toc
      const pv = m.published_version_id ? byId('manual_versions', m.published_version_id) : null
      const dr = canWork ? draftOf(id) : null
      const p = canWork ? pendingOf(id) : null
      const rj = canWork ? [...T_('approvals')].reverse().find((a) => a.manual_id === id && a.decision === 'rejected' && a.version_id === m.latest_version_id) : null
      const lk = activeLock(id)
      const latest = m.latest_version_id ? byId('manual_versions', m.latest_version_id) : null
      const since30 = addDays(-30)
      return {
        ...summary(m, canWork), view, can_view_published: canPub, content_html: html, toc: tc,
        shown_version_no: shown?.version_no ?? null, shown_title: shown?.title ?? m.title,
        published: pv ? { version_id: pv.id, version_no: pv.version_no, edition: pv.edition_no, published_at: pv.published_at, published_by_name: uname(pv.published_by) } : null,
        draft: dr ? { saved_at: dr.saved_at, user_name: uname(dr.user_id), mine: dr.user_id === u.id } : null,
        pending: p ? { id: p.id, version_id: p.version_id, version_no: byId('manual_versions', p.version_id)?.version_no, requester: uname(p.requested_by), requested_at: p.requested_at, comment: p.request_comment } : null,
        rejection: rj ? { comment: rj.comment, decider: uname(rj.decided_by), decided_at: rj.decided_at } : null,
        lock: lk ? { user_id: lk.user_id, user_name: uname(lk.user_id), since: lk.acquired_at } : null,
        attachments: T_('attachments').filter((a) => a.manual_id === id && a.kind !== 'image' && canWork && view === 'work').map((a) => ({ id: a.id, kind: a.kind, name: a.original_name, mime: a.mime, size: a.size, url: '#', uploaded_at: a.uploaded_at })),
        extra_department_ids: T_('manual_extra_departments').filter((x) => x.manual_id === id).map((x) => x.department_id),
        owner_id: m.owner_id, review_cycle_months: m.review_cycle_months, dept_approval_mode: dept(m.department_id)?.approval_mode,
        is_favorite: T_('favorites').some((f) => f.user_id === u.id && f.manual_id === id),
        views_30d: T_('view_stats').filter((v) => v.manual_id === id && v.date >= since30).reduce((s, v) => s + v.views, 0),
        perms: {
          view_work: canWork, edit: can(u, 'edit', m), request_publish: can(u, 'request_publish', m), publish: can(u, 'publish', m, null, latest),
          publish_any: can(u, 'publish', m), reject: can(u, 'reject', m), manage: can(u, 'manage', m), force_unlock: can(u, 'force_unlock', m),
        },
      } as T.ManualDetail
    }),
    updateMeta: (id, body) => W(() => {
      const u = cur()
      const m = getManual(id)
      const manageFields = ['owner_id', 'visibility', 'extra_department_ids', 'review_cycle_months', 'next_review_date', 'category_id']
      if (manageFields.some((k) => k in body)) require_(can(u, 'manage', m), '담당자·열람 범위·검토 주기·분류는 부서 관리자만 바꿀 수 있습니다.')
      else require_(can(u, 'edit', m))
      const changes: Row = {}
      if (body.category_id !== undefined) { m.category_id = body.category_id; changes.category_id = body.category_id }
      if (body.owner_id) {
        const o = userRow(body.owner_id)
        if (!o || !o.is_active || o.department_id !== m.department_id) fail(422, '담당자는 같은 부서의 재직자여야 합니다.')
        m.owner_id = body.owner_id; changes.owner = o!.name
      }
      if (body.visibility) { m.visibility = body.visibility; changes.visibility = body.visibility }
      if (body.extra_department_ids) {
        db.manual_extra_departments = T_('manual_extra_departments').filter((x) => x.manual_id !== id)
        ;[...new Set(body.extra_department_ids as number[])].filter((d) => d !== m.department_id).forEach((d) => T_('manual_extra_departments').push({ manual_id: id, department_id: d }))
        changes.extra_departments = body.extra_department_ids
      }
      if (body.tags) { m.tags = [...new Set((body.tags as string[]).map((t) => t.replace(/\s+/g, '').slice(0, 20)).filter(Boolean))].slice(0, 15); changes.tags = m.tags }
      if (body.review_cycle_months) { m.review_cycle_months = body.review_cycle_months; changes.review_cycle_months = body.review_cycle_months }
      if (body.next_review_date) { m.next_review_date = body.next_review_date; changes.next_review_date = body.next_review_date }
      m.updated_at = nowStr()
      audit(u, 'manual.update_meta', 'manual', id, m.department_id, changes)
    }),
    toggleFavorite: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'view_published', m) || can(u, 'view_work', m))
      const ex = T_('favorites').find((f) => f.user_id === u.id && f.manual_id === id)
      if (ex) { db.favorites = T_('favorites').filter((f) => f !== ex); return { favorite: false } }
      T_('favorites').push({ user_id: u.id, manual_id: id, created_at: nowStr() })
      return { favorite: true }
    }),
    archive: (id, comment) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'manage', m), '폐기는 부서 관리자만 할 수 있습니다.')
      m.status = 'archived'; m.review_state = 'none'; m.updated_at = nowStr()
      T_('approvals').forEach((a) => { if (a.manual_id === id && a.decision === 'pending') a.decision = 'cancelled' })
      audit(u, 'manual.archive', 'manual', id, m.department_id, { reason: comment })
    }),
    unarchive: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'unarchive', m), '폐기 해제는 부서 관리자만 할 수 있습니다.')
      m.status = m.published_version_id ? 'published' : 'draft'
      audit(u, 'manual.unarchive', 'manual', id, m.department_id)
    }),
    deleteManual: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      if (m.published_version_id) fail(409, '게시된 적 있는 매뉴얼은 삭제하지 않고 폐기합니다.')
      require_(can(u, 'manage', m) || (m.created_by === u.id && can(u, 'edit', m)))
      m.deleted_at = nowStr()
      audit(u, 'manual.delete', 'manual', id, m.department_id, { title: m.title })
    }),

    lock: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m), '이 매뉴얼을 편집할 권한이 없습니다.')
      const l = activeLock(id)
      if (l && l.user_id !== u.id) return { ok: false, holder: { user_name: uname(l.user_id)!, since: l.acquired_at } }
      ensureLock(m, u)
      return { ok: true }
    }),
    unlock: (id, force) => W(() => {
      const u = cur()
      const m = getManual(id)
      const l = activeLock(id)
      if (!l) return
      if (l.user_id === u.id) { db.locks = db.locks.filter((x: Row) => x !== l); return }
      if (force) {
        require_(can(u, 'force_unlock', m), '편집 잠금 강제 해제는 부서 관리자만 할 수 있습니다.')
        db.locks = db.locks.filter((x: Row) => x !== l)
        audit(u, 'manual.force_unlock', 'manual', id, m.department_id, { holder: uname(l.user_id) })
        notify([l.user_id], 'unlock', `${u.name} 님이 '${m.title}' 편집 잠금을 해제했습니다.`, id)
        return
      }
      fail(409, '다른 사용자의 잠금입니다.')
    }),
    workContent: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m), '이 매뉴얼을 편집할 권한이 없습니다.')
      const dr = draftOf(id)
      const latest = m.latest_version_id ? byId('manual_versions', m.latest_version_id) : null
      if (dr) return { title: dr.title, content_json: JSON.parse(JSON.stringify(dr.content_json)), source: 'draft', draft_saved_at: dr.saved_at, draft_user_name: uname(dr.user_id), base_version_no: latest?.version_no ?? null }
      if (latest) return { title: latest.title, content_json: JSON.parse(JSON.stringify(latest.content_json)), source: 'version', draft_saved_at: null, draft_user_name: null, base_version_no: latest.version_no }
      return { title: m.title, content_json: { type: 'doc', content: [{ type: 'paragraph' }] }, source: 'empty', draft_saved_at: null, draft_user_name: null, base_version_no: null } as T.WorkContent
    }),
    saveDraft: (id, title, content) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m))
      ensureLock(m, u)
      const t = nowStr()
      const ex = draftOf(id)
      if (ex) Object.assign(ex, { user_id: u.id, title, content_json: content, saved_at: t })
      else T_('manual_drafts').push({ manual_id: id, user_id: u.id, title, content_json: content, saved_at: t })
      return { saved_at: t }
    }),
    discardDraft: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m))
      const dr = draftOf(id)
      if (!dr) return
      if (dr.user_id !== u.id && !can(u, 'manage', m)) fail(403, '다른 사람의 작성 중 내용은 부서 관리자만 폐기할 수 있습니다.')
      if (!m.latest_version_id) fail(409, '아직 저장된 버전이 없는 새 매뉴얼입니다. 매뉴얼을 삭제하세요.')
      db.manual_drafts = T_('manual_drafts').filter((d) => d !== dr)
      audit(u, 'manual.discard_draft', 'manual', id, m.department_id)
    }),
    saveVersion: (id, body) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m))
      ensureLock(m, u)
      const v = createVersion(m, u, body.title, body.content_json, body.change_type, body.change_reason)
      db.manual_drafts = T_('manual_drafts').filter((d) => d.manual_id !== id)
      audit(u, 'manual.save_version', 'manual', id, m.department_id, { version_no: v.version_no, change_type: body.change_type, reason: body.change_reason })
      return { version_id: v.id, version_no: v.version_no }
    }),
    versions: (id) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'view_work', m), '버전 이력은 담당 부서만 볼 수 있습니다.')
      const dr = draftOf(id)
      return {
        manual: { id: m.id, title: m.title, manual_no: m.manual_no, department_id: m.department_id, published_version_id: m.published_version_id, latest_version_id: m.latest_version_id },
        draft: dr ? { saved_at: dr.saved_at, user_name: uname(dr.user_id)! } : null,
        versions: versionsOf(id).sort((a, b) => b.version_no - a.version_no).map((v) => ({
          id: v.id, version_no: v.version_no, title: v.title, change_type: v.change_type, change_reason: v.change_reason, created_at: v.created_at, published_at: v.published_at,
          edition_no: v.edition_no, author: uname(v.created_by), publisher: uname(v.published_by), is_published: v.id === m.published_version_id, is_latest: v.id === m.latest_version_id,
        })),
        perms: { edit: can(u, 'edit', m) },
      }
    }),
    version: (id, vid) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'view_work', m) || (vid === m.published_version_id && can(u, 'view_published', m)))
      const v = byId('manual_versions', vid)
      if (!v || v.manual_id !== id) fail(404, '버전을 찾을 수 없습니다.')
      const r = postProcess(v!.content_html)
      return { id: v!.id, version_no: v!.version_no, title: v!.title, html: r.html, toc: r.toc, created_at: v!.created_at, author: uname(v!.created_by), change_type: v!.change_type, change_reason: v!.change_reason, edition_no: v!.edition_no, published_at: v!.published_at }
    }),
    diff: (id, a, b) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'view_work', m), '버전 비교는 담당 부서만 할 수 있습니다.')
      const get = (ref: string): [T.Doc, string] => {
        if (ref === 'draft') { const d = draftOf(id) || fail(404, '작성 중인 내용이 없습니다.'); return [d.content_json, `작성 중(${d.saved_at.slice(5, 16)})`] }
        const v = byId('manual_versions', Number(ref))
        if (!v || v.manual_id !== id) fail(404, '버전을 찾을 수 없습니다.')
        return [v!.content_json, `v${v!.version_no}${v!.edition_no ? ` · 제${v!.edition_no}판` : ''}`]
      }
      const [da, la] = get(a), [dbb, lb] = get(b)
      return { from_label: la, to_label: lb, ...diffDocs(da, dbb) }
    }),
    restore: (id, vid) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m))
      if (draftOf(id)) fail(409, '작성 중인 내용이 있습니다. 편집 화면에서 저장하거나 폐기한 뒤 복원하세요.')
      const l = activeLock(id)
      if (l && l.user_id !== u.id) fail(409, `${uname(l.user_id)} 님이 편집 중이라 복원할 수 없습니다.`)
      const v = byId('manual_versions', vid) || fail(404, '버전을 찾을 수 없습니다.')
      const nv = createVersion(m, u, v.title, JSON.parse(JSON.stringify(v.content_json)), '복원', `v${v.version_no}에서 복원`)
      audit(u, 'manual.restore', 'manual', id, m.department_id, { from_version: v.version_no, new_version: nv.version_no })
      return { version_no: nv.version_no }
    }),
    requestPublish: (id, comment) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'request_publish', m))
      if (draftOf(id)) fail(409, "저장하지 않은 작성 중 내용이 있습니다. 먼저 '저장'으로 버전을 만든 뒤 요청하세요.")
      if (!m.latest_version_id || m.latest_version_id === m.published_version_id) fail(409, '게시할 새 버전이 없습니다.')
      if (pendingOf(id)) fail(409, '이미 게시 요청 중입니다.')
      const v = byId('manual_versions', m.latest_version_id)!
      T_('approvals').push({ id: nextId('approvals'), manual_id: id, version_id: v.id, requested_by: u.id, requested_at: nowStr(), request_comment: comment || null, decided_by: null, decided_at: null, decision: 'pending', comment: null })
      m.review_state = 'in_review'; m.updated_at = nowStr()
      audit(u, 'manual.request_publish', 'manual', id, m.department_id, { version_no: v.version_no, comment: comment || null })
      notify(deptAdminIds(m.department_id), 'request', `${u.name} 님이 '${v.title}' v${v.version_no} 게시를 요청했습니다.`, id)
    }),
    publish: (id, comment) => W(() => {
      const u = cur()
      const m = getManual(id)
      if (!m.latest_version_id || m.latest_version_id === m.published_version_id) fail(409, '게시할 새 버전이 없습니다.')
      const v = byId('manual_versions', m.latest_version_id)!
      if (!can(u, 'publish', m, null, v)) {
        if (can(u, 'publish', m)) fail(403, '이 부서는 직무 분리 설정으로 본인이 만든 버전을 직접 게시할 수 없습니다.')
        fail(403, "게시 권한이 없습니다. '게시 요청'을 이용하세요.")
      }
      return { edition: publishVersion(m, v, u, comment), version_no: v.version_no }
    }),
    reject: (id, comment) => W(() => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'reject', m), '반려는 부서 관리자만 할 수 있습니다.')
      if (!comment?.trim()) fail(422, '반려 사유를 입력하세요.')
      const p = pendingOf(id) || fail(409, '처리할 게시 요청이 없습니다.')
      Object.assign(p, { decision: 'rejected', decided_by: u.id, decided_at: nowStr(), comment })
      m.review_state = 'none'
      const v = byId('manual_versions', p.version_id)!
      audit(u, 'manual.reject', 'manual', id, m.department_id, { version_no: v.version_no, comment })
      notify([p.requested_by], 'rejected', `'${m.title}' v${v.version_no} 게시 요청이 반려되었습니다: ${comment}`, id)
    }),
    upload: async (id, file) => {
      const u = cur()
      const m = getManual(id)
      require_(can(u, 'edit', m), '이 매뉴얼에 파일을 올릴 권한이 없습니다.')
      if (file.size > 20 * 1024 * 1024) fail(413, '파일은 20MB까지 올릴 수 있습니다.')
      const isImg = /^image\/(png|jpe?g|gif|webp)$/.test(file.type)
      const url = isImg ? await shrinkImage(file) : '#'
      const aid = nextId('attachments')
      T_('attachments').push({ id: aid, manual_id: id, kind: isImg ? 'image' : 'file', original_name: file.name, mime: file.type, size: file.size, uploaded_at: nowStr() })
      audit(u, 'attachment.upload', 'manual', id, m.department_id, { attachment_id: aid, name: file.name, size: file.size })
      save()
      return { id: aid, kind: isImg ? 'image' : 'file', name: file.name, mime: file.type, size: file.size, url }
    },
    importDocx: async () => fail(400, 'DOCX 가져오기는 PC에 설치한 버전(서버)에서 동작합니다.'),

    search: (q, o = {}) => W(() => {
      const deptId = o.dept, work = o.work, catId = o.cat
      const sinceDays = ({ '1m': 30, '6m': 182, '1y': 365 } as Record<string, number>)[o.period || '']
      const since = sinceDays ? addDays(-sinceDays) : null
      const u = cur()
      const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 5)
      if (!terms.length) return { results: [], total: 0 }
      const textOf = (vid: number | null) => { const v = vid ? byId('manual_versions', vid) : null; return v ? { title: v.title as string, body: docText(v.content_json) } : null }
      const cand: { m: Row; scope: 'published' | 'work'; title: string; body: string }[] = []
      liveManuals().filter((m) => m.status !== 'archived' && (!deptId || m.department_id === deptId) && (!catId || m.category_id === catId)).forEach((m) => {
        const wk = work && can(u, 'view_work', m) && m.latest_version_id
        if (wk && (m.latest_version_id !== m.published_version_id || !m.published_version_id)) {
          const t = textOf(m.latest_version_id)
          if (t) return cand.push({ m, scope: 'work', ...t })
        }
        if (can(u, 'view_published', m)) {
          const t = textOf(m.published_version_id)
          if (t) cand.push({ m, scope: 'published', ...t })
        }
      })
      const out: T.SearchResult[] = []
      for (const c of cand) {
        const tags = (c.m.tags || []).join(' ').toLowerCase()
        let ok = true, score = 0
        for (const t of terms) {
          const tl = t.toLowerCase()
          const inT = c.title.toLowerCase().includes(tl), inG = tags.includes(tl), inB = c.body.toLowerCase().includes(tl)
          if (!inT && !inG && !inB) { ok = false; break }
          if (inT) score += 100
          if (inG) score += 30
          if (inB) score += 5 + Math.min(c.body.toLowerCase().split(tl).length - 1, 10)
        }
        if (!ok) continue
        const sm = summary(c.m, c.scope === 'work')
        const when = c.scope === 'published' ? sm.published_at : byId('manual_versions', c.m.latest_version_id)?.created_at
        if (since && (when || '') < since) continue
        out.push({ ...sm, scope: c.scope, score, title_html: highlight(c.title, terms), snippet_html: snippet(c.body, terms) })
      }
      out.sort((a, b) => b.score - a.score || (b.published_at || '').localeCompare(a.published_at || ''))
      T_('search_logs').push({ id: nextId('search_logs'), at: nowStr(), user_id: u.id, query: q.trim(), result_count: out.length })
      return { results: out.slice(0, 50), total: Math.min(out.length, 50) }
    }),
    notifications: () => W(() => {
      const u = cur()
      const items = T_('notifications').filter((n) => n.user_id === u.id).sort((a, b) => b.id - a.id).slice(0, 30)
      return { items: items as T.Notification[], unread: items.filter((n) => !n.read_at).length }
    }),
    readNotifications: () => W(() => { const u = cur(); T_('notifications').forEach((n) => { if (n.user_id === u.id && !n.read_at) n.read_at = nowStr() }) }),

    adminOverview: () => W(() => {
      const u = cur()
      if (!(isSys(u) || u.admin.size || u.roles.has('auditor'))) fail(403, '관리자 화면 권한이 없습니다.')
      const depts = T_('departments').filter((d) => isSys(u) || u.admin.has(d.id)).sort((a, b) => a.sort_order - b.sort_order)
      const by = depts.map((d) => {
        const ms = liveManuals().filter((m) => m.department_id === d.id)
        return {
          id: d.id, code: d.code, name: d.name, approval_mode: d.approval_mode, is_active: !!d.is_active,
          published: ms.filter((m) => m.status === 'published').length, drafts: ms.filter((m) => m.status === 'draft').length,
          pending: ms.filter((m) => m.review_state === 'in_review').length, overdue: ms.filter((m) => m.status === 'published' && m.next_review_date && m.next_review_date < today()).length,
          archived: ms.filter((m) => m.status === 'archived').length,
          admins: T_('dept_admins').filter((x) => x.department_id === d.id).map((x) => userRow(x.user_id)).filter((r) => r?.is_active).map((r) => r!.name),
          members: T_('users').filter((r) => r.department_id === d.id && r.is_active).length,
        }
      })
      const zero: Record<string, { query: string; n: number; last_at: string }> = {}
      if (isSys(u)) T_('search_logs').filter((s) => s.result_count === 0).forEach((s) => { const z = zero[s.query] || (zero[s.query] = { query: s.query, n: 0, last_at: s.at }); z.n++; if (s.at > z.last_at) z.last_at = s.at })
      const w7 = addDays(-7)
      return {
        counts: {
          users: isSys(u) ? T_('users').filter((r) => r.is_active).length : null,
          published: by.reduce((s, x) => s + x.published, 0), drafts: by.reduce((s, x) => s + x.drafts, 0), pending: by.reduce((s, x) => s + x.pending, 0), overdue: by.reduce((s, x) => s + x.overdue, 0),
          searches_7d: T_('search_logs').filter((s) => s.at >= w7).length, views_7d: T_('view_stats').filter((v) => v.date >= w7).reduce((s, v) => s + v.views, 0),
        },
        by_dept: by, zero_searches: Object.values(zero).sort((a, b) => b.n - a.n).slice(0, 10),
        roles: { sys_admin: isSys(u), auditor: u.roles.has('auditor'), dept_admin: u.admin.size > 0 },
      }
    }),
    adminApprovals: () => W(() => {
      const u = cur()
      if (!(isSys(u) || u.admin.size || u.roles.has('auditor'))) fail(403, '관리자 화면 권한이 없습니다.')
      const rows = T_('approvals').map((a) => ({ a, m: byId('manuals', a.manual_id)!, v: byId('manual_versions', a.version_id)! })).filter(({ m }) => m && !m.deleted_at && (isSys(u) || u.admin.has(m.department_id)))
      const row = ({ a, m, v }: any) => ({ id: a.id, manual_id: m.id, title: m.title, manual_no: m.manual_no, department_name: dept(m.department_id)?.name, version_no: v?.version_no, change_type: v?.change_type, change_reason: v?.change_reason, requester: uname(a.requested_by), requested_at: a.requested_at, request_comment: a.request_comment, decision: a.decision, decider: uname(a.decided_by), decided_at: a.decided_at, comment: a.comment, can_decide: u.admin.has(m.department_id) })
      return {
        pending: rows.filter((r) => r.a.decision === 'pending').sort((x, y) => x.a.requested_at.localeCompare(y.a.requested_at)).map(row),
        done: rows.filter((r) => ['approved', 'rejected'].includes(r.a.decision)).sort((x, y) => (y.a.decided_at || '').localeCompare(x.a.decided_at || '')).slice(0, 30).map(row),
      }
    }),
    adminReviews: () => W(() => {
      const u = cur()
      const scope = (m: Row) => isSys(u) || u.admin.has(m.department_id)
      const soon = addDays(60)
      return {
        due: liveManuals().filter((m) => scope(m) && m.status === 'published' && m.next_review_date && m.next_review_date <= soon).sort((a, b) => a.next_review_date.localeCompare(b.next_review_date)).map((m) => summary(m, true)),
        orphans: liveManuals().filter((m) => { const o = userRow(m.owner_id); return scope(m) && m.status !== 'archived' && (!o || !o.is_active || o.department_id !== m.department_id) }).map((m) => summary(m, true)),
      }
    }),
    adminUsers: (q, deptId) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      return T_('users').filter((r) => (!q || [r.name, r.username, r.employee_no].some((x) => x.includes(q))) && (!deptId || r.department_id === deptId))
        .sort((a, b) => b.is_active - a.is_active || a.employee_no.localeCompare(b.employee_no))
        .map((r) => ({ ...r, dept_name: dept(r.department_id)?.name ?? null, roles: T_('system_roles').filter((x) => x.user_id === r.id).map((x) => x.role), admin_of: T_('dept_admins').filter((x) => x.user_id === r.id).map((x) => dept(x.department_id)?.name) })) as T.AdminUser[]
    }),
    createUser: (body) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      if (T_('users').some((r) => r.employee_no === body.employee_no || r.username.toLowerCase() === String(body.username).toLowerCase())) fail(409, '같은 사번 또는 아이디가 이미 있습니다.')
      if (!body.employee_no || !body.username || !body.name) fail(422, '사번·아이디·이름을 입력하세요.')
      const id = nextId('users')
      T_('users').push({ id, employee_no: body.employee_no, username: body.username, name: body.name, email: body.email, position: body.position, department_id: body.department_id, is_active: 1, is_local_admin: 0, created_at: nowStr() })
      audit(u, 'user.create', 'user', id, body.department_id, { name: body.name, employee_no: body.employee_no })
    }),
    patchUser: (id, body) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      const r = userRow(id) || fail(404, '사용자를 찾을 수 없습니다.')
      if (id === u.id && body.is_active === false) fail(409, '본인 계정은 비활성화할 수 없습니다.')
      const before = { ...r }
      ;['name', 'position', 'email', 'department_id'].forEach((k) => { if (body[k] != null) r[k] = body[k] })
      if (body.is_active != null) r.is_active = body.is_active ? 1 : 0
      if (body.roles) {
        if (id === u.id && !body.roles.includes('sys_admin')) fail(409, '본인의 시스템 관리자 역할은 해제할 수 없습니다.')
        db.system_roles = T_('system_roles').filter((x) => x.user_id !== id)
        body.roles.forEach((role: string) => T_('system_roles').push({ user_id: id, role }))
      }
      afterUserChange(before, r.department_id, !!r.is_active)
      audit(u, 'user.update', 'user', id, r.department_id, body)
    }),
    resetPassword: () => W(() => fail(400, '데모에는 비밀번호가 없습니다.')),
    adminDepartments: () => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      return T_('departments').sort((a, b) => a.sort_order - b.sort_order).map((d) => ({
        ...d, admins: T_('dept_admins').filter((x) => x.department_id === d.id).map((x) => ({ id: x.user_id, name: uname(x.user_id), position: userRow(x.user_id)?.position, can_self_publish: x.can_self_publish })),
        members: T_('users').filter((r) => r.department_id === d.id && r.is_active).length,
      })) as T.AdminDept[]
    }),
    createDept: (body) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      const code = (body.code || '').trim(), name = (body.name || '').trim()
      if (!/^[1-9][0-9]{3}$/.test(code)) fail(422, '부서 코드는 4자리 숫자입니다(1000~9999).')
      if (!name) fail(422, '부서 이름을 입력하세요.')
      if (T_('departments').some((d) => d.code === code)) fail(409, '같은 부서 코드가 있습니다.')
      if (T_('departments').some((d) => d.name === name)) fail(409, '같은 이름의 부서가 있습니다.')
      const id = nextId('departments')
      T_('departments').push({ id, code, name, approval_mode: 'required', is_active: 1, sort_order: Math.max(0, ...T_('departments').map((d) => d.sort_order)) + 1 })
      audit(u, 'dept.create', 'department', id, id, { code, name, approval_mode: 'required' })
    }),
    patchDept: (id, body) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      const d = dept(id) || fail(404, '부서를 찾을 수 없습니다.')
      const data: Record<string, any> = {}
      if (body.approval_mode !== undefined) {
        if (!['required', 'skip'].includes(body.approval_mode)) fail(422, '승인 설정이 올바르지 않습니다.')
        data.approval_mode = d.approval_mode = body.approval_mode
      }
      if (body.name !== undefined && body.name !== null) {
        const name = String(body.name).trim()
        if (!name) fail(422, '부서 이름을 입력하세요.')
        if (T_('departments').some((x) => x.name === name && x.id !== id)) fail(409, '같은 이름의 부서가 있습니다.')
        Object.assign(data, { name, from_name: d.name })
        d.name = name
      }
      if (body.is_active !== undefined && body.is_active !== null) data.is_active = d.is_active = body.is_active ? 1 : 0
      audit(u, 'dept.update', 'department', id, id, data)
    }),
    setDeptAdmin: (deptId, userId, cs) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      const ex = T_('dept_admins').find((x) => x.department_id === deptId && x.user_id === userId)
      if (ex) ex.can_self_publish = cs ? 1 : 0
      else T_('dept_admins').push({ department_id: deptId, user_id: userId, can_self_publish: cs ? 1 : 0 })
      audit(u, 'dept.admin_assign', 'department', deptId, deptId, { user: uname(userId), can_self_publish: cs })
      notify([userId], 'role', '부서 관리자로 지명되었습니다. 게시 대기 목록을 확인해 주세요.')
    }),
    removeDeptAdmin: (deptId, userId) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      db.dept_admins = T_('dept_admins').filter((x) => !(x.department_id === deptId && x.user_id === userId))
      audit(u, 'dept.admin_remove', 'department', deptId, deptId, { user: uname(userId) })
    }),
    moveManuals: (deptId, targetId) => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      if (deptId === targetId) fail(422, '같은 부서로는 옮길 수 없습니다.')
      const src = dept(deptId) || fail(404, '부서를 찾을 수 없습니다.'), dst = dept(targetId) || fail(404, '부서를 찾을 수 없습니다.')
      const map: Record<number, number> = {}
      T_('categories').filter((c) => c.department_id === deptId).forEach((c) => {
        const ex = T_('categories').find((x) => x.department_id === targetId && x.name === c.name)
        if (ex) map[c.id] = ex.id
        else {
          const id = nextId('categories')
          T_('categories').push({ id, department_id: targetId, parent_id: null, name: c.name, sort_order: Math.max(0, ...T_('categories').filter((x) => x.department_id === targetId).map((x) => x.sort_order)) + 1 })
          map[c.id] = id
        }
      })
      const ms = liveManuals().filter((m) => m.department_id === deptId)
      ms.forEach((m) => { m.department_id = targetId; m.category_id = m.category_id ? map[m.category_id] ?? null : null; m.updated_at = nowStr() })
      db.manual_extra_departments = T_('manual_extra_departments').filter((x) => !(ms.some((m) => m.id === x.manual_id) && x.department_id === targetId))
      audit(u, 'dept.move_manuals', 'department', deptId, targetId, { from: src.name, to: dst.name, count: ms.length })
      notify(deptAdminIds(targetId), 'owner', `${src.name} 매뉴얼 ${ms.length}건을 ${dst.name}에 옮겼습니다. 담당자를 확인해 주세요.`)
      return { moved: ms.length }
    }),
    hrSync: async (file, mode, force) => {
      const u = cur()
      require_(can(u, 'admin'))
      const rows = csvParse(await file.text())
      if (!rows.length || !('employee_no' in rows[0]) || !('department_code' in rows[0])) fail(422, 'CSV 머리행에 employee_no, name, department_code가 있어야 합니다.')
      const codes: Record<string, number> = {}
      T_('departments').forEach((d) => (codes[d.code] = d.id))
      const byNo: Record<string, Row> = {}
      T_('users').forEach((r) => (byNo[r.employee_no] = r))
      const seen = new Set<string>()
      const create: any[] = [], update: any[] = [], deactivate: any[] = [], errors: string[] = []
      rows.forEach((r, i) => {
        const no = r.employee_no
        if (!no) return errors.push(`${i + 2}행: 사번이 비어 있습니다.`)
        if (seen.has(no)) return errors.push(`${i + 2}행: 사번 ${no}이 중복됩니다.`)
        seen.add(no)
        if (!(r.department_code in codes)) return errors.push(`${i + 2}행: 부서 코드 '${r.department_code}'가 없습니다.`)
        const active = !['0', 'N', 'n', 'false', '퇴사'].includes(r.is_active ?? '1')
        const c = byNo[no]
        if (!c) { if (active) create.push({ employee_no: no, name: r.name, department_code: r.department_code, position: r.position || null, email: r.email || null }); return }
        const ch: Row = {}
        if (r.name && r.name !== c.name) ch.name = r.name
        if (codes[r.department_code] !== c.department_id) ch.department_code = r.department_code
        if (r.position && r.position !== c.position) ch.position = r.position
        if (!active && c.is_active) deactivate.push({ employee_no: no, name: c.name, reason: '인사 파일에 퇴사로 표시' })
        else if (active && !c.is_active) ch.is_active = true
        if (Object.keys(ch).length) update.push({ employee_no: no, name: c.name, changes: ch })
      })
      T_('users').forEach((c) => { if (!seen.has(c.employee_no) && c.is_active && !c.is_local_admin) deactivate.push({ employee_no: c.employee_no, name: c.name, reason: '인사 파일에 없음' }) })
      const activeTotal = T_('users').filter((c) => c.is_active).length || 1
      const ratio = deactivate.length / activeTotal
      const blocked = ratio > 0.05
      const prev: T.HrPreview = { create, update, deactivate, errors, blocked, ratio: Math.round(ratio * 1000) / 10, threshold: 5, applied: false }
      if (mode !== 'apply') return prev
      if (errors.length) fail(422, '오류가 있는 행을 고친 뒤 적용하세요.')
      const runId = nextId('hr_sync_runs')
      if (blocked && !force) {
        T_('hr_sync_runs').push({ id: runId, started_at: nowStr(), finished_at: nowStr(), run_by: u.id, created: 0, updated: 0, deactivated: deactivate.length, status: 'blocked', error: `비활성화 ${prev.ratio}%가 기준 5%를 넘어 중단` })
        audit(u, 'hr_sync.blocked', 'hr_sync', runId, null, { deactivate: deactivate.length, ratio: prev.ratio })
        save()
        fail(409, `비활성화 대상이 ${prev.ratio}%로 기준(5%)을 넘어 적용을 멈췄습니다.`)
      }
      create.forEach((c) => T_('users').push({ id: nextId('users'), employee_no: c.employee_no, username: c.employee_no.toLowerCase(), name: c.name, email: c.email, position: c.position, department_id: codes[c.department_code], is_active: 1, is_local_admin: 0, created_at: nowStr() }))
      update.forEach((up) => {
        const r = byNo[up.employee_no], before = { ...r }
        if (up.changes.name) r.name = up.changes.name
        if (up.changes.position) r.position = up.changes.position
        if (up.changes.department_code) r.department_id = codes[up.changes.department_code]
        if (up.changes.is_active) r.is_active = 1
        afterUserChange(before, r.department_id, !!r.is_active)
      })
      deactivate.forEach((d) => { const r = byNo[d.employee_no], before = { ...r }; r.is_active = 0; afterUserChange(before, r.department_id, false) })
      T_('hr_sync_runs').push({ id: runId, started_at: nowStr(), finished_at: nowStr(), run_by: u.id, created: create.length, updated: update.length, deactivated: deactivate.length, status: blocked ? 'applied_forced' : 'applied', error: null })
      audit(u, 'hr_sync.apply', 'hr_sync', runId, null, { created: create.length, updated: update.length, deactivated: deactivate.length, forced: blocked })
      save()
      return { ...prev, applied: true }
    },
    hrRuns: () => W(() => { const u = cur(); require_(can(u, 'admin')); return T_('hr_sync_runs').sort((a, b) => b.id - a.id).slice(0, 20).map((r) => ({ ...r, run_by_name: uname(r.run_by) || '예약 작업' })) as T.HrRun[] }),
    audit: (p) => W(() => {
      const u = cur()
      let scope: Set<number> | null = null
      if (!u.roles.has('auditor')) { if (!u.admin.size) fail(403, '감사 로그 조회 권한이 없습니다.'); scope = new Set(u.admin.keys()) }
      let rows = T_('audit_logs').filter((r) => !scope || (scope.has(r.department_id) && ['manual', 'category'].includes(r.target_type)))
      if (p.action) rows = rows.filter((r) => r.action.startsWith(p.action!))
      if (p.q) rows = rows.filter((r) => (r.actor_name || '').includes(p.q!) || JSON.stringify(r.detail).includes(p.q!) || r.target_id === p.q)
      rows = [...rows].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
      const off = p.offset || 0
      return {
        total: rows.length, scope: scope ? 'dept' : 'all',
        items: rows.slice(off, off + 50).map((r) => { const m = r.target_type === 'manual' ? byId('manuals', Number(r.target_id)) : null; return { ...r, target_label: m ? `${m.manual_no} ${m.title}` : null } }) as T.AuditRow[],
      }
    }),
    searchLogs: () => W(() => {
      const u = cur()
      require_(can(u, 'admin'))
      const agg = (rows: Row[]) => {
        const g: Record<string, { query: string; n: number; last_at: string }> = {}
        rows.forEach((s) => { const z = g[s.query] || (g[s.query] = { query: s.query, n: 0, last_at: s.at }); z.n++; if (s.at > z.last_at) z.last_at = s.at })
        return Object.values(g).sort((a, b) => b.n - a.n)
      }
      return { zero: agg(T_('search_logs').filter((s) => s.result_count === 0)).slice(0, 50), top: agg(T_('search_logs')).slice(0, 20) }
    }),
  }
  return api
}
