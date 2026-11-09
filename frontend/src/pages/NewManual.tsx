import { useEffect, useMemo, useState } from 'react'
import { FileText, ListChecks, File } from 'lucide-react'
import { api } from '../api/client'
import type { Template } from '../api/types'
import { useApp } from '../app-context'
import { Modal, useToast } from '../components/ui'
import { navigate } from '../lib/router'
import { cx } from '../lib/util'

export function NewManualModal({ deptId, onClose }: { deptId?: number; onClose: () => void }) {
  const { me, tree, reloadTree } = useApp()
  const toast = useToast()
  const choices = useMemo(() => {
    const ids = new Set<number>([...(me.department_id ? [me.department_id] : []), ...me.admin_depts.map((d) => d.id)])
    return tree.filter((d) => ids.has(d.id))
  }, [tree, me])
  const [dept, setDept] = useState<number>(deptId && choices.some((d) => d.id === deptId) ? deptId : choices[0]?.id)
  const [title, setTitle] = useState('')
  const [cat, setCat] = useState<number | ''>('')
  const [vis, setVis] = useState<'company' | 'department'>('company')
  const [templates, setTemplates] = useState<Template[]>([])
  const [tpl, setTpl] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.templates().then((t) => {
      setTemplates(t)
      setTpl(t[0]?.id ?? null)
    })
  }, [])
  const cats = tree.find((d) => d.id === dept)?.categories || []
  const submit = async () => {
    if (!title.trim()) return setErr('제목을 입력하세요.')
    setBusy(true)
    try {
      const r = await api.createManual({ title: title.trim(), department_id: dept, category_id: cat || null, template_id: tpl, visibility: vis })
      reloadTree()
      onClose()
      toast('새 매뉴얼을 만들었습니다. 내용을 작성한 뒤 ‘저장’하세요.')
      navigate(`/m/${r.id}/edit`)
    } catch (e: any) {
      setErr(e.message)
      setBusy(false)
    }
  }
  const icon = (name: string) => (name.includes('체크') ? <ListChecks size={18} /> : name.includes('빈') ? <File size={18} /> : <FileText size={18} />)
  if (!choices.length) {
    return <Modal title="새 매뉴얼" onClose={onClose}><p>소속 부서가 없어 매뉴얼을 만들 수 없습니다.</p></Modal>
  }
  return (
    <Modal title="새 매뉴얼" onClose={onClose} width={580}
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn-primary" onClick={submit} disabled={busy}>만들고 편집하기</button></>}>
      <label className="field">
        <span>제목</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 출장비 정산 방법" maxLength={200} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      <div className="form-grid">
        <label className="field"><span>담당 부서</span>
          <select value={dept} onChange={(e) => { setDept(Number(e.target.value)); setCat('') }} disabled={choices.length < 2}>
            {choices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        <label className="field"><span>업무분류</span>
          <select value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
            <option value="">미분류</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
      </div>
      <div className="field">
        <span>열람 범위</span>
        <div className="seg">
          <button type="button" className={cx('seg-btn', vis === 'company' && 'on')} onClick={() => setVis('company')}>전사 공개</button>
          <button type="button" className={cx('seg-btn', vis === 'department' && 'on')} onClick={() => setVis('department')}>부서 한정</button>
        </div>
      </div>
      <div className="field">
        <span>템플릿</span>
        <div className="tpl-list">
          {templates.map((t) => (
            <button key={t.id} type="button" className={cx('tpl', tpl === t.id && 'on')} onClick={() => setTpl(t.id)}>
              {icon(t.name)}
              <span><strong>{t.name}</strong><span className="small muted">{t.description}</span></span>
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">문서 번호는 자동으로 붙습니다. 만든 직후에는 작성 중 상태라 부서원만 볼 수 있습니다.</p>
      {err && <div className="form-error">{err}</div>}
    </Modal>
  )
}
