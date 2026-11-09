import { useSyncExternalStore } from 'react'

declare const __DEMO__: boolean

// 서버 모드: #/경로 (북마크·새로고침 가능) / 데모 모드: 메모리 라우터(아티팩트 프레임 안에서 안전)
const useHash = !__DEMO__
const listeners = new Set<() => void>()
let memStack: string[] = ['/']

function emit() {
  listeners.forEach((l) => l())
}

if (useHash && typeof window !== 'undefined') window.addEventListener('hashchange', emit)

export function getPath(): string {
  if (useHash) return decodeURI(location.hash.slice(1)) || '/'
  return memStack[memStack.length - 1]
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (useHash) {
    if (opts.replace) {
      history.replaceState(null, '', '#' + path)
      emit()
    } else location.hash = path
  } else {
    if (opts.replace) memStack[memStack.length - 1] = path
    else memStack.push(path)
    if (memStack.length > 50) memStack = memStack.slice(-50)
    emit()
  }
  window.scrollTo(0, 0)
}

export function back(fallback = '/') {
  if (useHash) {
    if (history.length > 1) history.back()
    else navigate(fallback)
  } else {
    if (memStack.length > 1) {
      memStack.pop()
      emit()
    } else navigate(fallback, { replace: true })
  }
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useRoute() {
  const full = useSyncExternalStore(subscribe, getPath)
  const [pathname, query = ''] = full.split('?')
  const parts = pathname.split('/').filter(Boolean)
  return { full, pathname, parts, query: new URLSearchParams(query) }
}

export function href(path: string) {
  return useHash ? '#' + path : '#'
}
