import { Api, ApiError } from './client'

async function req<T>(method: string, path: string, body?: any, opts: { keepalive?: boolean; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-WorkWiki': '1' }
  let payload: BodyInit | undefined
  if (opts.form) payload = opts.form
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', keepalive: opts.keepalive })
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다. 네트워크를 확인하세요.')
  }
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith('/auth/me') && !path.endsWith('/auth/login')) window.dispatchEvent(new Event('ww:unauthorized'))
    let msg = `요청을 처리하지 못했습니다(${res.status}).`
    try {
      const j = await res.json()
      if (j.detail) msg = typeof j.detail === 'string' ? j.detail : msg
    } catch {}
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const qs = (o: Record<string, any>) => {
  const p = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && p.set(k, String(v)))
  const s = p.toString()
  return s ? `?${s}` : ''
}

const file = (f: File, extra: Record<string, string> = {}) => {
  const fd = new FormData()
  fd.append('file', f)
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v))
  return fd
}

function filenameOf(res: Response, fallback: string) {
  const cd = res.headers.get('content-disposition') || ''
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i)
  try {
    return m ? decodeURIComponent(m[1]) : fallback
  } catch {
    return fallback
  }
}

export const httpApi: Api = {
  mode: 'server',
  async me() {
    try {
      return await req('GET', '/api/auth/me')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  login: (username, password) => req('POST', '/api/auth/login', { username, password }),
  logout: () => req('POST', '/api/auth/logout'),
  demoUsers: () => req('GET', '/api/auth/demo-users'),
  changePassword: (current, next) => req('POST', '/api/auth/change-password', { current, new: next }),
  tree: () => req('GET', '/api/tree'),
  home: () => req('GET', '/api/home'),
  templates: () => req('GET', '/api/templates'),
  graph: () => req('GET', '/api/graph'),
  departments: () => req('GET', '/api/departments'),
  department: (id) => req('GET', `/api/departments/${id}`),
  deptMembers: (id) => req('GET', `/api/departments/${id}/members`),
  addCategory: (deptId, name) => req('POST', `/api/departments/${deptId}/categories`, { name }),
  editCategory: (id, name) => req('PATCH', `/api/categories/${id}`, { name }),
  deleteCategory: (id) => req('DELETE', `/api/categories/${id}`),
  createManual: (body) => req('POST', '/api/manuals', body),
  manual: (id, view = 'published') => req('GET', `/api/manuals/${id}${qs({ view })}`),
  updateMeta: (id, body) => req('PATCH', `/api/manuals/${id}`, body),
  toggleFavorite: (id) => req('POST', `/api/manuals/${id}/favorite`),
  archive: (id, comment) => req('POST', `/api/manuals/${id}/archive`, { comment }),
  unarchive: (id) => req('POST', `/api/manuals/${id}/unarchive`),
  deleteManual: (id) => req('DELETE', `/api/manuals/${id}`),
  lock: (id) => req('POST', `/api/manuals/${id}/lock`),
  unlock: (id, force) => req('DELETE', `/api/manuals/${id}/lock${force ? '?force=true' : ''}`, undefined, { keepalive: true }),
  workContent: (id) => req('GET', `/api/manuals/${id}/work-content`),
  saveDraft: (id, title, content, keepalive) => req('PUT', `/api/manuals/${id}/draft`, { title, content_json: content }, { keepalive }),
  discardDraft: (id) => req('DELETE', `/api/manuals/${id}/draft`),
  saveVersion: (id, body) => req('POST', `/api/manuals/${id}/versions`, body),
  versions: (id) => req('GET', `/api/manuals/${id}/versions`),
  version: (id, vid) => req('GET', `/api/manuals/${id}/versions/${vid}`),
  diff: (id, a, b) => req('GET', `/api/manuals/${id}/diff${qs({ a, b })}`),
  restore: (id, vid) => req('POST', `/api/manuals/${id}/versions/${vid}/restore`),
  requestPublish: (id, comment) => req('POST', `/api/manuals/${id}/request-publish`, { comment }),
  publish: (id, comment) => req('POST', `/api/manuals/${id}/publish`, { comment }),
  reject: (id, comment) => req('POST', `/api/manuals/${id}/reject`, { comment }),
  upload: (id, f) => req('POST', `/api/manuals/${id}/attachments`, undefined, { form: file(f) }),
  importDocx: (id, f) => req('POST', `/api/manuals/${id}/import-docx`, undefined, { form: file(f) }),
  links: (id, view = 'published') => req('GET', `/api/manuals/${id}/links${qs({ view })}`),
  async exportManual(id, format, view = 'published') {
    let res: Response
    try {
      res = await fetch(`/api/manuals/${id}/export${qs({ format, view })}`, { credentials: 'same-origin' })
    } catch {
      throw new ApiError(0, '서버에 연결할 수 없습니다. 네트워크를 확인하세요.')
    }
    if (!res.ok) {
      let msg = `파일을 만들지 못했습니다(${res.status}).`
      try { const j = await res.json(); if (typeof j.detail === 'string') msg = j.detail } catch {}
      throw new ApiError(res.status, msg)
    }
    return { blob: await res.blob(), filename: filenameOf(res, `manual-${id}.${format}`) }
  },
  aiStatus: () => req('GET', '/api/ai/status'),
  async aiAsk(question, opts, onEvent, signal) {
    let res: Response
    try {
      res = await fetch('/api/ai/ask', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'X-WorkWiki': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, manual_id: opts.manual_id || undefined, dept: opts.dept || undefined }),
      })
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      throw new ApiError(0, '서버에 연결할 수 없습니다. 네트워크를 확인하세요.')
    }
    if (!res.ok || !res.body) {
      let msg = `질문을 처리하지 못했습니다(${res.status}).`
      try { const j = await res.json(); if (typeof j.detail === 'string') msg = j.detail } catch {}
      if (res.status === 401) window.dispatchEvent(new Event('ww:unauthorized'))
      throw new ApiError(res.status, msg)
    }
    // 한 줄에 하나씩 오는 JSON(NDJSON)을 읽는 대로 화면에 넘긴다
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onEvent(JSON.parse(line))
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf))
  },
  adminAi: () => req('GET', '/api/admin/ai'),
  saveAi: (body) => req('PUT', '/api/admin/ai', body),
  pullAiModel: (model) => req('POST', '/api/admin/ai/pull', { model }),
  aiPullStatus: () => req('GET', '/api/admin/ai/pull'),
  deleteAiModel: (model) => req('POST', '/api/admin/ai/delete-model', { model }),
  reindexAi: (reset) => req('POST', '/api/admin/ai/reindex', { reset }),
  search: (q, o = {}) => req('GET', `/api/search${qs({ q, dept: o.dept, cat: o.cat, period: o.period, work: o.work ? 'true' : undefined })}`),
  notifications: () => req('GET', '/api/notifications'),
  readNotifications: () => req('POST', '/api/notifications/read'),
  adminOverview: () => req('GET', '/api/admin/overview'),
  adminApprovals: () => req('GET', '/api/admin/approvals'),
  adminReviews: () => req('GET', '/api/admin/reviews'),
  adminUsers: (q, dept) => req('GET', `/api/admin/users${qs({ q, dept })}`),
  createUser: (body) => req('POST', '/api/admin/users', body),
  patchUser: (id, body) => req('PATCH', `/api/admin/users/${id}`, body),
  resetPassword: (id) => req('POST', `/api/admin/users/${id}/reset-password`),
  adminDepartments: () => req('GET', '/api/admin/departments'),
  createDept: (body) => req('POST', '/api/admin/departments', body),
  patchDept: (id, body) => req('PATCH', `/api/admin/departments/${id}`, body),
  setDeptAdmin: (deptId, userId, can_self_publish) => req('PUT', `/api/admin/departments/${deptId}/admins`, { user_id: userId, can_self_publish }),
  removeDeptAdmin: (deptId, userId) => req('DELETE', `/api/admin/departments/${deptId}/admins/${userId}`),
  moveManuals: (deptId, targetId) => req('POST', `/api/admin/departments/${deptId}/move-manuals`, { target_id: targetId }),
  hrSync: (f, mode, force) => req('POST', '/api/admin/hr-sync', undefined, { form: file(f, { mode, force: force ? 'true' : 'false' }) }),
  hrRuns: () => req('GET', '/api/admin/hr-sync/runs'),
  audit: (p) => req('GET', `/api/admin/audit${qs(p)}`),
  searchLogs: () => req('GET', '/api/admin/search-logs'),
}
