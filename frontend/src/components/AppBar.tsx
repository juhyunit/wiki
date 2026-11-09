import { FormEvent, useEffect, useRef, useState } from 'react'
import { Bell, ChevronDown, KeyRound, LogOut, Menu, Plus, RotateCcw, Scale, Search, UserRound } from 'lucide-react'
import { api } from '../api/client'
import type { Notification } from '../api/types'
import { useApp } from '../app-context'
import { navigate, useRoute } from '../lib/router'
import { cx, relTime } from '../lib/util'
import { Link } from './Link'
import { Modal, useDialog, useToast } from './ui'

export function Logo({ size = 22 }: { size?: number }) {
  return <span className="logo-mark" style={{ width: size, height: size, fontSize: size * 0.58 }} aria-hidden="true">W</span>
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return ref
}

function Notifications() {
  const { me, refreshMe } = useApp()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[] | null>(null)
  const ref = useOutside(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    api.notifications().then((r) => {
      setItems(r.items)
      if (r.unread) api.readNotifications().then(refreshMe)
    })
  }, [open])
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={cx('bar-btn', open && 'on')} onClick={() => setOpen(!open)} aria-label={`알림 ${me.unread}건`} title="알림">
        <Bell size={17} />
        {me.unread > 0 && <span className="bar-count">{me.unread > 99 ? '99+' : me.unread}</span>}
      </button>
      {open && (
        <div className="popover right notif-pop">
          <div className="pop-title">알림</div>
          {!items && <div className="pad muted small">불러오는 중…</div>}
          {items && items.length === 0 && <div className="pad muted small">알림이 없습니다.</div>}
          {items?.map((n) => (
            <button key={n.id} className={cx('notif', !n.read_at && 'unread')}
              onClick={() => { setOpen(false); if (n.manual_id) navigate(`/m/${n.manual_id}${n.kind === 'request' || n.kind === 'reminder' ? '?v=work' : ''}`) }}>
              <div>{n.message}</div>
              <div className="muted small">{relTime(n.at)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [nw, setNw] = useState('')
  const [nw2, setNw2] = useState('')
  const [err, setErr] = useState('')
  const submit = async () => {
    if (nw.length < 8) return setErr('새 비밀번호는 8자 이상이어야 합니다.')
    if (nw !== nw2) return setErr('새 비밀번호가 서로 다릅니다.')
    try {
      await api.changePassword(cur, nw)
      toast('비밀번호를 바꿨습니다.')
      onClose()
    } catch (e: any) {
      setErr(e.message)
    }
  }
  return (
    <Modal title="비밀번호 변경" onClose={onClose} width={400}
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn-primary" onClick={submit}>변경</button></>}>
      <label className="field"><span>현재 비밀번호</span><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      <label className="field"><span>새 비밀번호 (8자 이상)</span><input type="password" value={nw} onChange={(e) => setNw(e.target.value)} /></label>
      <label className="field"><span>새 비밀번호 확인</span><input type="password" value={nw2} onChange={(e) => setNw2(e.target.value)} /></label>
      {err && <div className="form-error">{err}</div>}
    </Modal>
  )
}

const LICENSES = [
  ['React, React DOM', 'MIT'], ['TipTap(@tiptap/*), ProseMirror', 'MIT'], ['Vite', 'MIT'], ['TypeScript', 'Apache-2.0'],
  ['Lucide 아이콘', 'ISC'], ['Inter · Noto Sans KR 글꼴', 'SIL OFL 1.1'], ['Fontsource 글꼴 패키지', 'MIT'], ['FastAPI, Pydantic', 'MIT'], ['Uvicorn', 'BSD-3-Clause'],
  ['python-multipart', 'Apache-2.0'], ['nh3', 'MIT'], ['mammoth', 'BSD-2-Clause'], ['Pillow', 'MIT-CMU'], ['SQLite', 'Public Domain'],
]

function UserMenu() {
  const { me, setMe } = useApp()
  const dialog = useDialog()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState(false)
  const [lic, setLic] = useState(false)
  const ref = useOutside(open, () => setOpen(false))
  const role = me.roles.includes('sys_admin') ? '시스템 관리자' : me.admin_depts.length ? '부서 관리자' : '부서원'
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={cx('user-btn', open && 'on')} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="user-initial">{me.name.slice(0, 1)}</span>
        <span className="user-label"><strong>{me.name}</strong> <span>{me.department_name}</span></span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="popover right user-pop" role="menu">
          <div className="pop-head">
            <strong>{me.name} {me.position}</strong>
            <span className="muted small">{me.department_name} · {role}</span>
          </div>
          {api.mode === 'server' && <button className="menu-item" onClick={() => { setOpen(false); setPw(true) }}><KeyRound size={15} /> 비밀번호 변경</button>}
          <button className="menu-item" onClick={() => { setOpen(false); setLic(true) }}><Scale size={15} /> 오픈소스 고지</button>
          {api.mode === 'demo' && (
            <button className="menu-item" onClick={async () => {
              setOpen(false)
              if (await dialog({ title: '데모 데이터 초기화', message: '이 브라우저에 저장된 데모 데이터를 지우고 처음 상태로 되돌립니다.', confirmText: '초기화', danger: true })) {
                await api.resetDemo?.()
                setMe(null)
              }
            }}><RotateCcw size={15} /> 데모 데이터 초기화</button>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={async () => { await api.logout(); setMe(null); navigate('/', { replace: true }) }}>
            {api.mode === 'demo' ? <><UserRound size={15} /> 다른 계정으로 보기</> : <><LogOut size={15} /> 로그아웃</>}
          </button>
        </div>
      )}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
      {lic && (
        <Modal title="오픈소스 고지" onClose={() => setLic(false)} width={480} footer={<button className="btn" onClick={() => setLic(false)}>닫기</button>}>
          <p className="muted small" style={{ marginTop: 0 }}>이 시스템이 사용하는 오픈소스입니다. 라이선스 전문은 각 프로젝트 저장소에서 확인할 수 있습니다.</p>
          <table className="table dense">
            <thead><tr><th>구성요소</th><th>라이선스</th></tr></thead>
            <tbody>{LICENSES.map(([n, l]) => <tr key={n}><td>{n}</td><td className="muted">{l}</td></tr>)}</tbody>
          </table>
        </Modal>
      )}
    </div>
  )
}

export function AppBar() {
  const { me, openSidebar, openNewManual } = useApp()
  const { parts, query } = useRoute()
  const onSearch = parts[0] === 'search'
  const [q, setQ] = useState(onSearch ? query.get('q') || '' : '')
  useEffect(() => {
    setQ(onSearch ? query.get('q') || '' : '')
  }, [onSearch, query.get('q')])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = q.trim()
    navigate(v ? `/search?q=${encodeURIComponent(v)}` : '/search', { replace: onSearch })
  }
  const canCreate = !!me.department_id || me.admin_depts.length > 0
  return (
    <header className="appbar">
      <div className="appbar-left">
        <button className="bar-btn hamburger" onClick={openSidebar} aria-label="메뉴 열기"><Menu size={18} /></button>
        <Link to="/" className="brand"><Logo /> <span>WorkWiki</span></Link>
      </div>
      <form className="global-search" onSubmit={submit} role="search">
        <Search size={15} />
        <input id="global-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="매뉴얼 검색 (제목·본문·태그)" aria-label="매뉴얼 검색" autoComplete="off" />
        <kbd>/</kbd>
      </form>
      <div className="appbar-right">
        {canCreate && <button className="btn btn-primary hide-sm" onClick={() => openNewManual()}><Plus size={14} /> 새 매뉴얼</button>}
        <Notifications />
        <UserMenu />
      </div>
    </header>
  )
}
