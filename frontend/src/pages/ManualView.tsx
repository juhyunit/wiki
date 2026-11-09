import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, Clock, FileClock, Info, Lock, MessageSquareText, MoreHorizontal, PanelRightClose, PanelRightOpen, Paperclip,
  PenLine, Printer, Send, Star, Trash2, Unlock, XCircle,
} from 'lucide-react'
import { api } from '../api/client'
import type { Dept, ManualDetail, TocItem } from '../api/types'
import { useApp } from '../app-context'
import { DocInfoCard, ExportMenu, LinkedDocs } from '../components/DocParts'
import { Link } from '../components/Link'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Modal, ReviewDate, Spinner, useDialog, useLoad, useToast } from '../components/ui'
import { navigate } from '../lib/router'
import { useWideView } from '../lib/wide'
import { cx, fileSize, fmtDate, fmtDateTime, fmtTime, relTime } from '../lib/util'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

// AI 답변의 근거에서 '문서에서 보기'로 왔을 때: 그 절(제목)로 가서 근거 문단을 잠깐 강조한다
function useEvidence(ready: boolean, anchor: string | null, text: string | null) {
  useEffect(() => {
    if (!ready || (!anchor && !text)) return
    const root = document.querySelector('.doc .prose') as HTMLElement | null
    if (!root) return
    const head = anchor ? root.querySelector('#' + CSS.escape(anchor)) as HTMLElement | null : null
    let target: HTMLElement | null = null
    const want = text ? norm(text).slice(0, 24) : ''
    if (want) {
      const start = head ? head.nextElementSibling : root.firstElementChild
      for (let el = start as HTMLElement | null; el; el = el.nextElementSibling as HTMLElement | null) {
        if (head && /^H[1-4]$/.test(el.tagName) && el.tagName <= head.tagName) break
        if (norm(el.textContent || '').includes(want)) { target = el; break }
      }
      if (!target) target = Array.from(root.children).find((el) => norm(el.textContent || '').includes(want)) as HTMLElement | null
    }
    const goal = target || head
    if (!goal) return
    const t = window.setTimeout(() => {
      goal.scrollIntoView({ behavior: 'smooth', block: target ? 'center' : 'start' })
      if (target) {
        target.classList.add('evidence-hl')
        window.setTimeout(() => target!.classList.remove('evidence-hl'), 6000)
      }
    }, 120)
    return () => window.clearTimeout(t)
  }, [ready, anchor, text])
}

