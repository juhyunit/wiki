// AI 질문: 질문 → 근거 문단(권한 안의 공식본) → 로컬 모델 답변(연결된 경우). 답은 근거 번호와 함께 보여 준다.
import { FormEvent, Fragment, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CornerDownRight, Loader2, SendHorizontal, Square } from 'lucide-react'
import { api } from '../api/client'
import type { AiEvent, AiSource } from '../api/types'
import { useApp } from '../app-context'
import { Link } from '../components/Link'
import { PageHeader } from '../components/PageHeader'
import { navigate } from '../lib/router'
import { cx, storage } from '../lib/util'

type Phase = 'searching' | 'writing' | 'done' | 'error'
interface Turn {
  id: number
  q: string
  scope: string
  phase: Phase
  mode?: 'generate' | 'extractive' | 'none'
  model?: string | null
  semantic?: boolean
  sources: AiSource[]
  answer: string
  cited: number[]
  notice?: string | null
  error?: string
}

const EXAMPLES = [
  '대출 심사 시 소득 증빙이 필요한 경우는?',
  '연차휴가를 5일 이상 쓰면 누가 결재하나요?',
  '개인정보 유출을 알게 되면 몇 시간 안에 신고해야 하나요?',
  '법인카드로 골프장 결제를 해도 되나요?',
]
const HISTORY_KEY = 'ww:ask-history'

// 근거 문단의 첫 줄에서 본문 검색용 글자를 뽑는다(문서 화면의 근거 강조용)
export function evidenceHint(s: AiSource) {
  let line = s.text.split('\n')[0].replace(/^\[(주의|중요|참고)\]\s*/, '').replace(/^\s*(\d+\.|-|\[[ x]\])\s+/, '')
  if (s.kind === 'table' && line.includes(': ')) line = line.split(' / ')[0].split(': ').slice(1).join(': ')
  return line.slice(0, 40)
}
export const sourceHref = (s: AiSource) =>
  `/m/${s.manual_id}?${new URLSearchParams({ ...(s.anchor ? { a: s.anchor } : {}), t: evidenceHint(s) }).toString()}`

// 모델이 쓴 글은 HTML로 넣지 않고 글자로만 그린다. [n]은 근거로 가는 단추, **굵게**는 굵게
function inline(text: string, onCite: (n: number) => void, max: number): ReactNode[] {
  return text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    const c = part.match(/^\[(\d+)\]$/)
    if (c) {
      const n = Number(c[1])
      return n >= 1 && n <= max ? <button key={i} type="button" className="cite" onClick={() => onCite(n)} title={`근거 ${n} 보기`}>{n}</button> : null
    }
    const b = part.match(/^\*\*([^*]+)\*\*$/)
    return b ? <strong key={i}>{b[1]}</strong> : <Fragment key={i}>{part}</Fragment>
  })
}

function AnswerText({ text, onCite, max }: { text: string; onCite: (n: number) => void; max: number }) {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const L = list.ordered ? 'ol' : 'ul'
    blocks.push(<L key={blocks.length}>{list.items.map((t, i) => <li key={i}>{inline(t, onCite, max)}</li>)}</L>)
    list = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const ul = line.match(/^[-•*]\s+(.*)$/)
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const ordered = !!ol
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push((ul || ol)![1])
      continue
    }
    flush()
    if (line) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''), onCite, max)}</p>)
  }
  flush()
  return <div className="ask-answer-text">{blocks}</div>
}

function SourceCard({ s, cited, active }: { s: AiSource; cited: boolean; active: boolean }) {
  const [open, setOpen] = useState(false)
  const long = s.text.length > 220 || s.text.split('\n').length > 4
  return (
    <li id={`src-${s.n}`} className={cx('src', cited && 'cited', active && 'active')}>
      <div className="src-head">
        <span className="src-n" aria-label={`근거 ${s.n}`}>{s.n}</span>
        <div className="src-where">
          <Link to={`/m/${s.manual_id}`} className="src-title">{s.title}</Link>
          <span className="src-meta">{s.manual_no} · 제{s.edition}판 · {s.department_name}</span>
          {s.heading && <span className="src-heading"><CornerDownRight size={12} /> {s.heading}</span>}
        </div>
        {cited && <span className="src-cited">답변에 인용</span>}
      </div>
      <div className={cx('src-text', long && !open && 'clamp')} dangerouslySetInnerHTML={{ __html: s.text_html.replace(/\n/g, '<br>') }} />
      <div className="src-foot">
        {long && <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>{open ? '접기' : '전체 보기'}</button>}
        <Link to={sourceHref(s)} className="link-btn small src-open">문서에서 보기 <ArrowRight size={13} /></Link>
      </div>
    </li>
  )
}

