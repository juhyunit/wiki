import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Eye, GitCompare, RotateCcw } from 'lucide-react'
import { api } from '../api/client'
import type { DiffData, VersionDetail } from '../api/types'
import { useApp } from '../app-context'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Modal, Spinner, useDialog, useLoad, useToast } from '../components/ui'
import { navigate } from '../lib/router'
import { cx, fmtDateTime } from '../lib/util'

export function History({ id, qa, qb }: { id: number; qa?: string | null; qb?: string | null }) {
  const { reloadTree } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const { data, error, loading, reload } = useLoad(() => api.versions(id), [id])
  const [a, setA] = useState<string>('')
  const [b, setB] = useState<string>('')
  const [diff, setDiff] = useState<DiffData | null>(null)
  const [diffErr, setDiffErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<VersionDetail | null>(null)

  // 기본값: 현재 공식본 대비 최신 작업본(기획서 8.1)
  useEffect(() => {
    if (!data) return
    const vs = data.versions
    const latest = String(data.manual.latest_version_id ?? '')
    const pub = String(data.manual.published_version_id ?? '')
    let da = qa && qa !== 'undefined' ? qa : pub
    let db = qb === 'latest' ? latest : qb || (data.draft ? 'draft' : latest)
    if (!da || da === db) da = vs.length > 1 ? String(vs.find((v) => String(v.id) !== db)?.id ?? '') : ''
    setA(da)
    setB(db)
  }, [data])

  useEffect(() => {
    if (!a || !b || a === b) {
      setDiff(null)
      return
    }
    setBusy(true)
    setDiffErr('')
    api.diff(id, a, b).then(setDiff).catch((e) => setDiffErr(e.message)).finally(() => setBusy(false))
  }, [a, b, id])

  const label = useMemo(() => {
    const map: Record<string, string> = { draft: '작성 중' }
    data?.versions.forEach((v) => (map[String(v.id)] = `v${v.version_no}${v.edition_no ? ` · 제${v.edition_no}판` : ''}`))
    return map
  }, [data])

  const restore = async (vid: number, no: number) => {
    const ok = await dialog({ title: `v${no}에서 복원`, message: `v${no}의 내용을 복사해 새 버전을 만듭니다. 공식본이 되려면 다시 게시해야 합니다.`, confirmText: '복원' })
    if (!ok) return
    try {
      const r = await api.restore(id, vid)
      toast(`v${r.version_no}로 복원했습니다.`)
      reload()
      reloadTree()
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }

  if (error) return <><PageHeader crumbs={[{ label: '이력' }]} /><div className="page"><ErrorBox error={error} onRetry={reload} /></div></>
  if (!data) return <><PageHeader crumbs={[{ label: '이력' }]} /><div className="page">{loading && <Spinner />}</div></>

  const options = [...(data.draft ? [{ v: 'draft', l: `작성 중 (${fmtDateTime(data.draft.saved_at)})` }] : []), ...data.versions.map((v) => ({ v: String(v.id), l: label[String(v.id)] }))]

  return (
    <>
      <PageHeader crumbs={[{ label: data.manual.title, to: `/m/${id}` }, { label: '이력·비교' }]}
        actions={<button className="btn" onClick={() => navigate(`/m/${id}`)}>매뉴얼로</button>} />
      <div className="page history-page">
        <div className="page-title-row">
          <div>
            <h1 className="page-title">버전 이력</h1>
            <p className="muted">{data.manual.manual_no} {data.manual.title} · 버전은 지워지지 않고, 복원도 새 버전으로 남습니다.</p>
          </div>
        </div>
        <div className="history-grid">
          <section className="panel">
            <div className="table-wrap">
              <table className="table history-table">
                <thead>
                  <tr>
                    <th title="비교 기준(이전)">A</th><th title="비교 대상(이후)">B</th>
                    <th>버전</th><th>변경 사유</th><th>작성</th><th>상태</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.draft && (
                    <tr className={cx(b === 'draft' && 'sel')}>
                      <td><input type="radio" name="a" checked={a === 'draft'} onChange={() => setA('draft')} aria-label="작성 중을 A로" /></td>
                      <td><input type="radio" name="b" checked={b === 'draft'} onChange={() => setB('draft')} aria-label="작성 중을 B로" /></td>
                      <td><strong>작성 중</strong></td>
                      <td className="muted">자동 저장(버전 아님)</td>
                      <td className="small nowrap">{data.draft.user_name}<div className="muted">{fmtDateTime(data.draft.saved_at).slice(2)}</div></td>
                      <td><span className="badge badge-gray">미저장</span></td>
                      <td></td>
                    </tr>
                  )}
                  {data.versions.map((v) => (
                    <tr key={v.id} className={cx((String(v.id) === a || String(v.id) === b) && 'sel')}>
                      <td><input type="radio" name="a" checked={a === String(v.id)} onChange={() => setA(String(v.id))} aria-label={`v${v.version_no}을 A로`} /></td>
                      <td><input type="radio" name="b" checked={b === String(v.id)} onChange={() => setB(String(v.id))} aria-label={`v${v.version_no}을 B로`} /></td>
                      <td className="nowrap"><strong>v{v.version_no}</strong>{v.edition_no && <div className="small muted">제{v.edition_no}판</div>}</td>
                      <td className="small"><span className="chg-type">{v.change_type || '-'}</span>{v.change_reason && <div className="muted">{v.change_reason}</div>}</td>
                      <td className="small nowrap">{v.author}<div className="muted">{fmtDateTime(v.created_at).slice(2)}</div></td>
                      <td className="small">
                        {v.is_published ? <span className="badge badge-green">현재 공식본</span> : v.published_at ? <span className="badge badge-outline">이전 게시본</span> : v.is_latest ? <span className="badge badge-gray">최신 작업본</span> : null}
                        {v.published_at && <div className="muted">{v.publisher} 게시</div>}
                      </td>
                      <td className="row-actions">
                        <button className="icon-btn sm" title="보기" onClick={() => api.version(id, v.id).then(setViewing).catch((e) => toast(e.message, 'err'))}><Eye size={15} /></button>
                        {data.perms.edit && !v.is_latest && (
                          <button className="icon-btn sm" title="이 버전으로 복원" onClick={() => restore(v.id, v.version_no)}><RotateCcw size={15} /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel diff-panel">
            <div className="diff-bar">
              <GitCompare size={16} />
              <select value={a} onChange={(e) => setA(e.target.value)} aria-label="비교 기준">
                <option value="">선택</option>
                {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              <ArrowRight size={16} />
              <select value={b} onChange={(e) => setB(e.target.value)} aria-label="비교 대상">
                <option value="">선택</option>
                {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              {diff && (
                <span className="diff-stats">
                  <span className="text-green">+{diff.stats.added}</span>
                  <span className="text-red">−{diff.stats.removed}</span>
                  <span className="text-amber">~{diff.stats.changed}</span>
                </span>
              )}
            </div>
            <div className="diff-legend small muted">
              <span><ins>추가</ins></span><span><del>삭제</del></span><span className="leg-mod">수정된 문단</span>
            </div>
            {(!a || !b || a === b) && <div className="empty">서로 다른 두 버전을 A·B로 고르세요.</div>}
            {busy && <Spinner label="비교 중" />}
            {diffErr && <ErrorBox error={diffErr} />}
            {diff && !busy && (
              diff.stats.added + diff.stats.removed + diff.stats.changed === 0
                ? <div className="empty">두 버전의 본문이 같습니다.</div>
                : <div className="prose diff" dangerouslySetInnerHTML={{ __html: diff.html }} />
            )}
          </section>
        </div>
      </div>
      {viewing && (
        <Modal title={`v${viewing.version_no}${viewing.edition_no ? ` · 제${viewing.edition_no}판` : ''} — ${viewing.title}`} onClose={() => setViewing(null)} width={820} className="version-modal">
          <p className="muted small" style={{ marginTop: 0 }}>{viewing.author} · {fmtDateTime(viewing.created_at)} · {viewing.change_type}{viewing.change_reason ? ` — ${viewing.change_reason}` : ''}</p>
          <div className="prose" dangerouslySetInnerHTML={{ __html: viewing.html }} />
        </Modal>
      )}
    </>
  )
}
