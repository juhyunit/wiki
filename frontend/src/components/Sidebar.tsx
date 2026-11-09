import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FilePen, Home, Plus, Settings, Star } from 'lucide-react'
import { api } from '../api/client'
import type { TreeDept } from '../api/types'
import { useApp } from '../app-context'
import { useRoute } from '../lib/router'
import { cx, storage } from '../lib/util'
import { DeptIcon } from './DeptIcon'
import { Link } from './Link'

export { Logo } from './AppBar'

function DeptNode({ d, expanded, toggle, activeManual, activeDept, onNavigate }: {
  d: TreeDept; expanded: Record<string, boolean>; toggle: (k: string, def?: boolean) => void
  activeManual: number | null; activeDept: number | null; onNavigate: () => void
}) {
  const open = !!expanded['d' + d.id]
  const groups = useMemo(() => {
    const out = d.categories.map((c) => ({ id: c.id, name: c.name, items: d.manuals.filter((m) => m.category_id === c.id) }))
    const none = d.manuals.filter((m) => !m.category_id || !d.categories.some((c) => c.id === m.category_id))
    if (none.length) out.push({ id: -1, name: '미분류', items: none })
    return out.filter((g) => g.items.length)
  }, [d])
  return (
    <div className="tree-node">
      <div className={cx('tree-row dept', activeDept === d.id && 'active')}>
        <Link to={`/d/${d.id}`} className="tree-link" onNavigate={() => { if (!open) toggle('d' + d.id); onNavigate() }}>
          <DeptIcon code={d.code} size={16} />
          <span className="ellipsis">{d.name}</span>
        </Link>
        <button className="tree-caret" onClick={() => toggle('d' + d.id)} aria-label={open ? '접기' : '펼치기'} aria-expanded={open}>
          <ChevronRight size={14} className={cx('caret', open && 'open')} />
        </button>
      </div>
      {open && (
        <div className="tree-children">
          {groups.length === 0 && <div className="tree-empty">문서 없음</div>}
          {groups.map((g) => {
            const key = 'c' + g.id + '-' + d.id
            const copen = expanded[key] !== false
            return (
              <div key={g.id}>
                <div className="tree-row cat">
                  <button className="tree-cat" onClick={() => toggle(key, true)} aria-expanded={copen}>
                    <span className="ellipsis">{g.name}</span>
                    <ChevronRight size={14} className={cx('caret', copen && 'open')} />
                  </button>
                </div>
                {copen && g.items.map((m) => (
                  <Link key={m.id} to={`/m/${m.id}`} onNavigate={onNavigate} title={m.title}
                    className={cx('tree-row doc', activeManual === m.id && 'active', m.status === 'draft' && 'is-draft')}>
                    <span className="ellipsis">{m.title}</span>
                    {m.review_state === 'in_review' ? <span className="dot dot-amber" title="게시 대기" /> : m.has_work ? <span className="dot" title="게시 안 된 수정 있음" /> : null}
                  </Link>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, tree, isAdminAny, openNewManual } = useApp()
  const { parts, query } = useRoute()
  const manualId = parts[0] === 'm' ? Number(parts[1]) : null
  const deptId = parts[0] === 'd' ? Number(parts[1]) : null
  const section = parts[0] || 'home'
  const homeTab = query.get('tab')
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(storage.get('ww:tree2') || 'null') || { ['d' + (me.department_id || 0)]: true }
    } catch {
      return { ['d' + (me.department_id || 0)]: true }
    }
  })
  const toggle = (k: string, def = false) => setExpanded((e) => ({ ...e, [k]: !(e[k] ?? def) }))
  useEffect(() => {
    if (!manualId) return
    const d = tree.find((x) => x.manuals.some((m) => m.id === manualId))
    if (d && !expanded['d' + d.id]) setExpanded((e) => ({ ...e, ['d' + d.id]: true }))
  }, [manualId, tree])
  useEffect(() => {
    storage.set('ww:tree2', JSON.stringify(expanded))
  }, [expanded])
  const canCreate = !!me.department_id || me.admin_depts.length > 0
  const isHome = section === 'home'
  return (
    <>
      <div className={cx('sb-backdrop', open && 'show')} onClick={onClose} />
      <aside className={cx('sidebar', open && 'open')} aria-label="부서·문서 탐색">
        <nav className="sb-nav">
          <Link to="/" className={cx('nav-item', isHome && !homeTab && 'active')} onNavigate={onClose}><Home size={15} /> <span>홈</span></Link>
          <Link to="/?tab=fav" className={cx('nav-item', isHome && homeTab === 'fav' && 'active')} onNavigate={onClose}><Star size={15} /> <span>즐겨찾기</span></Link>
          <Link to="/?tab=mine" className={cx('nav-item', isHome && homeTab === 'mine' && 'active')} onNavigate={onClose}><FilePen size={15} /> <span>내 작업</span></Link>
        </nav>
        <div className="sb-scroll">
          <div className="sb-label">
            <span>부서</span>
            {canCreate && <button className="sb-add" title="새 매뉴얼" aria-label="새 매뉴얼" onClick={() => { onClose(); openNewManual() }}><Plus size={14} /></button>}
          </div>
          {tree.map((d) => (
            <DeptNode key={d.id} d={d} expanded={expanded} toggle={toggle} activeManual={manualId} activeDept={deptId} onNavigate={onClose} />
          ))}
        </div>
        <div className="sb-foot">
          {isAdminAny && (
            <Link to="/admin" className={cx('nav-item', section === 'admin' && 'active')} onNavigate={onClose}><Settings size={15} /> <span>관리</span></Link>
          )}
          {api.mode === 'demo' && <div className="demo-note">데모 · 바꾼 내용은 이 브라우저에만 저장됩니다</div>}
        </div>
      </aside>
    </>
  )
}
