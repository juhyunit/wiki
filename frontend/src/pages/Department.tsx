import { useMemo, useState } from 'react'
import { FolderCog, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { api } from '../api/client'
import type { DeptPage, Summary } from '../api/types'
import { useApp } from '../app-context'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Modal, Spinner, useDialog, useLoad, useToast } from '../components/ui'
import { DocTable } from '../components/DocTable'

export function CategoryModal({ dept, onClose, onChanged }: { dept: { id: number; name: string; categories: { id: number; name: string }[] }; onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const dialog = useDialog()
  const [name, setName] = useState('')
  const run = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn()
      toast(msg)
      onChanged()
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  return (
    <Modal title={`${dept.name} 업무분류`} onClose={onClose} width={460} footer={<button className="btn" onClick={onClose}>닫기</button>}>
      <div className="cat-list">
        {dept.categories.map((c) => (
          <div key={c.id} className="cat-row">
            <FolderOpen size={15} />
            <span className="grow">{c.name}</span>
            <button className="btn btn-sm btn-ghost" onClick={async () => {
              const v = await dialog({ title: '분류 이름 바꾸기', input: { label: '새 이름', required: true, defaultValue: c.name } })
              if (v) run(() => api.editCategory(c.id, v), '이름을 바꿨습니다.')
            }}>이름 변경</button>
            <button className="icon-btn sm" title="삭제" onClick={async () => {
              if (await dialog({ title: '분류 삭제', message: `‘${c.name}’ 분류를 삭제합니다. 매뉴얼이 있는 분류는 삭제할 수 없습니다.`, confirmText: '삭제', danger: true }))
                run(() => api.deleteCategory(c.id), '삭제했습니다.')
            }}><Trash2 size={14} /></button>
          </div>
        ))}
        {dept.categories.length === 0 && <div className="muted small">분류가 없습니다.</div>}
      </div>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { run(() => api.addCategory(dept.id, name.trim()), '분류를 추가했습니다.'); setName('') } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="새 분류 이름 (예: 급여·복리후생)" maxLength={50} />
        <button className="btn btn-primary" disabled={!name.trim()}><Plus size={15} /> 추가</button>
      </form>
    </Modal>
  )
}

export function Department({ id }: { id: number }) {
  const { openNewManual, reloadTree } = useApp()
  const { data, error, loading, reload } = useLoad(() => api.department(id), [id])
  const [catOpen, setCatOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const groups = useMemo(() => {
    if (!data) return []
    const live = data.manuals.filter((m) => m.status !== 'archived')
    const out = data.categories.map((c) => ({ key: c.id, name: c.name, rows: live.filter((m) => m.category_id === c.id) }))
    const none = live.filter((m) => !m.category_id || !data.categories.some((c) => c.id === m.category_id))
    if (none.length) out.push({ key: -1, name: '미분류', rows: none })
    return out
  }, [data])
  if (error) return <><PageHeader crumbs={[{ label: '부서' }]} /><div className="page"><ErrorBox error={error} onRetry={reload} /></div></>
  if (!data) return <><PageHeader crumbs={[{ label: '부서' }]} /><div className="page">{loading && <Spinner />}</div></>
  const archived = data.manuals.filter((m) => m.status === 'archived')
  const live = data.manuals.length - archived.length
  return (
    <>
      <PageHeader crumbs={[{ label: '부서' }, { label: data.name, code: data.code }]} actions={<>
        {data.perms.manage_categories && <button className="btn" onClick={() => setCatOpen(true)}><FolderCog size={14} /> <span className="hide-sm">분류 관리</span></button>}
        {data.perms.create && <button className="btn" onClick={() => openNewManual(data.id)}><Plus size={14} /> {data.name}에 작성</button>}
      </>} />
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">{data.name} <span className="code">{data.code}</span></h1>
          <dl className="page-facts">
            <div><dt>매뉴얼</dt><dd>{live}건</dd></div>
            <div><dt>부서 관리자</dt><dd>{data.admins.join(', ') || '미지정'}</dd></div>
            <div><dt>게시 방식</dt><dd>{data.approval_mode === 'skip' ? '작성자 직접 게시(승인 생략)' : '부서 관리자 승인 후 게시'}</dd></div>
          </dl>
        </div>
        <div className="box"><DocTable groups={groups} showDept={false} showNo dates={['review', 'updated']} empty="아직 매뉴얼이 없습니다." /></div>
        {archived.length > 0 && (
          <div className="sub-section">
            <button className="link-btn" onClick={() => setShowArchived(!showArchived)}>
              폐기된 매뉴얼 {archived.length}건 {showArchived ? '숨기기' : '보기'}
            </button>
            {showArchived && <div className="box sub-section"><DocTable rows={archived} showDept={false} showNo dates={['updated']} /></div>}
          </div>
        )}
      </div>
      {catOpen && <CategoryModal dept={data} onClose={() => setCatOpen(false)} onChanged={() => { reload(); reloadTree() }} />}
    </>
  )
}
