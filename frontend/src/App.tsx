import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api/client'
import type { AiStatus, Me, TreeDept } from './api/types'
import { AppCtx } from './app-context'
import { AppBar } from './components/AppBar'
import { Sidebar } from './components/Sidebar'
import { Spinner } from './components/ui'
import { navigate, useRoute } from './lib/router'
import { Admin } from './pages/admin/Admin'
import { Ask } from './pages/Ask'
import { Department } from './pages/Department'
import { EditorPage } from './pages/Editor'
import { History } from './pages/History'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { ManualView } from './pages/ManualView'
import { NewManualModal } from './pages/NewManual'
import { Search } from './pages/Search'

function Routes() {
  const { parts, query } = useRoute()
  if (parts[0] === 'm' && parts[1]) {
    const id = Number(parts[1])
    if (parts[2] === 'edit') return <EditorPage key={`e${id}`} id={id} />
    if (parts[2] === 'history') return <History key={`h${id}`} id={id} qa={query.get('a')} qb={query.get('b')} />
    return <ManualView key={`v${id}`} id={id} view={query.get('v') === 'work' ? 'work' : 'published'} anchor={query.get('a')} hl={query.get('t')} />
  }
  if (parts[0] === 'd' && parts[1]) return <Department id={Number(parts[1])} />
  if (parts[0] === 'search') return <Search q={query.get('q') || ''} dept={query.get('dept') ? Number(query.get('dept')) : null} cat={query.get('cat') ? Number(query.get('cat')) : null} period={query.get('period') || ''} work={query.get('work') === '1'} />
  if (parts[0] === 'admin') return <Admin tab={parts[1]} />
  if (parts[0] === 'ask') return <Ask q={query.get('q') || ''} manualId={query.get('m') ? Number(query.get('m')) : null} />
  return <Home />
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [tree, setTree] = useState<TreeDept[]>([])
  const [sbOpen, setSbOpen] = useState(false)
  const [newManual, setNewManual] = useState<{ open: boolean; dept?: number }>({ open: false })
  const [ai, setAi] = useState<AiStatus | null>(null)
  const reloadAi = useCallback(() => {
    api.aiStatus().then(setAi).catch(() => setAi(null))
  }, [])

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null))
    // 로그인이 만료되면 로그인 화면으로(편집 중 내용은 브라우저에 보관돼 다시 열 때 복구)
    const onUnauth = () => setMe(null)
    window.addEventListener('ww:unauthorized', onUnauth)
    return () => window.removeEventListener('ww:unauthorized', onUnauth)
  }, [])
  const reloadTree = useCallback(() => {
    api.tree().then(setTree).catch(() => {})
  }, [])
  const refreshMe = useCallback(() => {
    api.me().then((m) => m && setMe(m)).catch(() => {})
  }, [])
  useEffect(() => {
    if (me) {
      reloadTree()
      reloadAi()
    }
  }, [me?.id])
  // 알림 수 주기적 갱신
  useEffect(() => {
    if (!me) return
    const t = window.setInterval(refreshMe, 60000)
    return () => window.clearInterval(t)
  }, [me?.id])
  // '/' 키로 검색
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault()
        const el = document.getElementById('global-search') as HTMLInputElement | null
        if (el) el.focus()
        else navigate('/search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ctx = useMemo(() => me ? {
    me,
    setMe: (m: Me | null) => setMe(m),
    tree,
    reloadTree,
    refreshMe,
    openNewManual: (dept?: number) => setNewManual({ open: true, dept }),
    isAdminAny: me.roles.length > 0 || me.admin_depts.length > 0,
    openSidebar: () => setSbOpen(true),
    ai,
    reloadAi,
  } : null, [me, tree, ai])

  if (me === undefined) return <div className="boot"><Spinner label="WorkWiki 여는 중" /></div>
  if (!me || !ctx) return <Login onLogin={(m) => setMe(m)} />

  return (
    <AppCtx.Provider value={ctx}>
      <AppBar />
      <div className="app">
        <Sidebar open={sbOpen} onClose={() => setSbOpen(false)} />
        <main className="main">
          <Routes />
        </main>
      </div>
      {newManual.open && <NewManualModal deptId={newManual.dept} onClose={() => setNewManual({ open: false })} />}
    </AppCtx.Provider>
  )
}