function TurnView({ t }: { t: Turn }) {
  const [active, setActive] = useState<number | null>(null)
  const cite = (n: number) => {
    setActive(n)
    document.getElementById(`src-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => setActive(null), 2400)
  }
  const generating = t.mode === 'generate'
  return (
    <article className="turn" aria-live="polite">
      <h2 className="turn-q">{t.q}{t.scope && <span className="turn-scope">{t.scope}</span>}</h2>
      <section className="ask-answer">
        <div className="ask-answer-head">
          <span className="ask-answer-label">{generating || t.phase === 'searching' ? '답변' : '찾은 근거'}</span>
          {t.model && <span className="muted small">{t.model} · 이 PC의 로컬 모델</span>}
          {t.semantic && <span className="muted small">낱말 + 의미 검색</span>}
        </div>
        {t.phase === 'searching' && <div className="ask-progress"><Loader2 size={15} className="spin" /> 권한 안의 공식 매뉴얼에서 근거 문단을 찾는 중…</div>}
        {t.phase === 'writing' && !t.answer && <div className="ask-progress"><Loader2 size={15} className="spin" /> 근거 {t.sources.length}건을 읽고 답변을 쓰는 중…</div>}
        {t.answer && <AnswerText text={t.answer} onCite={cite} max={t.sources.length} />}
        {t.phase === 'writing' && t.answer && <span className="caret-blink" aria-hidden="true" />}
        {t.phase === 'done' && !t.answer && t.sources.length > 0 && (
          <p className="ask-extractive">질문과 가장 관련 있는 근거 문단 {t.sources.length}건입니다. 아래 문단을 확인하세요.</p>
        )}
        {t.phase === 'done' && t.sources.length === 0 && <p className="ask-extractive">{t.notice || '관련 문단을 찾지 못했습니다.'}</p>}
        {t.notice && t.sources.length > 0 && <div className="hint hint-gray ask-notice"><span>{t.notice}</span></div>}
        {t.error && <div className="hint hint-red ask-notice"><span>{t.error}</span></div>}
        {t.phase === 'done' && t.answer && <p className="ask-disclaimer">자동으로 만든 답변입니다. 업무 처리 전 근거 문단과 원문을 꼭 확인하세요.</p>}
      </section>
      {t.sources.length > 0 && (
        <section className="ask-sources">
          <h3>근거 문단 <span className="muted">{t.sources.length}건 · 공식본</span></h3>
          <ol className="src-list">{t.sources.map((s) => <SourceCard key={s.n} s={s} cited={t.cited.includes(s.n)} active={active === s.n} />)}</ol>
        </section>
      )}
    </article>
  )
}

export function Ask({ q: initialQ, manualId }: { q: string; manualId: number | null }) {
  const { tree, ai, reloadAi } = useApp()
  const [q, setQ] = useState(initialQ)
  const [scope, setScope] = useState<string>(manualId ? `m${manualId}` : '')
  const [turn, setTurn] = useState<Turn | null>(null)
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(storage.get(HISTORY_KEY) || '[]') } catch { return [] }
  })
  const abort = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const seq = useRef(0)
  const manualTitle = useMemo(() => {
    if (!manualId) return null
    for (const d of tree) for (const m of d.manuals) if (m.id === manualId) return m.title
    return null
  }, [tree, manualId])
  const busy = !!turn && (turn.phase === 'searching' || turn.phase === 'writing')

  useEffect(() => { reloadAi() }, [])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (initialQ.trim()) ask(initialQ)
    else inputRef.current?.focus()
  }, [])

  const scopeLabel = (sc: string) => sc.startsWith('m') ? `이 문서: ${manualTitle || '선택한 문서'}` : sc ? `${tree.find((d) => String(d.id) === sc)?.name || ''} 문서` : ''

  async function ask(text: string) {
    const question = text.trim()
    if (!question) return
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    const id = ++seq.current
    const t: Turn = { id, q: question, scope: scopeLabel(scope), phase: 'searching', sources: [], answer: '', cited: [] }
    setTurn(t)
    const hist = [question, ...history.filter((h) => h !== question)].slice(0, 8)
    setHistory(hist)
    storage.set(HISTORY_KEY, JSON.stringify(hist))
    const upd = (f: (x: Turn) => Turn) => setTurn((cur) => (cur && cur.id === id ? f(cur) : cur))
    const on = (e: AiEvent) => {
      if (e.type === 'meta') upd((x) => ({ ...x, mode: e.mode, model: e.model, semantic: e.semantic, notice: e.notice, phase: e.mode === 'generate' ? 'writing' : x.phase }))
      else if (e.type === 'sources') upd((x) => ({ ...x, sources: e.sources }))
      else if (e.type === 'delta') upd((x) => ({ ...x, answer: x.answer + e.text }))
      else if (e.type === 'done') upd((x) => ({ ...x, phase: 'done', answer: e.answer || x.answer, cited: e.cited, notice: e.notice ?? x.notice }))
    }
    try {
      await api.aiAsk(question, { manual_id: scope.startsWith('m') ? Number(scope.slice(1)) : null, dept: scope && !scope.startsWith('m') ? Number(scope) : null }, on, ctrl.signal)
      upd((x) => (x.phase === 'done' ? x : { ...x, phase: 'done' }))
    } catch (e: any) {
      upd((x) => ({ ...x, phase: 'error', error: e.message }))
    }
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    const v = q.trim()
    if (!v) return
    navigate(`/ask?${new URLSearchParams({ q: v, ...(manualId ? { m: String(manualId) } : {}) })}`, { replace: true })
    ask(v)
  }
  const stop = () => {
    abort.current?.abort()
    setTurn((x) => (x ? { ...x, phase: 'done', notice: x.notice || '답변을 멈췄습니다.' } : x))
  }

  const off = ai?.mode === 'off'
  return (
    <>
      <PageHeader crumbs={[{ label: 'AI 질문' }]} />
      <div className="page ask-page">
        <div className="ask-wrap">
          <div className="ask-intro">
            <h1 className="page-title">매뉴얼에 질문하기</h1>
            <p>게시된 공식 매뉴얼에서 근거 문단을 찾아 답합니다. 열람 권한이 없는 문서는 근거로 쓰지 않습니다.</p>
            {ai && (
              <p className="ask-mode">
                {ai.mode === 'generate' && <><span className="st st-ok">답변 모델 연결됨</span><span className="muted small">{ai.chat_model}{ai.semantic ? ' · 의미 검색 사용' : ''}</span></>}
                {ai.mode === 'extractive' && <><span className="st st-gray">근거 문단만</span><span className="muted small">{ai.notice}</span></>}
                {ai.mode === 'off' && <><span className="st st-gray">사용 안 함</span><span className="muted small">{ai.notice}</span></>}
              </p>
            )}
          </div>
          <form className={cx('ask-form', off && 'disabled')} onSubmit={submit}>
            <textarea ref={inputRef} value={q} rows={2} maxLength={300} disabled={off} aria-label="질문"
              placeholder="예: 대출 심사 시 소득 증빙이 필요한 경우는?"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
            <div className="ask-form-bar">
              <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="질문 범위" disabled={off}>
                <option value="">모든 부서 문서</option>
                {manualId && <option value={`m${manualId}`}>이 문서만: {manualTitle || '선택한 문서'}</option>}
                {tree.map((d) => <option key={d.id} value={String(d.id)}>{d.name} 문서</option>)}
              </select>
              <span className="muted small hide-sm">Enter 보내기 · Shift+Enter 줄바꿈</span>
              {busy
                ? <button type="button" className="btn" onClick={stop}><Square size={13} /> 멈추기</button>
                : <button type="submit" className="btn btn-primary" disabled={off || !q.trim()}><SendHorizontal size={15} /> 질문</button>}
            </div>
          </form>
          {!turn && !off && (
            <div className="ask-suggest">
              <div className="ask-suggest-col">
                <h3>이렇게 물어보세요</h3>
                {EXAMPLES.map((x) => <button key={x} type="button" className="ask-example" onClick={() => { setQ(x); ask(x) }}>{x}</button>)}
              </div>
              {history.length > 0 && (
                <div className="ask-suggest-col">
                  <h3>최근 질문</h3>
                  {history.map((x) => <button key={x} type="button" className="ask-example" onClick={() => { setQ(x); ask(x) }}>{x}</button>)}
                </div>
              )}
            </div>
          )}
          {turn && <TurnView key={turn.id} t={turn} />}
        </div>
      </div>
    </>
  )
}
