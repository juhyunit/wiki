export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ')
}

export function fmtDate(s?: string | null) {
  if (!s) return '-'
  return s.slice(0, 10)
}

export function fmtDateTime(s?: string | null) {
  if (!s) return '-'
  return s.slice(0, 16)
}

export function fmtTime(s?: string | null) {
  if (!s) return ''
  return s.slice(11, 16)
}

export function relTime(s?: string | null) {
  if (!s) return ''
  const t = new Date(s.replace(' ', 'T')).getTime()
  const diff = (Date.now() - t) / 1000
  if (diff < 60) return '방금'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`
  return s.slice(0, 10)
}

export function daysUntil(d?: string | null) {
  if (!d) return null
  const t = new Date(d + 'T00:00:00').getTime()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((t - today.getTime()) / 86400000)
}

export function fileSize(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function nowStr() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v)
      return true
    } catch {
      return false
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key)
    } catch {}
  },
}

export const CHANGE_TYPES = ['오탈자', '내용 보완', '절차 변경', '규정 개정']
