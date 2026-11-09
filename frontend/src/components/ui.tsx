import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import type { Summary } from '../api/types'
import { cx, daysUntil } from '../lib/util'

// ---------------------------------------------------------------- 모달
export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={cx('modal', props.className)} style={{ maxWidth: props.width || 520 }} ref={ref} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="icon-btn" onClick={props.onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 확인·입력 대화상자 (alert/confirm/prompt 대신)
type DialogOpts = {
  title: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  input?: { label: string; placeholder?: string; required?: boolean; multiline?: boolean; defaultValue?: string }
  alertOnly?: boolean
}
type DialogState = DialogOpts & { resolve: (v: string | boolean | null) => void }

const DialogCtx = createContext<(o: DialogOpts) => Promise<any>>(async () => null)
export const useDialog = () => useContext(DialogCtx)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<DialogState | null>(null)
  const [val, setVal] = useState('')
  const open = useCallback((o: DialogOpts) => {
    setVal(o.input?.defaultValue || '')
    return new Promise((resolve) => setSt({ ...o, resolve }))
  }, [])
  const close = (v: string | boolean | null) => {
    st?.resolve(v)
    setSt(null)
  }
  const canOk = !st?.input?.required || val.trim().length > 0
  return (
    <DialogCtx.Provider value={open}>
      {children}
      {st && (
        <Modal
          title={st.title}
          onClose={() => close(null)}
          width={440}
          footer={
            <>
              {!st.alertOnly && (
                <button className="btn" onClick={() => close(null)}>
                  {st.cancelText || '취소'}
                </button>
              )}
              <button
                className={cx('btn', st.danger ? 'btn-danger' : 'btn-primary')}
                disabled={!canOk}
                onClick={() => close(st.input ? val.trim() : true)}
              >
                {st.confirmText || '확인'}
              </button>
            </>
          }
        >
          {st.message && <div className="dialog-msg">{st.message}</div>}
          {st.input && (
            <label className="field">
              <span>{st.input.label}</span>
              {st.input.multiline ? (
                <textarea autoFocus rows={3} value={val} placeholder={st.input.placeholder} onChange={(e) => setVal(e.target.value)} />
              ) : (
                <input
                  autoFocus
                  value={val}
                  placeholder={st.input.placeholder}
                  onChange={(e) => setVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && canOk && close(val.trim())}
                />
              )}
            </label>
          )}
        </Modal>
      )}
    </DialogCtx.Provider>
  )
}

// ---------------------------------------------------------------- 토스트
type Toast = { id: number; msg: string; kind: 'ok' | 'err' | 'info' }
const ToastCtx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x.slice(-2), { id, msg, kind }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 3200)
  }, [])
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d?.msg) push(d.msg, d.kind || 'info')
    }
    window.addEventListener('ww:toast', h)
    return () => window.removeEventListener('ww:toast', h)
  }, [push])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.kind}`)}>
            {t.kind === 'ok' ? <CheckCircle2 size={16} /> : t.kind === 'err' ? <AlertTriangle size={16} /> : <Info size={16} />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---------------------------------------------------------------- 상태 표시(배지 대신 작은 글자)
type StatusM = Pick<Summary, 'status' | 'review_state' | 'visibility' | 'review_overdue' | 'has_work'>
export function StatusText({ m, showVisibility }: { m: StatusM; showVisibility?: boolean }) {
  const items: [string, string][] = []
  if (m.status === 'draft') items.push(['작성 중', 'gray'])
  if (m.status === 'archived') items.push(['폐기됨', 'gray'])
  if (m.review_state === 'in_review') items.push(['게시 대기', 'amber'])
  else if (m.status === 'published' && m.has_work) items.push(['수정 중', 'blue'])
  if (showVisibility && m.visibility === 'department') items.push(['부서 한정', 'gray'])
  if (m.review_overdue) items.push(['검토 지연', 'red'])
  if (!items.length) return null
  return <span className="st-wrap">{items.map(([t, c]) => <span key={t} className={`st st-${c}`}>{t}</span>)}</span>
}
export function StatusBadges({ m, compact }: { m: StatusM; compact?: boolean }) {
  return <StatusText m={m} showVisibility={!compact} />
}

export function ReviewDate({ d }: { d: string | null }) {
  const n = daysUntil(d)
  if (n === null) return <span className="muted">-</span>
  if (n < 0) return <span className="text-red">{d} ({-n}일 지남)</span>
  if (n <= 30) return <span className="text-amber">{d} (D-{n})</span>
  return <span>{d}</span>
}

export function Edition({ m }: { m: Pick<Summary, 'edition' | 'version_no'> }) {
  if (!m.edition) return <span className="muted">미게시</span>
  return (
    <span>
      제{m.edition}판<span className="muted">(v{m.version_no})</span>
    </span>
  )
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return (
    <div className="spinner">
      <Loader2 size={18} className="spin" /> {label}
    </div>
  )
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div>{children}</div>
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <AlertTriangle size={18} />
      <div>{error}</div>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  )
}

// 간단한 비동기 로더
export function useLoad<T>(fn: () => Promise<T>, deps: any[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const run = useCallback(() => {
    const my = ++seq.current
    setLoading(true)
    setError(null)
    fn()
      .then((d) => my === seq.current && setData(d))
      .catch((e) => my === seq.current && setError(e?.message || '불러오지 못했습니다.'))
      .finally(() => my === seq.current && setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    run()
  }, [run])
  return { data, error, loading, reload: run, setData }
}
