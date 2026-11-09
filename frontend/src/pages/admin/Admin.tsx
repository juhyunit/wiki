import { useEffect, useState } from 'react'
import {
  Building2, CalendarClock, CheckCircle2, ClipboardList, Cpu, FileSearch, LayoutDashboard, RefreshCw, ScrollText, ShieldCheck, Upload,
  UserPlus, Users, XCircle,
} from 'lucide-react'
import { api } from '../../api/client'
import type { AdminDept, AdminUser, HrPreview, Summary } from '../../api/types'
import { useApp } from '../../app-context'
import { Link } from '../../components/Link'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Modal, ReviewDate, Spinner, useDialog, useLoad, useToast } from '../../components/ui'
import { navigate } from '../../lib/router'
import { cx, fmtDateTime } from '../../lib/util'
import { CategoryModal } from '../Department'
import { AiTab } from './AiTab'

type Tab = 'overview' | 'approvals' | 'reviews' | 'categories' | 'users' | 'depts' | 'hr' | 'audit' | 'search' | 'ai'

function Overview() {
  const { data, error, reload } = useLoad(() => api.adminOverview(), [])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Spinner />
  const c = data.counts
  return (
    <>
      <div className="kpi-row">
        {c.users != null && <div className="kpi"><span>재직 사용자</span><strong>{c.users}</strong></div>}
        <div className="kpi"><span>공식 매뉴얼</span><strong>{c.published}</strong></div>
        <div className="kpi"><span>작성 중(미게시)</span><strong>{c.drafts}</strong></div>
        <div className="kpi"><span>게시 대기</span><strong className={cx(c.pending > 0 && 'text-amber')}>{c.pending}</strong></div>
        <div className="kpi"><span>검토 지연</span><strong className={cx(c.overdue > 0 && 'text-red')}>{c.overdue}</strong></div>
      </div>
      <section className="panel">
        <div className="panel-head"><h2>부서별 현황</h2></div>
        <div className="table-wrap">
          <table className="table dense">
            <thead><tr><th>부서</th><th>승인 설정</th><th className="num">게시</th><th className="num">작성 중</th><th className="num">게시 대기</th><th className="num">검토 지연</th><th className="num">폐기</th><th>부서 관리자</th></tr></thead>
            <tbody>
              {data.by_dept.map((d) => (
                <tr key={d.id} className={cx(!d.is_active && 'inactive')}>
                  <td><Link to={`/d/${d.id}`}>{d.name}</Link> <span className="muted small">{d.code}</span></td>
                  <td>{d.approval_mode === 'skip' ? <span className="badge badge-outline">승인 생략</span> : <span className="badge badge-navy">승인 필요</span>}</td>
                  <td className="num">{d.published}</td>
                  <td className="num">{d.drafts}</td>
                  <td className={cx('num', d.pending > 0 && 'text-amber strong')}>{d.pending}</td>
                  <td className={cx('num', d.overdue > 0 && 'text-red strong')}>{d.overdue}</td>
                  <td className="num muted">{d.archived}</td>
                  <td className="small">{d.admins.join(', ') || <span className="text-red">미지정</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {data.roles.sys_admin && (
        <section className="panel">
          <div className="panel-head"><h2>결과 없는 검색어 <span className="muted small">매뉴얼이 비어 있는 업무 후보</span></h2></div>
          {data.zero_searches.length ? (
            <div className="table-wrap"><table className="table dense">
              <thead><tr><th>검색어</th><th className="num">횟수</th><th>마지막 검색</th></tr></thead>
              <tbody>{data.zero_searches.map((z) => <tr key={z.query}><td>{z.query}</td><td className="num">{z.n}</td><td className="small muted">{fmtDateTime(z.last_at)}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty>없습니다.</Empty>}
        </section>
      )}
    </>
  )
}

function Approvals() {
  const { reloadTree, refreshMe } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const { data, error, reload } = useLoad(() => api.adminApprovals(), [])
  const act = async (fn: () => Promise<any>, msg: string) => {
    try { await fn(); toast(msg); reload(); reloadTree(); refreshMe() } catch (e: any) { toast(e.message, 'err') }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Spinner />
  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>게시 대기 <span className="muted small">{data.pending.length}건</span></h2></div>
        {data.pending.length ? (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th>매뉴얼</th><th>버전·사유</th><th>요청</th><th>메모</th><th style={{ width: 210 }}>처리</th></tr></thead>
            <tbody>{data.pending.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/m/${a.manual_id}?v=work`}>{a.title}</Link><div className="small muted">{a.manual_no} · {a.department_name}</div></td>
                <td className="small"><strong>v{a.version_no}</strong> {a.change_type}<div className="muted">{a.change_reason}</div></td>
                <td className="small">{a.requester}<div className="muted">{fmtDateTime(a.requested_at)}</div></td>
                <td className="small">{a.request_comment || '-'}</td>
                <td className="row-actions">
                  <Link to={`/m/${a.manual_id}/history?b=latest`} className="btn btn-sm">변경 보기</Link>
                  {a.can_decide ? <>
                    <button className="btn btn-sm" onClick={async () => {
                      const c = await dialog({ title: '반려', input: { label: '반려 사유', required: true, multiline: true }, confirmText: '반려', danger: true })
                      if (c) act(() => api.reject(a.manual_id, c), '반려했습니다.')
                    }}>반려</button>
                    <button className="btn btn-sm btn-primary" onClick={async () => {
                      if (await dialog({ title: '게시', message: `‘${a.title}’ v${a.version_no} — 게시하면 바로 전 직원 화면에 반영됩니다.`, confirmText: '게시' }))
                        act(() => api.publish(a.manual_id), '게시했습니다.')
                    }}>게시</button>
                  </> : <span className="small muted">조회만 가능</span>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon={<CheckCircle2 size={22} />}>처리할 게시 요청이 없습니다.</Empty>}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>최근 처리 내역</h2></div>
        {data.done.length ? (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th>매뉴얼</th><th>버전</th><th>결과</th><th>처리자</th><th>의견</th></tr></thead>
            <tbody>{data.done.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/m/${a.manual_id}`}>{a.title}</Link><div className="small muted">{a.department_name}</div></td>
                <td>v{a.version_no}</td>
                <td>{a.decision === 'approved' ? <span className="badge badge-green">게시</span> : <span className="badge badge-red">반려</span>}</td>
                <td className="small">{a.decider}<div className="muted">{fmtDateTime(a.decided_at)}</div></td>
                <td className="small">{a.comment || '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>처리 내역이 없습니다.</Empty>}
      </section>
    </>
  )
}

function ReviewTable({ items }: { items: Summary[] }) {
  return (
    <div className="table-wrap"><table className="table dense">
      <thead><tr><th>매뉴얼</th><th>부서</th><th>담당자</th><th>판번</th><th>다음 검토일</th></tr></thead>
      <tbody>{items.map((m) => (
        <tr key={m.id}>
          <td><Link to={`/m/${m.id}`}>{m.title}</Link><div className="small muted">{m.manual_no}</div></td>
          <td className="small">{m.department_name}</td>
          <td className="small">{m.owner_name || '-'}{!m.owner_active && <span className="badge badge-red sm">퇴사·전보</span>}</td>
          <td className="small">{m.edition ? `제${m.edition}판` : '-'}</td>
          <td className="small"><ReviewDate d={m.next_review_date} /></td>
        </tr>
      ))}</tbody>
    </table></div>
  )
}

function Reviews() {
  const { data, error, reload } = useLoad(() => api.adminReviews(), [])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Spinner />
  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>담당자 재지정 필요 <span className="muted small">퇴사·전보로 담당자가 비었거나 다른 부서인 매뉴얼</span></h2></div>
        {data.orphans.length ? <ReviewTable items={data.orphans} /> : <Empty icon={<CheckCircle2 size={22} />}>없습니다.</Empty>}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>검토 지연·예정 <span className="muted small">60일 이내</span></h2></div>
        {data.due.length ? <ReviewTable items={data.due} /> : <Empty>없습니다.</Empty>}
      </section>
    </>
  )
}

function Categories() {
  const { me, tree, reloadTree } = useApp()
  const [open, setOpen] = useState<number | null>(null)
  const depts = tree.filter((d) => me.admin_depts.some((a) => a.id === d.id))
  const cur = depts.find((d) => d.id === open)
  return (
    <section className="panel">
      <div className="panel-head"><h2>업무분류 관리</h2></div>
      <div className="table-wrap"><table className="table dense">
        <thead><tr><th>부서</th><th>업무분류</th><th></th></tr></thead>
        <tbody>{depts.map((d) => (
          <tr key={d.id}>
            <td>{d.name}</td>
            <td className="small">{d.categories.map((c) => c.name).join(' · ') || <span className="muted">없음</span>}</td>
            <td className="row-actions"><button className="btn btn-sm" onClick={() => setOpen(d.id)}>편집</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {cur && <CategoryModal dept={cur} onClose={() => setOpen(null)} onChanged={reloadTree} />}
    </section>
  )
}

function UserModal({ user, depts, onClose, onSaved }: { user: AdminUser | null; depts: AdminDept[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const dialog = useDialog()
  const { me } = useApp()
  const [f, setF] = useState({
    employee_no: user?.employee_no || '', username: user?.username || '', name: user?.name || '', position: user?.position || '',
    email: user?.email || '', department_id: user?.department_id || depts[0]?.id, is_active: user ? !!user.is_active : true,
    sys_admin: user?.roles.includes('sys_admin') || false, auditor: user?.roles.includes('auditor') || false,
  })
  const [err, setErr] = useState('')
  const set = (k: string, v: any) => setF({ ...f, [k]: v })
  const save = async () => {
    setErr('')
    try {
      if (user) {
        await api.patchUser(user.id, {
          name: f.name, position: f.position, email: f.email, department_id: Number(f.department_id), is_active: f.is_active,
          roles: [...(f.sys_admin ? ['sys_admin'] : []), ...(f.auditor ? ['auditor'] : [])],
        })
      } else {
        await api.createUser({ employee_no: f.employee_no, username: f.username, name: f.name, position: f.position || null, email: f.email || null, department_id: Number(f.department_id) })
      }
      toast('저장했습니다.')
      onSaved()
      onClose()
    } catch (e: any) {
      setErr(e.message)
    }
  }
  return (
    <Modal title={user ? `사용자 수정 — ${user.name}` : '사용자 추가'} onClose={onClose} width={560}
      footer={<>
        {user && api.mode === 'server' && (
          <button className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={async () => {
            if (!(await dialog({ title: '비밀번호 초기화', message: `${user.name} 님의 비밀번호를 초기화하고 로그인 세션을 끊습니다.`, confirmText: '초기화' }))) return
            try { const r = await api.resetPassword(user.id); await dialog({ title: '임시 비밀번호', message: <>임시 비밀번호: <code className="code-box">{r.temporary_password}</code><br />본인에게 전달하고 로그인 후 바꾸도록 안내하세요.</>, alertOnly: true }) } catch (e: any) { toast(e.message, 'err') }
          }}>비밀번호 초기화</button>
        )}
        <button className="btn" onClick={onClose}>취소</button><button className="btn btn-primary" onClick={save}>저장</button>
      </>}>
      <div className="form-grid">
        <label className="field"><span>사번</span><input value={f.employee_no} disabled={!!user} onChange={(e) => set('employee_no', e.target.value)} /></label>
        <label className="field"><span>아이디</span><input value={f.username} disabled={!!user} onChange={(e) => set('username', e.target.value)} /></label>
        <label className="field"><span>이름</span><input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field"><span>직급</span><input value={f.position} onChange={(e) => set('position', e.target.value)} /></label>
        <label className="field"><span>부서</span>
          <select value={f.department_id} onChange={(e) => set('department_id', Number(e.target.value))}>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        <label className="field"><span>이메일</span><input value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
      </div>
      {user && (
        <div className="check-list">
          <label className="check"><input type="checkbox" checked={f.is_active} disabled={user.id === me.id} onChange={(e) => set('is_active', e.target.checked)} /> 재직(활성)</label>
          <label className="check"><input type="checkbox" checked={f.sys_admin} disabled={user.id === me.id} onChange={(e) => set('sys_admin', e.target.checked)} /> 시스템 관리자</label>
          <label className="check"><input type="checkbox" checked={f.auditor} onChange={(e) => set('auditor', e.target.checked)} /> 감사 역할</label>
        </div>
      )}
      <p className="muted small">부서를 바꾸거나(전보) 비활성화하면(퇴사) 그 사람이 담당이던 매뉴얼에 대해 부서 관리자에게 재지정 알림이 갑니다.{!user && ' 초기 비밀번호는 서버 설정값(기본 1234)입니다.'}</p>
      {err && <div className="form-error">{err}</div>}
    </Modal>
  )
}

function UsersTab() {
  const [q, setQ] = useState('')
  const [dept, setDept] = useState<number | null>(null)
  const [edit, setEdit] = useState<AdminUser | null | 'new'>(null)
  const { data, error, reload } = useLoad(() => api.adminUsers(q, dept), [q, dept])
  const { data: depts } = useLoad(() => api.adminDepartments(), [])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>사용자 <span className="muted small">{data?.length ?? ''}명</span></h2>
        <div className="filter-bar">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·아이디·사번" />
          <select value={dept ?? ''} onChange={(e) => setDept(e.target.value ? Number(e.target.value) : null)}>
            <option value="">전체 부서</option>
            {depts?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><UserPlus size={14} /> 추가</button>
        </div>
      </div>
      {!data ? <Spinner /> : (
        <div className="table-wrap"><table className="table dense">
          <thead><tr><th>사번</th><th>이름</th><th>아이디</th><th>부서</th><th>역할</th><th>상태</th><th></th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id} className={cx(!u.is_active && 'inactive')}>
              <td className="mono small">{u.employee_no}</td>
              <td>{u.name} <span className="muted small">{u.position}</span></td>
              <td className="mono small">{u.username}</td>
              <td className="small">{u.dept_name}</td>
              <td className="small">
                {u.roles.includes('sys_admin') && <span className="badge badge-navy">시스템 관리자</span>}
                {u.roles.includes('auditor') && <span className="badge badge-outline">감사</span>}
                {u.admin_of.map((d) => <span key={d} className="badge badge-amber">{d} 관리자</span>)}
                {!u.roles.length && !u.admin_of.length && <span className="muted">부서원</span>}
              </td>
              <td>{u.is_active ? <span className="badge badge-green">재직</span> : <span className="badge badge-dark">비활성</span>}</td>
              <td className="row-actions"><button className="btn btn-sm" onClick={() => setEdit(u)}>수정</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && depts && <UserModal user={edit === 'new' ? null : edit} depts={depts} onClose={() => setEdit(null)} onSaved={reload} />}
    </section>
  )
}

function DeptsTab() {
  const toast = useToast()
  const dialog = useDialog()
  const { reloadTree } = useApp()
  const { data, error, reload } = useLoad(() => api.adminDepartments(), [])
  const { data: users } = useLoad(() => api.adminUsers(), [])
  const [assign, setAssign] = useState<AdminDept | null>(null)
  const [moving, setMoving] = useState<AdminDept | null>(null)
  const [target, setTarget] = useState<number | ''>('')
  const [pick, setPick] = useState<number | ''>('')
  const [selfPub, setSelfPub] = useState(true)
  const run = async (fn: () => Promise<any>, msg: string) => {
    try { await fn(); toast(msg); reload(); reloadTree() } catch (e: any) { toast(e.message, 'err') }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Spinner />
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>부서·부서 관리자 <span className="muted small">부서마다 정·부 2명 이상 지명을 권장합니다</span></h2>
        <button className="btn btn-sm btn-primary" onClick={async () => {
          const used = new Set(data.map((d) => d.code))
          let next = 1000
          while (used.has(String(next)) && next < 9999) next += 10
          const code = await dialog({ title: '부서 추가', input: { label: '부서 코드 (4자리 숫자 1000~9999, 문서 번호 앞자리로 씁니다)', required: true, placeholder: String(next) } })
          if (!code) return
          if (!/^[1-9][0-9]{3}$/.test(code)) return toast('부서 코드는 4자리 숫자입니다(1000~9999).', 'err')
          if (used.has(code)) return toast('같은 부서 코드가 있습니다.', 'err')
          const name = await dialog({ title: '부서 추가', input: { label: '부서 이름', required: true } })
          if (name) run(() => api.createDept({ code, name }), '부서를 추가했습니다.')
        }}><Building2 size={14} /> 부서 추가</button>
      </div>
      <div className="table-wrap"><table className="table dense">
        <thead><tr><th>코드</th><th>부서</th><th className="num">인원</th><th>게시 승인</th><th>부서 관리자</th><th></th></tr></thead>
        <tbody>{data.map((d) => (
          <tr key={d.id} className={cx(!d.is_active && 'inactive')}>
            <td className="mono">{d.code}</td>
            <td>{d.name}</td>
            <td className="num">{d.members}</td>
            <td>
              <select value={d.approval_mode} onChange={(e) => run(() => api.patchDept(d.id, { approval_mode: e.target.value }), '승인 설정을 바꿨습니다.')}>
                <option value="required">승인 필요(관리자 게시)</option>
                <option value="skip">승인 생략(작성자 게시)</option>
              </select>
            </td>
            <td className="small">
              {d.admins.map((a) => (
                <span key={a.id} className="admin-chip">
                  {a.name}{!a.can_self_publish && <span className="muted" title="직무 분리: 본인 작성분 게시 불가"> (직무분리)</span>}
                  <button aria-label={`${a.name} 해제`} onClick={async () => {
                    if (await dialog({ title: '부서 관리자 해제', message: `${d.name}에서 ${a.name} 님의 부서 관리자 지정을 해제합니다.`, confirmText: '해제', danger: true }))
                      run(() => api.removeDeptAdmin(d.id, a.id), '해제했습니다.')
                  }}>×</button>
                </span>
              ))}
              {d.admins.length === 0 && <span className="text-red">미지정</span>}
            </td>
            <td className="row-actions">
              <button className="btn btn-sm" onClick={async () => {
                const name = await dialog({ title: '부서 이름 변경', message: `부서 코드(${d.code})·문서 번호는 그대로 두고 이름만 바꿉니다.`, input: { label: '새 부서 이름', required: true, defaultValue: d.name } })
                if (name && name !== d.name) run(() => api.patchDept(d.id, { name }), '부서 이름을 바꿨습니다.')
              }}>이름 변경</button>
              <button className="btn btn-sm" onClick={() => { setAssign(d); setPick(''); setSelfPub(true) }}>관리자 지명</button>
              <button className="btn btn-sm btn-ghost" onClick={() => { setMoving(d); setTarget('') }}>매뉴얼 이동</button>
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {moving && (
        <Modal title={`${moving.name} 매뉴얼 일괄 이동`} onClose={() => setMoving(null)} width={440}
          footer={<><button className="btn" onClick={() => setMoving(null)}>취소</button>
            <button className="btn btn-primary" disabled={!target} onClick={async () => {
              const t = data.find((x) => x.id === target)
              if (!(await dialog({ title: '매뉴얼 이동', message: `${moving.name}의 매뉴얼 전부를 ${t?.name}에 옮깁니다. 업무분류는 같은 이름으로 함께 옮겨지고, 문서 번호는 그대로 유지됩니다.`, confirmText: '이동' }))) return
              run(() => api.moveManuals(moving.id, Number(target)), '매뉴얼을 옮겼습니다.')
              setMoving(null)
            }}>이동</button></>}>
          <p className="small muted" style={{ marginTop: 0 }}>부서 통폐합 때 씁니다. 옮긴 뒤 담당자와 열람 범위를 확인하세요.</p>
          <label className="field"><span>옮길 부서</span>
            <select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}>
              <option value="">선택</option>
              {data.filter((x) => x.id !== moving.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select></label>
        </Modal>
      )}
      {assign && (
        <Modal title={`${assign.name} 부서 관리자 지명`} onClose={() => setAssign(null)} width={440}
          footer={<><button className="btn" onClick={() => setAssign(null)}>취소</button>
            <button className="btn btn-primary" disabled={!pick} onClick={() => { run(() => api.setDeptAdmin(assign.id, Number(pick), selfPub), '지명했습니다.'); setAssign(null) }}>지명</button></>}>
          <label className="field"><span>사용자</span>
            <select value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
              <option value="">선택</option>
              {users?.filter((u) => u.is_active).sort((a, b) => (a.department_id === assign.id ? -1 : 1) - (b.department_id === assign.id ? -1 : 1))
                .map((u) => <option key={u.id} value={u.id}>{u.name} {u.position} · {u.dept_name}</option>)}
            </select></label>
          <label className="check"><input type="checkbox" checked={selfPub} onChange={(e) => setSelfPub(e.target.checked)} /> 본인이 고친 내용도 직접 게시 가능</label>
          <p className="muted small">직무 분리가 필요한 부서는 체크를 끄세요. 그러면 본인이 만든 버전은 다른 부서 관리자가 게시해야 합니다.</p>
        </Modal>
      )}
    </section>
  )
}

const SAMPLE_CSV = 'employee_no,name,department_code,position,email,is_active\nE1001,김지현,1010,과장,hr_lead@example.com,1\nE1002,박성우,1010,대리,hr_staff@example.com,1\n'

function HrTab() {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [prev, setPrev] = useState<HrPreview | null>(null)
  const [err, setErr] = useState('')
  const [force, setForce] = useState(false)
  const { data: runs, reload } = useLoad(() => api.hrRuns(), [])
  const preview = async (f: File) => {
    setErr('')
    setPrev(null)
    try { setPrev(await api.hrSync(f, 'preview')) } catch (e: any) { setErr(e.message) }
  }
  const apply = async () => {
    if (!file) return
    setErr('')
    try {
      const r = await api.hrSync(file, 'apply', force)
      setPrev(r)
      toast('인사 동기화를 적용했습니다.')
      reload()
    } catch (e: any) {
      setErr(e.message)
      reload()
    }
  }
  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>인사 데이터 동기화</h2></div>
        <div className="pad">
          <p className="small">인사 시스템에서 내려받은 CSV를 올리면 <strong>새 직원 추가 · 부서 이동 · 퇴사자 비활성화</strong>를 미리 보여 주고 적용합니다. 계정은 지우지 않고 비활성화만 합니다.
            비활성화 대상이 전체의 <strong>5%</strong>를 넘으면 인사 파일 오류로 보고 적용을 멈춥니다.</p>
          <div className="code-box small">{SAMPLE_CSV}</div>
          <div className="inline-form">
            <label className="btn"><Upload size={15} /> CSV 선택
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); preview(f) } e.target.value = '' }} />
            </label>
            {file && <span className="small">{file.name}</span>}
          </div>
          {err && <div className="form-error">{err}</div>}
        </div>
        {prev && (
          <div className="pad">
            <div className="kpi-row">
              <div className="kpi"><span>추가</span><strong>{prev.create.length}</strong></div>
              <div className="kpi"><span>변경</span><strong>{prev.update.length}</strong></div>
              <div className="kpi"><span>비활성화</span><strong className={cx(prev.blocked && 'text-red')}>{prev.deactivate.length} <small>({prev.ratio}%)</small></strong></div>
              <div className="kpi"><span>오류</span><strong className={cx(prev.errors.length > 0 && 'text-red')}>{prev.errors.length}</strong></div>
            </div>
            {prev.errors.map((e) => <div key={e} className="form-error">{e}</div>)}
            {prev.blocked && !prev.applied && <div className="banner banner-red">비활성화 대상이 {prev.ratio}%로 기준({prev.threshold}%)을 넘습니다. 인사 파일이 잘렸거나 잘못됐을 수 있습니다.</div>}
            <div className="hr-lists small">
              {prev.create.length > 0 && <div><strong>추가</strong> {prev.create.map((c) => `${c.name}(${c.department_code})`).join(', ')}</div>}
              {prev.update.length > 0 && <div><strong>변경</strong> {prev.update.map((c) => `${c.name}: ${Object.entries(c.changes).map(([k, v]) => `${k}=${v}`).join(' ')}`).join(' / ')}</div>}
              {prev.deactivate.length > 0 && <div><strong>비활성화</strong> {prev.deactivate.map((c) => `${c.name}(${c.reason})`).join(', ')}</div>}
            </div>
            {prev.applied ? <div className="banner banner-navy"><CheckCircle2 size={16} /> 적용했습니다.</div> : (
              <div className="inline-form">
                {prev.blocked && <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 확인했고 강제 적용</label>}
                <button className="btn btn-primary" disabled={prev.errors.length > 0 || (prev.blocked && !force)} onClick={apply}><RefreshCw size={15} /> 적용</button>
              </div>
            )}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>동기화 기록</h2></div>
        {runs?.length ? (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th>시작</th><th>실행</th><th className="num">추가</th><th className="num">변경</th><th className="num">비활성화</th><th>결과</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}>
                <td className="small">{fmtDateTime(r.started_at)}</td><td className="small">{r.run_by_name}</td>
                <td className="num">{r.created}</td><td className="num">{r.updated}</td><td className="num">{r.deactivated}</td>
                <td className="small">{r.status === 'blocked' ? <span className="badge badge-red">중단</span> : r.status === 'applied_forced' ? <span className="badge badge-amber">강제 적용</span> : <span className="badge badge-green">적용</span>} {r.error && <span className="muted">{r.error}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>기록이 없습니다.</Empty>}
      </section>
    </>
  )
}

const ACTIONS: Record<string, string> = {
  'auth.login': '로그인', 'auth.login_failed': '로그인 실패', 'auth.change_password': '비밀번호 변경',
  'manual.create': '매뉴얼 생성', 'manual.save_version': '버전 저장', 'manual.request_publish': '게시 요청', 'manual.publish': '게시',
  'manual.reject': '반려', 'manual.archive': '폐기', 'manual.unarchive': '폐기 해제', 'manual.delete': '삭제', 'manual.restore': '복원',
  'manual.update_meta': '문서 정보 변경', 'manual.force_unlock': '잠금 강제 해제', 'manual.discard_draft': '작성 중 폐기', 'manual.import_docx': 'DOCX 가져오기',
  'attachment.upload': '첨부 업로드', 'attachment.download': '첨부 다운로드', 'category.create': '분류 추가', 'category.update': '분류 변경', 'category.delete': '분류 삭제',
  'user.create': '사용자 추가', 'user.update': '사용자 변경', 'user.reset_password': '비밀번호 초기화', 'dept.create': '부서 추가', 'dept.update': '부서 변경',
  'dept.admin_assign': '부서 관리자 지명', 'dept.move_manuals': '매뉴얼 일괄 이동', 'dept.admin_remove': '부서 관리자 해제', 'hr_sync.apply': '인사 동기화', 'hr_sync.blocked': '인사 동기화 중단', 'system.seed': '초기 데이터',
  'manual.export': '내려받기', 'ai.settings': 'AI 설정 변경', 'ai.model_pull': 'AI 모델 내려받기', 'ai.model_delete': 'AI 모델 삭제', 'ai.reindex': 'AI 색인 다시 만들기',
}

const DETAIL_LABEL: Record<string, string> = {
  version_no: '버전', edition: '판', change_type: '사유', reason: '내용', comment: '의견', name: '이름', title: '제목', manual_no: '문서번호',
  attachment_id: '첨부', size: '크기', holder: '잠금 보유자', from_version: '복원 원본', new_version: '새 버전', owner: '담당자', visibility: '열람 범위',
  tags: '태그', extra_departments: '추가 열람 부서', review_cycle_months: '검토 주기(월)', next_review_date: '다음 검토일', category_id: '분류',
  user: '대상자', can_self_publish: '본인 게시', created: '추가', updated: '변경', deactivated: '비활성화', forced: '강제', ratio: '비율(%)',
  employee_no: '사번', department_id: '부서', count: '건수', is_active: '재직', roles: '역할', approval_mode: '승인 설정', from: '이전', to: '이후', note: '비고', deactivate: '비활성화',
  format: '형식', view: '보기', model: '모델', chat_model: '답변 모델', embed_model: '임베딩 모델', enabled: '사용', base_url: '모델 서버', provider: '서버 종류',
  top_k: '근거 수', timeout: '시간 제한', reset: '새로 만들기', cleared: '설정에서 뺌',
}
const fmtDetail = (d: Record<string, any>) => Object.entries(d).filter(([, v]) => v !== null && v !== '' && v !== undefined)
  .map(([k, v]) => `${DETAIL_LABEL[k] || k}: ${typeof v === 'boolean' ? (v ? '예' : '아니오') : Array.isArray(v) ? v.join(', ')
    : typeof v === 'object' && 'from' in v && 'to' in v ? `${v.from === '' ? '(없음)' : v.from} → ${v.to === '' ? '(없음)' : v.to}` : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || '-'

function AuditTab() {
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const { data, error, reload } = useLoad(() => api.audit({ action, q, offset }), [action, q, offset])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>감사 로그 <span className="muted small">{data ? `${data.total}건 · ${data.scope === 'all' ? '전체' : '관리 부서 문서만'} · 수정·삭제 불가` : ''}</span></h2>
        <div className="filter-bar">
          <select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0) }}>
            <option value="">전체 행위</option>
            <option value="auth">로그인</option>
            <option value="manual">매뉴얼</option>
            <option value="manual.publish">게시</option>
            <option value="attachment">첨부</option>
            <option value="user">사용자</option>
            <option value="dept">부서·권한</option>
            <option value="hr_sync">인사 동기화</option>
          </select>
          <input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} placeholder="사람·내용 검색" />
        </div>
      </div>
      {!data ? <Spinner /> : (
        <>
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th>일시</th><th>사용자</th><th>행위</th><th>대상</th><th>내용</th><th>IP</th></tr></thead>
            <tbody>{data.items.map((r) => (
              <tr key={r.id}>
                <td className="small mono nowrap">{fmtDateTime(r.at)}</td>
                <td className="small nowrap">{r.actor_name || '-'}</td>
                <td className="small nowrap"><span className={cx('act', r.action.split('.')[0])}>{ACTIONS[r.action] || r.action}</span></td>
                <td className="small">{r.target_label ? <Link to={`/m/${r.target_id}`}>{r.target_label}</Link> : r.target_type ? `${r.target_type} ${r.target_id ?? ''}` : '-'}</td>
                <td className="small muted detail-cell">{fmtDetail(r.detail)}</td>
                <td className="small mono muted nowrap">{r.ip || '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="pager">
            <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>이전</button>
            <span className="small muted">{offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}</span>
            <button className="btn btn-sm" disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>다음</button>
          </div>
        </>
      )}
    </section>
  )
}

function SearchLogsTab() {
  const { data, error, reload } = useLoad(() => api.searchLogs(), [])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return <Spinner />
  const T = ({ rows }: { rows: { query: string; n: number; last_at: string }[] }) => (
    <div className="table-wrap"><table className="table dense">
      <thead><tr><th>검색어</th><th className="num">횟수</th><th>마지막</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.query}><td><Link to={`/search?q=${encodeURIComponent(r.query)}`}>{r.query}</Link></td><td className="num">{r.n}</td><td className="small muted">{fmtDateTime(r.last_at)}</td></tr>)}</tbody>
    </table></div>
  )
  return (
    <div className="two-col">
      <section className="panel"><div className="panel-head"><h2>결과 없는 검색어</h2></div>{data.zero.length ? <T rows={data.zero} /> : <Empty>없습니다.</Empty>}</section>
      <section className="panel"><div className="panel-head"><h2>많이 찾은 검색어</h2></div>{data.top.length ? <T rows={data.top} /> : <Empty>없습니다.</Empty>}</section>
    </div>
  )
}

export function Admin({ tab }: { tab?: string }) {
  const { me } = useApp()
  const sys = me.roles.includes('sys_admin')
  const auditor = me.roles.includes('auditor')
  const deptAdmin = me.admin_depts.length > 0
  const tabs: { id: Tab; label: string; icon: any; show: boolean }[] = [
    { id: 'overview', label: '개요', icon: LayoutDashboard, show: true },
    { id: 'approvals', label: '게시 대기', icon: ClipboardList, show: deptAdmin || sys },
    { id: 'reviews', label: '검토·담당자', icon: CalendarClock, show: deptAdmin || sys },
    { id: 'categories', label: '업무분류', icon: Building2, show: deptAdmin },
    { id: 'users', label: '사용자', icon: Users, show: sys },
    { id: 'depts', label: '부서·관리자', icon: ShieldCheck, show: sys },
    { id: 'hr', label: '인사 동기화', icon: RefreshCw, show: sys },
    { id: 'audit', label: '감사 로그', icon: ScrollText, show: auditor || deptAdmin },
    { id: 'search', label: '검색 로그', icon: FileSearch, show: sys },
    { id: 'ai', label: 'AI 모델', icon: Cpu, show: sys },
  ]
  const visible = tabs.filter((t) => t.show)
  const cur = (visible.find((t) => t.id === tab) || visible[0]).id
  useEffect(() => {
    if (!visible.length) navigate('/', { replace: true })
  }, [])
  return (
    <>
      <PageHeader crumbs={[{ label: '관리' }, { label: visible.find((t) => t.id === cur)?.label || '' }]} />
      <div className="page admin-page">
        <div className="admin-layout">
          <nav className="admin-nav" aria-label="관리 메뉴">
            <div className="admin-role small muted">{sys ? '시스템 관리자' : deptAdmin ? `부서 관리자 · ${me.admin_depts.map((d) => d.name).join(', ')}` : '감사'}</div>
            {visible.map((t) => (
              <Link key={t.id} to={`/admin/${t.id}`} className={cx('admin-tab', cur === t.id && 'active')}>
                <t.icon size={16} /> {t.label}
              </Link>
            ))}
          </nav>
          <div className="admin-main">
            {cur === 'overview' && <Overview />}
            {cur === 'approvals' && <Approvals />}
            {cur === 'reviews' && <Reviews />}
            {cur === 'categories' && <Categories />}
            {cur === 'users' && <UsersTab />}
            {cur === 'depts' && <DeptsTab />}
            {cur === 'hr' && <HrTab />}
            {cur === 'audit' && <AuditTab />}
            {cur === 'search' && <SearchLogsTab />}
            {cur === 'ai' && <AiTab />}
          </div>
        </div>
      </div>
    </>
  )
}
