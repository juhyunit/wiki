import { ReactNode } from 'react'
import type { Summary } from '../api/types'
import { daysUntil, fmtDate } from '../lib/util'
import { Link } from './Link'

// 문서 상태: 한 칸에 주 상태 하나 + 필요할 때 검토 지연
export function StatusCell({ m }: { m: Summary }) {
  let label = '게시', cls = 'ok'
  if (m.status === 'archived') [label, cls] = ['폐기', 'gray']
  else if (m.status === 'draft') [label, cls] = ['작성 중', 'gray']
  else if (m.review_state === 'in_review') [label, cls] = ['게시 대기', 'amber']
  else if (m.has_work) [label, cls] = ['수정 중', 'blue']
  return (
    <span className="status-cell">
      <span className={`st st-${cls}`}>{label}</span>
      {m.review_overdue && <span className="st st-red">검토 지연</span>}
    </span>
  )
}

export function ReviewCell({ d }: { d: string | null }) {
  const n = daysUntil(d)
  if (n === null) return <span className="muted">-</span>
  if (n < 0) return <span className="text-red">{d}</span>
  if (n <= 30) return <span className="text-amber">{d}</span>
  return <span>{d}</span>
}

export type DateCol = { label: string; get: (m: Summary) => ReactNode }

export const DATE_COLS: Record<string, DateCol> = {
  published: { label: '게시일', get: (m) => fmtDate(m.published_at) },
  updated: { label: '수정일', get: (m) => fmtDate(m.updated_at) },
  review: { label: '다음 검토', get: (m) => <ReviewCell d={m.next_review_date} /> },
}

export function DocTable({ rows, groups, showDept = true, showNo = false, dates = ['updated'], empty }: {
  rows?: Summary[]
  groups?: { key: string | number; name: string; rows: Summary[] }[]
  showDept?: boolean
  showNo?: boolean
  dates?: (keyof typeof DATE_COLS)[]
  empty?: ReactNode
}) {
  const cols = 4 + (showDept ? 1 : 0) + (showNo ? 1 : 0) + dates.length
  const all = groups ? groups.flatMap((g) => g.rows) : rows || []
  const row = (m: Summary) => (
    <tr key={m.id}>
      <td className="c-title">
        <Link to={`/m/${m.id}${m.status === 'draft' ? '?v=work' : ''}`} className="doc-link">{m.title}</Link>
        {m.visibility === 'department' && <span className="scope-tag">부서 한정</span>}
        <div className="m-meta">{showDept && `${m.department_name} · `}{m.owner_name || '-'} · {fmtDate(m.updated_at)}</div>
      </td>
      {showNo && <td className="c-no mono hide-sm">{m.manual_no}</td>}
      {showDept && <td className="c-dept hide-sm">{m.department_name}<span className="muted">{m.category_name ? ` / ${m.category_name}` : ''}</span></td>}
      <td className="c-owner hide-sm">{m.owner_name || '-'}{!m.owner_active && <span className="text-red small"> (재지정)</span>}</td>
      <td className="c-ed hide-sm">{m.edition ? `제${m.edition}판` : <span className="muted">미게시</span>}</td>
      {dates.map((d) => <td key={d} className="c-date hide-sm">{DATE_COLS[d].get(m)}</td>)}
      <td className="c-status"><StatusCell m={m} /></td>
    </tr>
  )
  return (
    <div className="table-wrap">
      <table className="table doc-table">
        <thead>
          <tr>
            <th className="c-title">문서명</th>
            {showNo && <th className="c-no hide-sm">문서번호</th>}
            {showDept && <th className="c-dept hide-sm">부서 / 분류</th>}
            <th className="c-owner hide-sm">담당자</th>
            <th className="c-ed hide-sm">판번</th>
            {dates.map((d) => <th key={d} className="c-date hide-sm">{DATE_COLS[d].label}</th>)}
            <th className="c-status">상태</th>
          </tr>
        </thead>
        <tbody>
          {all.length === 0 && <tr><td colSpan={cols} className="empty-cell">{empty || '문서가 없습니다.'}</td></tr>}
          {groups
            ? groups.filter((g) => g.rows.length).map((g) => [
              <tr key={'g' + g.key} className="group-row"><td colSpan={cols}>{g.name} <span className="muted">{g.rows.length}</span></td></tr>,
              ...g.rows.map(row),
            ])
            : all.map(row)}
        </tbody>
      </table>
    </div>
  )
}