export function Toc({ toc, containerSelector = '.prose', onHide }: { toc: TocItem[]; containerSelector?: string; onHide?: () => void }) {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const els = toc.map((t) => document.getElementById(t.id)).filter(Boolean) as HTMLElement[]
    if (!els.length || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActive(vis[0].target.id)
      },
      { rootMargin: '-70px 0px -70% 0px' },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [toc])
  if (!toc.length) return null
  return (
    <nav className="toc" aria-label="목차">
      <div className="toc-title">
        <span>목차</span>
        {onHide && <button type="button" className="toc-hide" onClick={onHide} title="목차 숨기고 넓게 보기" aria-label="목차 숨기기"><PanelRightClose size={14} /></button>}
      </div>
      {toc.map((t) => (
        <a key={t.id} href={'#' + t.id} className={cx('toc-item', `lv${t.level}`, active === t.id && 'active')}
          onClick={(e) => {
            e.preventDefault()
            document.querySelector(containerSelector)?.querySelector('#' + CSS.escape(t.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            setActive(t.id)
          }}>
          {t.text}
        </a>
      ))}
    </nav>
  )
}

function InfoModal({ m, onClose, onSaved }: { m: ManualDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const { tree } = useApp()
  const canManage = m.perms.manage
  const canEdit = m.perms.edit
  const [members, setMembers] = useState<{ id: number; name: string; position: string | null }[]>([])
  const [depts, setDepts] = useState<Dept[]>([])
  const [owner, setOwner] = useState<number | null>(m.owner_id)
  const [vis, setVis] = useState(m.visibility)
  const [extra, setExtra] = useState<number[]>(m.extra_department_ids)
  const [cycle, setCycle] = useState(m.review_cycle_months)
  const [nextReview, setNextReview] = useState(m.next_review_date || '')
  const [cat, setCat] = useState<number | null>(m.category_id)
  const [tags, setTags] = useState(m.tags.join(', '))
  const [err, setErr] = useState('')
  const cats = tree.find((d) => d.id === m.department_id)?.categories || []
  useEffect(() => {
    if (canManage) {
      api.deptMembers(m.department_id).then(setMembers).catch(() => {})
      api.departments().then(setDepts).catch(() => {})
    }
  }, [])
  const save = async () => {
    setErr('')
    try {
      const body: Record<string, any> = { tags: tags.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean) }
      if (canManage) Object.assign(body, { owner_id: owner, visibility: vis, extra_department_ids: extra, review_cycle_months: cycle, category_id: cat, ...(nextReview ? { next_review_date: nextReview } : {}) })
      await api.updateMeta(m.id, body)
      toast('문서 정보를 저장했습니다.')
      onSaved()
      onClose()
    } catch (e: any) {
      setErr(e.message)
    }
  }
  const ro = (label: string, v: React.ReactNode) => (
    <div className="kv"><span>{label}</span><div>{v}</div></div>
  )
  return (
    <Modal title="문서 정보" onClose={onClose} width={560}
      footer={canEdit || canManage ? <><button className="btn" onClick={onClose}>닫기</button><button className="btn btn-primary" onClick={save}>저장</button></> : <button className="btn" onClick={onClose}>닫기</button>}>
      <div className="kv-list">
        {ro('문서 번호', m.manual_no)}
        {ro('담당 부서', m.department_name)}
        {ro('판번', m.edition ? `제${m.edition}판 (v${m.version_no}) · ${fmtDate(m.published_at)} 게시` : '아직 게시되지 않음')}
        {ro('최근 30일 조회', `${m.views_30d}회`)}
      </div>
      <hr className="sep" />
      {canManage ? (
        <div className="form-grid">
          <label className="field"><span>업무분류</span>
            <select value={cat ?? ''} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : null)}>
              <option value="">미분류</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <label className="field"><span>담당자</span>
            <select value={owner ?? ''} onChange={(e) => setOwner(Number(e.target.value))}>
              {!members.some((x) => x.id === owner) && <option value={owner ?? ''}>{m.owner_name || '없음'}{!m.owner_active ? ' (재지정 필요)' : ''}</option>}
              {members.map((u) => <option key={u.id} value={u.id}>{u.name} {u.position}</option>)}
            </select></label>
          <label className="field"><span>열람 범위</span>
            <select value={vis} onChange={(e) => setVis(e.target.value as any)}>
              <option value="company">전사 공개</option>
              <option value="department">부서 한정</option>
            </select></label>
          <label className="field"><span>검토 주기</span>
            <select value={cycle} onChange={(e) => setCycle(Number(e.target.value))}>
              {[3, 6, 12, 24].map((n) => <option key={n} value={n}>{n}개월</option>)}
            </select></label>
          <label className="field"><span>다음 검토일</span>
            <input type="date" value={nextReview} onChange={(e) => setNextReview(e.target.value)} /></label>
          {vis === 'department' && (
            <div className="field full"><span>추가 열람 부서</span>
              <div className="check-list">
                {depts.filter((d) => d.id !== m.department_id).map((d) => (
                  <label key={d.id} className="check">
                    <input type="checkbox" checked={extra.includes(d.id)} onChange={(e) => setExtra(e.target.checked ? [...extra, d.id] : extra.filter((x) => x !== d.id))} />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="kv-list">
          {ro('업무분류', m.category_name || '미분류')}
          {ro('담당자', m.owner_name || '-')}
          {ro('열람 범위', m.visibility === 'company' ? '전사 공개' : '부서 한정')}
          {ro('검토 주기', `${m.review_cycle_months}개월`)}
          {ro('다음 검토일', <ReviewDate d={m.next_review_date} />)}
        </div>
      )}
      {canEdit && (
        <label className="field"><span>태그 (쉼표로 구분)</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="예: 연차, 휴가, 근태" /></label>
      )}
      {canManage && <p className="muted small">담당자·열람 범위·검토 주기는 부서 관리자만 바꿀 수 있습니다. 바꾼 내용은 감사 로그에 남습니다.</p>}
      {err && <div className="form-error">{err}</div>}
    </Modal>
  )
}

function MoreMenu({ m, reload }: { m: ManualDetail; reload: () => void }) {
  const { reloadTree, me } = useApp()
  const dialog = useDialog()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const act = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn()
      toast(msg)
      reload()
      reloadTree()
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  const lockedByOther = m.lock && m.lock.user_id !== me.id
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="더 보기"><MoreHorizontal size={18} /></button>
      {open && (
        <div className="popover menu-pop right">
          <button className="menu-item" onClick={() => { setOpen(false); setInfo(true) }}><Info size={15} /> 문서 정보{m.perms.manage ? '·설정' : ''}</button>
          {m.perms.force_unlock && lockedByOther && (
            <button className="menu-item" onClick={async () => {
              setOpen(false)
              if (await dialog({ title: '편집 잠금 해제', message: `${m.lock!.user_name} 님의 편집 잠금을 해제합니다. 자동 저장된 내용은 남습니다.`, confirmText: '해제' }))
                act(() => api.unlock(m.id, true), '편집 잠금을 해제했습니다.')
            }}><Unlock size={15} /> 편집 잠금 해제</button>
          )}
          {m.perms.manage && m.status !== 'archived' && m.published && (
            <button className="menu-item danger" onClick={async () => {
              setOpen(false)
              const reason = await dialog({ title: '매뉴얼 폐기', message: '폐기하면 직원 화면과 검색에서 사라집니다. 이력은 남고, 부서 관리자는 다시 되돌릴 수 있습니다.', input: { label: '폐기 사유', required: true }, confirmText: '폐기', danger: true })
              if (reason) act(() => api.archive(m.id, reason), '폐기했습니다.')
            }}><Archive size={15} /> 폐기</button>
          )}
          {m.status === 'archived' && m.perms.view_work && (
            <button className="menu-item" onClick={() => { setOpen(false); act(() => api.unarchive(m.id), '폐기를 해제했습니다.') }}><ArchiveRestore size={15} /> 폐기 해제</button>
          )}
          {!m.published && m.perms.edit && (
            <button className="menu-item danger" onClick={async () => {
              setOpen(false)
              if (await dialog({ title: '매뉴얼 삭제', message: '아직 게시되지 않은 매뉴얼을 삭제합니다.', confirmText: '삭제', danger: true })) {
                try { await api.deleteManual(m.id); toast('삭제했습니다.'); reloadTree(); navigate('/') } catch (e: any) { toast(e.message, 'err') }
              }
            }}><Trash2 size={15} /> 삭제</button>
          )}
        </div>
      )}
      {info && <InfoModal m={m} onClose={() => setInfo(false)} onSaved={reload} />}
    </div>
  )
}

export function ManualView({ id, view, anchor = null, hl = null }: { id: number; view: 'published' | 'work'; anchor?: string | null; hl?: string | null }) {
  const { me, tree, reloadTree, refreshMe, ai } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const { data: m, error, loading, reload, setData } = useLoad(() => api.manual(id, view), [id, view])
  const [wide, toggleWide] = useWideView()

  const act = async (fn: () => Promise<any>, msg: string, after?: () => void) => {
    try {
      await fn()
      toast(msg)
      reload()
      reloadTree()
      refreshMe()
      after?.()
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  const doRequest = async () => {
    const c = await dialog({ title: '게시 요청', message: '부서 관리자에게 게시를 요청합니다. 게시되기 전까지 직원들은 지금의 공식본을 봅니다.', input: { label: '요청 메모 (선택)' }, confirmText: '요청' })
    if (c !== null) act(() => api.requestPublish(id, c || undefined), '게시를 요청했습니다.')
  }
  const doPublish = async () => {
    const c = await dialog({ title: '게시', message: <>v{m?.latest_version_no} → <strong>제{(m?.edition || 0) + 1}판</strong>. 게시하면 바로 전 직원 화면에 반영됩니다.</>, input: { label: '게시 의견 (선택)' }, confirmText: '게시' })
    if (c !== null) act(() => api.publish(id, c || undefined), '게시했습니다.', () => navigate(`/m/${id}`, { replace: true }))
  }
  const doReject = async () => {
    const c = await dialog({ title: '반려', message: '반려 사유는 요청한 사람에게 전달됩니다.', input: { label: '반려 사유', required: true, multiline: true }, confirmText: '반려', danger: true })
    if (c) act(() => api.reject(id, c), '반려했습니다.')
  }
  const fav = async () => {
    if (!m) return
    try {
      const r = await api.toggleFavorite(id)
      setData({ ...m, is_favorite: r.favorite })
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  const print = () => {
    if (api.mode === 'demo') return toast('인쇄·PDF 저장은 PC에 설치한 버전에서 브라우저 인쇄로 씁니다.', 'info')
    window.print()
  }
  const code = tree.find((d) => d.id === m?.department_id)?.code
  useEvidence(!!m, anchor, hl)
  // 본문 안의 문서 링크(#/m/번호)는 화면 안에서 이동한다(데모의 메모리 경로에서도 동작)
  const onProseClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
    const href = a?.getAttribute('href') || ''
    if (/^#\/m\/\d+/.test(href) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      navigate(href.slice(1))
    }
  }

  const crumbs = useMemo(() => {
    if (!m) return [{ label: '매뉴얼' }]
    const c: { label: string; to?: string; code?: string }[] = [{ label: m.department_name, to: `/d/${m.department_id}`, code }]
    if (m.category_name) c.push({ label: m.category_name, to: `/d/${m.department_id}` })
    c.push({ label: m.title })
    return c
  }, [m, code])

  if (error) return <><PageHeader crumbs={[{ label: '매뉴얼' }]} /><div className="page"><ErrorBox error={error} onRetry={reload} /></div></>
  if (!m) return <><PageHeader crumbs={[{ label: '매뉴얼' }]} /><div className="page">{loading && <Spinner />}</div></>

  const unpublishedLatest = m.latest_version_no != null && m.latest_version_no !== m.version_no
  const lockedByOther = m.lock && m.lock.user_id !== me.id
  const isWork = m.view === 'work'

  return (
    <>
      <PageHeader crumbs={crumbs} actions={<>
        {m.perms.view_work && m.published && (
          <div className="seg-toggle" role="group" aria-label="보기 선택">
            <button className={cx(!isWork && 'on')} onClick={() => navigate(`/m/${id}`, { replace: true })}>공식본</button>
            <button className={cx(isWork && 'on')} onClick={() => navigate(`/m/${id}?v=work`, { replace: true })}>작업본{unpublishedLatest || m.draft ? <span className="seg-dot" /> : null}</button>
          </div>
        )}
        {m.perms.view_work && <Link to={`/m/${id}/history`} className="icon-btn" title="이력·비교" aria-label="이력·비교"><FileClock size={17} /></Link>}
        {m.toc.length > 0 && (
          <button className={cx('icon-btn hide-md', wide && 'on')} onClick={toggleWide} aria-pressed={wide}
            title={wide ? '목차 보이기' : '목차 숨기고 넓게 보기'} aria-label={wide ? '목차 보이기' : '목차 숨기고 넓게 보기'}>
            {wide ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
          </button>
        )}
        {ai && ai.mode !== 'off' && m.can_view_published && (
          <Link to={`/ask?m=${id}`} className="icon-btn hide-sm" title="이 문서에 AI로 질문" aria-label="이 문서에 AI로 질문"><MessageSquareText size={17} /></Link>
        )}
        <button className="icon-btn hide-sm" onClick={print} title="인쇄" aria-label="인쇄"><Printer size={17} /></button>
        <ExportMenu m={m} />
        {m.perms.edit && <Link to={`/m/${id}/edit`} className="btn"><PenLine size={15} /> 편집</Link>}
        <MoreMenu m={m} reload={reload} />
      </>} />
      <div className="page doc-page">
        <div className={cx('doc-layout', (wide || !m.toc.length) && 'wide')}>
          <article className="doc">
            {m.status === 'archived' && <div className="hint hint-gray"><Archive size={16} /><span>폐기된 매뉴얼입니다. 담당 부서만 볼 수 있습니다.</span></div>}
            {lockedByOther && m.perms.view_work && (
              <div className="hint hint-gray"><Lock size={16} /><span>{m.lock!.user_name} 님이 {fmtTime(m.lock!.since)}부터 편집하고 있습니다.</span></div>
            )}
            {m.pending && m.perms.view_work && (
              m.perms.reject ? (
                <div className="hint hint-amber">
                  <Clock size={16} />
                  <span>
                    <strong>{m.pending.requester}</strong> 님이 v{m.pending.version_no} 게시를 요청했습니다 <span className="muted">· {relTime(m.pending.requested_at)}</span>
                    {m.pending.comment && <span className="hint-quote">{m.pending.comment}</span>}
                  </span>
                  <span className="hint-actions">
                    <Link to={`/m/${id}/history?a=${m.published?.version_id ?? ''}&b=${m.pending.version_id}`} className="link-btn">변경 내용</Link>
                    <button className="btn btn-sm" onClick={doReject}>반려</button>
                    {m.perms.publish
                      ? <button className="btn btn-sm btn-primary" onClick={doPublish}>게시</button>
                      : <span className="small muted" title="직무 분리">본인 작성분은 다른 관리자가 게시</span>}
                  </span>
                </div>
              ) : (
                <div className="hint hint-amber"><Clock size={16} /><span>v{m.pending.version_no} 게시를 요청했습니다. 부서 관리자가 게시하면 공식본이 바뀝니다.</span></div>
              )
            )}
            {m.rejection && m.perms.view_work && !m.pending && (
              <div className="hint hint-red"><XCircle size={16} /><span>v{m.latest_version_no} 게시가 반려되었습니다 <span className="muted">· {m.rejection.decider}, {relTime(m.rejection.decided_at)}</span><span className="hint-quote">{m.rejection.comment}</span></span></div>
            )}
            {m.perms.view_work && unpublishedLatest && !m.pending && m.status !== 'archived' && (
              <div className="hint hint-blue">
                <Send size={16} />
                <span>{m.published ? `v${m.latest_version_no} 수정본은 아직 게시 전이라 직원들은 제${m.edition}판(v${m.version_no})을 보고 있습니다.` : `v${m.latest_version_no} 수정본은 아직 게시 전입니다.`}</span>
                <span className="hint-actions">
                  {m.published && <Link to={`/m/${id}/history?a=${m.published.version_id}&b=latest`} className="link-btn">변경 내용</Link>}
                  {m.perms.publish ? <button className="btn btn-sm btn-primary" onClick={doPublish}>게시</button>
                    : m.perms.request_publish ? <button className="btn btn-sm btn-primary" onClick={doRequest}>게시 요청</button> : null}
                </span>
              </div>
            )}
            {m.draft && m.perms.view_work && (
              <div className="hint hint-gray">
                <PenLine size={16} />
                <span>{m.draft.mine ? '저장하지 않은 작성 중 내용이 있습니다' : `${m.draft.user_name} 님이 작성 중인 내용이 있습니다`} <span className="muted">· {fmtDateTime(m.draft.saved_at)} 자동 저장</span></span>
                {m.perms.edit && !lockedByOther && <span className="hint-actions"><Link to={`/m/${id}/edit`} className="link-btn">이어서 편집</Link></span>}
              </div>
            )}

            <header className="doc-head">
              <h1 className="doc-title">
                {m.shown_title}
                <button className={cx('title-star', m.is_favorite && 'on')} onClick={fav} title={m.is_favorite ? '즐겨찾기 해제' : '즐겨찾기'} aria-pressed={m.is_favorite}>
                  <Star size={20} fill={m.is_favorite ? 'currentColor' : 'none'} />
                </button>
              </h1>
              <DocInfoCard m={m} />
            </header>

            {m.content_html ? <div className="prose" onClick={onProseClick} dangerouslySetInnerHTML={{ __html: m.content_html }} /> : <p className="empty-text">아직 본문이 없습니다.</p>}

            {m.attachments.length > 0 && (
              <section className="attachments">
                <h3>첨부파일 {m.attachments.length}</h3>
                {m.attachments.map((a) => (
                  <a key={a.id} href={a.url} className="attachment"
                    onClick={(e) => { if (api.mode === 'demo') { e.preventDefault(); toast('데모에서는 파일을 내려받을 수 없습니다.', 'info') } }}>
                    <Paperclip size={14} /> <span className="ellipsis">{a.name}</span>
                    <span className="muted small">{fileSize(a.size)}{a.kind === 'source_original' ? ' · 원본 문서' : ''}</span>
                  </a>
                ))}
              </section>
            )}
            <LinkedDocs id={id} view={m.view} canEdit={m.perms.edit} reloadKey={m.updated_at} />
            <footer className="doc-foot">최근 30일 조회 {m.views_30d}회 · 최종 수정 {fmtDateTime(m.updated_at)}</footer>
          </article>
          {!wide && m.toc.length > 0 && (
            <aside className="doc-aside">
              <Toc toc={m.toc} onHide={toggleWide} />
            </aside>
          )}
        </div>
      </div>
    </>
  )
}
