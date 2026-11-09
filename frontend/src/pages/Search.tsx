import { FormEvent, useEffect, useRef, useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { api } from '../api/client'
import type { SearchData } from '../api/types'
import { useApp } from '../app-context'
import { Link } from '../components/Link'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Spinner, StatusText } from '../components/ui'
import { navigate } from '../lib/router'
import { fmtDate } from '../lib/util'

type Params = { q: string; dept: number | null; cat: number | null; period: string; work: boolean }

export function Search(p: Params) {
  const { tree, me } = useApp()
  const [q, setQ] = useState(p.q)
  const [data, setData] = useState<SearchData | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const canWork = !!me.department_id || me.admin_depts.length > 0
  const cats = tree.find((d) => d.id === p.dept)?.categories || []

  useEffect(() => {
    setQ(p.q)
    if (!p.q.trim()) {
      setData(null)
      document.getElementById('global-search')?.focus()
      return
    }
    setBusy(true)
    setErr('')
    api.search(p.q, { dept: p.dept, cat: p.cat, period: p.period, work: p.work }).then(setData).catch((e) => setErr(e.message)).finally(() => setBusy(false))
  }, [p.q, p.dept, p.cat, p.period, p.work])

  const go = (o: Partial<Params>) => {
    const n = { ...p, q, ...o }
    if (o.dept !== undefined && o.dept !== p.dept) n.cat = null
    const sp = new URLSearchParams()
    if (n.q.trim()) sp.set('q', n.q.trim())
    if (n.dept) sp.set('dept', String(n.dept))
    if (n.cat) sp.set('cat', String(n.cat))
    if (n.period) sp.set('period', n.period)
    if (n.work) sp.set('work', '1')
    navigate(`/search?${sp.toString()}`, { replace: true })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    go({})
  }
  const codeOf = (id: number) => tree.find((d) => d.id === id)?.code

  return (
    <>
      <PageHeader crumbs={[{ label: '검색' }]} />
      <div className="page">
        <div className="page-head compact">
          <h1 className="page-title">{p.q ? <>검색 결과 <span className="q">‘{p.q}’</span></> : '검색'}</h1>
        </div>
        <div className="filters">
          <select className="filter" value={p.dept ?? ''} onChange={(e) => go({ dept: e.target.value ? Number(e.target.value) : null })} aria-label="부서">
            <option value="">모든 부서</option>
            {tree.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="filter" value={p.cat ?? ''} disabled={!p.dept} onChange={(e) => go({ cat: e.target.value ? Number(e.target.value) : null })} aria-label="업무분류">
            <option value="">모든 분류</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="filter" value={p.period} onChange={(e) => go({ period: e.target.value })} aria-label="게시 기간">
            <option value="">모든 기간</option>
            <option value="1m">최근 1개월</option>
            <option value="6m">최근 6개월</option>
            <option value="1y">최근 1년</option>
          </select>
          {canWork && (
            <label className="check small">
              <input type="checkbox" checked={p.work} onChange={(e) => go({ work: e.target.checked })} /> 우리 부서 작업본 포함
            </label>
          )}
        </div>

        {busy && <Spinner label="검색 중" />}
        {err && <ErrorBox error={err} />}
        {!busy && data && (
          <p className="result-count">{data.total ? `${data.total}건 · 제목 일치 › 태그 › 본문 순` : `‘${p.q}’에 맞는 매뉴얼이 없습니다. 다른 낱말로 찾아보세요.`}</p>
        )}
        {!busy && data && data.results.length > 0 && (
          <div className="results">
            {data.results.map((r) => (
              <Link key={r.id} to={`/m/${r.id}${r.scope === 'work' ? '?v=work' : ''}`} className="result">
                <div className="result-title">
                  <span dangerouslySetInnerHTML={{ __html: r.title_html }} />
                  {r.scope === 'work' && <span className="st st-blue">작업본</span>}
                  <StatusText m={r} />
                </div>
                <div className="result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet_html }} />
                <div className="result-meta">
                  <span>{r.department_name}{r.category_name ? ` / ${r.category_name}` : ''}</span>
                  <span className="sep">·</span><span>{r.manual_no}</span>
                  {r.edition > 0 && <><span className="sep">·</span><span>제{r.edition}판 · {fmtDate(r.published_at)}</span></>}
                </div>
              </Link>
            ))}
          </div>
        )}
        {!p.q && <p className="muted search-help">위쪽 검색창에 검색어를 넣으세요. 제목·태그·본문에서 낱말 일부만 넣어도 찾습니다. 권한이 없는 부서 한정 문서는 결과에 나오지 않습니다.</p>}
      </div>
    </>
  )
}
