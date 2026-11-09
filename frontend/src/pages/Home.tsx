import { api } from '../api/client'
import { useApp } from '../app-context'
import { DocTable } from '../components/DocTable'
import { Link } from '../components/Link'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Spinner, useLoad } from '../components/ui'
import { navigate, useRoute } from '../lib/router'
import { cx, relTime } from '../lib/util'

type Tab = 'recent' | 'fav' | 'mine' | 'review' | 'popular'
const TITLES: Record<Tab, string> = { recent: '최근 게시', fav: '즐겨찾기', mine: '내 작업', review: '검토 예정', popular: '많이 본 문서' }

export function Home() {
  const { me } = useApp()
  const { query } = useRoute()
  const { data, error, loading, reload } = useLoad(() => api.home(), [])
  const tab = ((query.get('tab') as Tab) in TITLES ? query.get('tab') : 'recent') as Tab
  const setTab = (t: Tab) => navigate(t === 'recent' ? '/' : `/?tab=${t}`, { replace: true })
  const tabs: { id: Tab; n?: number }[] = data ? [
    { id: 'recent' }, { id: 'fav', n: data.favorites.length }, { id: 'mine', n: data.my_drafts.length },
    { id: 'review', n: data.review_due.length }, { id: 'popular' },
  ] : []

  return (
    <>
      <PageHeader crumbs={[{ label: '홈' }, { label: TITLES[tab] }]} />
      <div className="page">
        {loading && !data && <Spinner />}
        {error && <ErrorBox error={error} onRetry={reload} />}
        {data && (
          <>
            {data.pending.length > 0 && (
              <div className="notice-bar">
                <strong>{data.pending_role === 'decide' ? `처리할 게시 요청 ${data.pending.length}건` : `게시 요청 중 ${data.pending.length}건`}</strong>
                {data.pending.map((p) => (
                  <Link key={p.id} to={`/m/${p.manual_id}?v=work`} className="notice-item">
                    {p.title} v{p.version_no}
                    <span className="muted"> · {data.pending_role === 'decide' ? `${p.requester} · ` : ''}{relTime(p.requested_at)}</span>
                  </Link>
                ))}
              </div>
            )}
            <div className="tabs-line" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={cx('tab-line', tab === t.id && 'active')} onClick={() => setTab(t.id)}>
                  {TITLES[t.id]}{t.n ? <span className="tab-n">{t.n}</span> : null}
                </button>
              ))}
            </div>
            <div className="box">
            {tab === 'recent' && <DocTable rows={data.recent} dates={['published']} />}
            {tab === 'fav' && <DocTable rows={data.favorites} dates={['updated']} empty="즐겨찾기한 매뉴얼이 없습니다. 문서 제목 옆 별표로 추가합니다." />}
            {tab === 'mine' && <DocTable rows={data.my_drafts} dates={['updated']} empty="작성 중이거나 게시를 기다리는 매뉴얼이 없습니다." />}
            {tab === 'review' && <DocTable rows={data.review_due} dates={['review']} empty={`30일 안에 검토할 ${me.department_name} 매뉴얼이 없습니다.`} />}
            {tab === 'popular' && <DocTable rows={data.popular} dates={['published']} empty="조회 기록이 없습니다." />}
            </div>
          </>
        )}
      </div>
    </>
  )
}
