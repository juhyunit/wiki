// 문서 화면 부품: 문서 관리 정보 카드 · 연결된 문서(링크·역링크) · 내려받기 메뉴
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download } from 'lucide-react'
import { api } from '../api/client'
import type { ExportFormat, LinkedDoc, LinksData, ManualDetail } from '../api/types'
import { downloadBlob, printHtml } from '../lib/exporters'
import { cx, daysUntil, fmtDate } from '../lib/util'
import { Link } from './Link'
import { useToast } from './ui'

// ---------------------------------------------------------------- 문서 관리 정보(책임자·검토일을 한눈에)
function reviewState(m: ManualDetail): [string, string] | null {
  if (m.status !== 'published' || !m.next_review_date) return null
  const n = daysUntil(m.next_review_date)
  if (n == null) return null
  if (n < 0) return [`검토 지연 ${-n}일`, 'red']
  if (n <= 30) return [`검토 임박 D-${n}`, 'amber']
  return ['검토 예정', 'navy']
}

export function DocInfoCard({ m }: { m: ManualDetail }) {
  const isWork = m.view === 'work'
  const states: [string, string][] = []
  if (m.status === 'draft') states.push(['작성 중', 'gray'])
  if (m.status === 'archived') states.push(['폐기됨', 'gray'])
  if (m.review_state === 'in_review') states.push(['게시 대기', 'amber'])
  else if (m.status === 'published' && m.has_work) states.push(['수정 중', 'blue'])
  const rv = reviewState(m)
  if (rv) states.push(rv as [string, string])
  const n = daysUntil(m.next_review_date)
  const edition = isWork
    ? (m.shown_version_no ? `작업본 v${m.shown_version_no}` : '저장 전 초안')
    : m.published ? `제${m.edition}판` : '미게시'
  const editionSub = isWork ? (m.published ? `공식본 제${m.edition}판` : '게시 전') : m.published ? `v${m.version_no}` : ''
  const fields: { k: string; v: React.ReactNode; sub?: React.ReactNode; key?: boolean; cls?: string }[] = [
    { k: '문서 책임자', v: m.owner_name || '-', sub: !m.owner_active ? <span className="text-red">재지정 필요</span> : m.department_name, key: true },
    { k: '다음 검토일', v: m.next_review_date || '-', key: true, cls: n != null && n < 0 ? 'text-red' : undefined,
      sub: n == null ? null : n < 0 ? `${-n}일 지남` : `D-${n}` },
    { k: '검토 주기', v: `${m.review_cycle_months}개월` },
    { k: '최종 게시일', v: m.published ? fmtDate(m.published.published_at) : '-', sub: m.published?.published_by_name ? `${m.published.published_by_name} 게시` : null },
    { k: '문서 번호', v: m.manual_no },
    { k: '현재 판', v: edition, sub: editionSub },
    { k: '업무분류', v: m.category_name || '미분류', sub: m.department_name },
    { k: '열람 범위', v: m.visibility === 'company' ? '전사 공개' : '부서 한정', sub: m.visibility === 'department' && m.extra_department_ids.length ? `추가 열람 ${m.extra_department_ids.length}개 부서` : null },
  ]
  return (
    <section className="doc-info" aria-label="문서 관리 정보">
      <div className="doc-info-head">
        <span className="doc-info-label">문서 관리 정보{isWork && <span className="doc-info-work"> · 작업본(게시 전) 보기</span>}</span>
        {states.length > 0 && <span className="doc-info-states">{states.map(([t, c]) => <span key={t} className={`st st-${c}`}>{t}</span>)}</span>}
      </div>
      <dl className="doc-info-grid">
        {fields.map((f) => (
          <div key={f.k} className={cx('doc-info-item', f.key && 'key')}>
            <dt>{f.k}</dt>
            <dd className={f.cls}>{f.v}</dd>
            {f.sub && <dd className="doc-info-sub">{f.sub}</dd>}
          </div>
        ))}
      </dl>
      {m.tags.length > 0 && (
        <div className="doc-info-tags">
          <span className="doc-info-tags-k">태그</span>
          {m.tags.map((t) => <Link key={t} to={`/search?q=${encodeURIComponent(t)}`} className="tag">#{t}</Link>)}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- 연결된 문서
function LinkItem({ d }: { d: LinkedDoc }) {
  if (d.access === 'ok' && d.id) {
    return (
      <li className="dl-item">
        <Link to={`/m/${d.id}${d.scope === 'work' ? '?v=work' : ''}`} className="dl-title">{d.title}</Link>
        <span className="dl-meta">{d.manual_no} · {d.department_name}{d.status === 'archived' ? ' · 폐기됨' : ''}</span>
        {d.scope === 'work' && <span className="st st-blue">작업본</span>}
      </li>
    )
  }
  const label = d.access === 'denied' ? '열람 권한이 없는 문서' : d.access === 'archived' ? '폐기된 문서' : '삭제되었거나 없는 문서'
  return <li className="dl-item muted">{label}{d.link_text ? <span className="dl-meta"> · 링크 글자 ‘{d.link_text}’</span> : null}</li>
}

export function LinkedDocs({ id, view, canEdit, reloadKey }: { id: number; view: 'published' | 'work'; canEdit: boolean; reloadKey: string }) {
  const [data, setData] = useState<LinksData | null>(null)
  useEffect(() => {
    let live = true
    api.links(id, view).then((d) => live && setData(d)).catch(() => live && setData(null))
    return () => { live = false }
  }, [id, view, reloadKey])
  if (!data) return null
  const empty = !data.outgoing.length && !data.backlinks.length
  if (empty && !canEdit) return null
  return (
    <section className="doc-links" aria-label="연결된 문서">
      <h3 className="doc-links-title">연결된 문서</h3>
      {empty ? (
        <p className="muted small dl-empty">아직 연결된 문서가 없습니다. 편집 화면에서 <strong>문서 링크</strong> 버튼이나 <kbd>[[</kbd>를 입력해 다른 매뉴얼을 연결하면 양쪽 문서에 함께 표시됩니다.</p>
      ) : (
        <div className="doc-links-grid">
          <div>
            <h4>이 문서가 참조하는 문서 <span className="dl-n">{data.outgoing.length}</span></h4>
            {data.outgoing.length ? <ul className="dl-list">{data.outgoing.map((d, i) => <LinkItem key={i} d={d} />)}</ul> : <p className="muted small">없음</p>}
          </div>
          <div>
            <h4>이 문서를 참조하는 문서 <span className="dl-n">{data.backlinks.length}</span></h4>
            {data.backlinks.length ? <ul className="dl-list">{data.backlinks.map((d) => <LinkItem key={d.id!} d={d} />)}</ul> : <p className="muted small">없음</p>}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- 내려받기
const FORMATS: { f: ExportFormat; label: string; desc: string }[] = [
  { f: 'pdf', label: 'PDF', desc: '인쇄·결재 첨부용' },
  { f: 'docx', label: 'Word (.docx)', desc: 'Word·한컴오피스에서 편집' },
  { f: 'html', label: 'HTML (.html)', desc: '그림 포함, 브라우저로 열기' },
  { f: 'md', label: 'Markdown (.md)', desc: '텍스트 형식, 다른 위키로 옮기기' },
]

export function ExportMenu({ m }: { m: ManualDetail }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const basis = m.view === 'work' ? (m.shown_version_no ? `작업본 v${m.shown_version_no}` : '저장 전 초안') : `공식본 제${m.edition}판`
  const run = async (f: ExportFormat) => {
    setBusy(f)
    try {
      const r = await api.exportManual(m.id, f, m.view)
      if ('print' in r) {
        printHtml(r.print)
        toast("인쇄 창에서 대상(프린터)을 'PDF로 저장'으로 고르세요.", 'info')
      } else {
        downloadBlob(r.blob, r.filename)
        toast(`${r.filename} 내려받았습니다.`)
      }
      setOpen(false)
    } catch (e: any) {
      toast(e.message, 'err')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={cx('btn btn-ghost export-btn', open && 'on')} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="내려받기">
        <Download size={15} /> <span className="hide-sm">내려받기</span> <ChevronDown size={13} />
      </button>
      {open && (
        <div className="popover menu-pop right export-pop" role="menu">
          <div className="pop-title">내려받기 <span className="muted">· {basis} 기준</span></div>
          {FORMATS.map((x) => (
            <button key={x.f} className="menu-item export-item" role="menuitem" disabled={!!busy} onClick={() => run(x.f)}>
              <span className="export-label">{busy === x.f ? '만드는 중…' : x.label}</span>
              <span className="export-desc">{x.desc}</span>
            </button>
          ))}
          <div className="pop-foot muted small">{api.mode === 'demo' ? '데모의 PDF는 인쇄 창의 ‘PDF로 저장’으로 만듭니다.' : '내려받은 기록은 감사 로그에 남습니다.'}</div>
        </div>
      )}
    </div>
  )
}
