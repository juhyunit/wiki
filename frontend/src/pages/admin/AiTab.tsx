// 관리 › AI 모델: 로컬 모델 서버 연결, 답변·임베딩 모델 고르기·내려받기·삭제·끄기, 질문 기록
import { useEffect, useState } from 'react'
import { HardDriveDownload, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import type { AiAdmin, AiSettings } from '../../api/types'
import { useApp } from '../../app-context'
import { Empty, ErrorBox, Spinner, useDialog, useToast } from '../../components/ui'
import { cx, fileSize, fmtDateTime } from '../../lib/util'

const MODE_TEXT: Record<string, string> = { generate: '근거 문단 + 로컬 모델 답변', extractive: '근거 문단만(생성형 답변 없음)', off: '꺼짐' }
const LOG_MODE: Record<string, string> = { generate: '답변', extractive: '근거만', none: '결과 없음', busy: '대기 초과', error: '오류' }

function ModelPicker({ label, value, onChange, presets, installed, help }: {
  label: string; value: string; onChange: (v: string) => void; presets: AiAdmin['presets']['chat']; installed: string[]; help: string
}) {
  const names = Array.from(new Set([...installed, ...presets.map((p) => p.name)]))
  const custom = !!value && !names.includes(value) && !names.includes(`${value}:latest`)
  return (
    <label className="field">
      <span>{label}</span>
      <select value={custom ? '__custom' : value} onChange={(e) => onChange(e.target.value === '__custom' ? (value || ' ') : e.target.value)}>
        <option value="">사용 안 함</option>
        {names.map((n) => <option key={n} value={n}>{n}{installed.includes(n) ? ' · 설치됨' : ''}</option>)}
        <option value="__custom">직접 입력…</option>
      </select>
      {custom && <input value={value.trim()} onChange={(e) => onChange(e.target.value)} placeholder="예: qwen3:4b" maxLength={100} />}
      <small className="muted">{help}</small>
    </label>
  )
}

export function AiTab() {
  const toast = useToast()
  const dialog = useDialog()
  const { reloadAi } = useApp()
  const [data, setData] = useState<AiAdmin | null>(null)
  const [err, setErr] = useState('')
  const [form, setForm] = useState<AiSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [pullName, setPullName] = useState('')
  const load = () => api.adminAi().then((d) => { setData(d); setForm(d.settings); setErr('') }).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])
  // 내려받는 동안 진행률을 2초마다 갱신
  useEffect(() => {
    if (!data?.pull?.running) return
    const t = window.setInterval(async () => {
      try {
        const p = await api.aiPullStatus()
        setData((d) => (d ? { ...d, pull: p } : d))
        if (!p.running) { load(); toast(p.error ? `내려받지 못했습니다: ${p.error}` : `${p.model} 내려받기를 마쳤습니다.`, p.error ? 'err' : 'ok') }
      } catch {}
    }, 2000)
    return () => window.clearInterval(t)
  }, [data?.pull?.running])

  if (err) return <ErrorBox error={err} onRetry={load} />
  if (!data || !form) return <Spinner />
  const st = data.status
  const installed = st.models.map((m) => m.name)
  const set = (k: keyof AiSettings, v: any) => setForm({ ...form, [k]: v })
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings)
  const save = async (body: Partial<AiSettings> = form) => {
    setBusy(true)
    try {
      const d = await api.saveAi(body)
      setData(d)
      setForm(d.settings)
      reloadAi()
      toast('AI 설정을 저장했습니다.')
    } catch (e: any) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }
  const pull = async (name: string) => {
    if (!name.trim()) return
    try {
      const p = await api.pullAiModel(name.trim())
      setData({ ...data, pull: p })
      toast(`${name} 내려받기를 시작했습니다. 크기에 따라 몇 분 걸립니다.`, 'info')
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  const remove = async (name: string) => {
    const using = [data.settings.chat_model, data.settings.embed_model].some((x) => x && (x === name || `${x}:latest` === name))
    if (!(await dialog({ title: '모델 삭제', message: <>이 PC의 모델 서버에서 <strong>{name}</strong>을(를) 지웁니다.{using && ' 지금 쓰는 모델이라 설정에서도 빠지고, 다시 내려받기 전까지 해당 기능이 꺼집니다.'}</>, confirmText: '삭제', danger: true }))) return
    try {
      const d = await api.deleteAiModel(name)
      setData(d)
      setForm(d.settings)
      reloadAi()
      toast(`${name}을(를) 지웠습니다.`)
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }
  const reindex = async () => {
    if (!(await dialog({ title: '근거 문단 다시 만들기', message: '모든 공식본을 근거 문단으로 다시 나누고 임베딩을 새로 만듭니다. 문서가 많으면 의미 검색이 한동안 낱말 검색만으로 동작합니다.', confirmText: '다시 만들기' }))) return
    try { setData(await api.reindexAi(true)); toast('다시 만드는 중입니다.') } catch (e: any) { toast(e.message, 'err') }
  }
  const pct = data.pull.total ? Math.round(((data.pull.completed || 0) / data.pull.total) * 100) : 0
  const prog = data.progress
  return (
    <>
      {data.demo && <div className="hint hint-gray"><span>데모(브라우저 전용)에는 모델 서버가 없어 <strong>근거 문단 찾기</strong>만 동작합니다. 설정 화면은 PC 설치 버전과 같습니다.</span></div>}
      <div className="kpi-row">
        <div className="kpi"><span>현재 동작</span><strong className="kpi-text">{MODE_TEXT[data.mode]}</strong></div>
        <div className="kpi"><span>모델 서버</span><strong className={cx('kpi-text', st.reachable ? 'text-green' : 'text-red')}>{st.reachable ? `연결됨${st.version ? ` (v${st.version})` : ''}` : '연결 안 됨'}</strong></div>
        <div className="kpi"><span>의미 검색 임베딩</span><strong className="kpi-text">{form.embed_model ? `${prog.done} / ${prog.total} 문단` : '사용 안 함'}</strong></div>
        <div className="kpi"><span>최근 7일 질문</span><strong>{data.questions_7d}</strong></div>
      </div>
      {data.notice && data.mode !== 'generate' && <div className="hint hint-amber"><span>{data.notice}</span></div>}

      <section className="panel">
        <div className="panel-head"><h2>모델 설정 <span className="muted small">바꾼 내용은 감사 로그에 남습니다</span></h2></div>
        <div className="form-grid ai-form">
          <label className="field full check-field">
            <span className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> AI 질의응답 사용</span>
            <small className="muted">끄면 직원 화면에서 'AI 질문'이 사라집니다. 모델을 빼려면 아래 모델을 '사용 안 함'으로 두세요(근거 문단 찾기는 계속 동작).</small>
          </label>
          <label className="field"><span>모델 서버 종류</span>
            <select value={form.provider} onChange={(e) => set('provider', e.target.value)}>
              <option value="ollama">Ollama (권장)</option>
              <option value="openai">OpenAI 호환 로컬 서버 (llama.cpp·vLLM 등)</option>
            </select></label>
          <label className="field"><span>모델 서버 주소</span>
            <input value={form.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="http://127.0.0.1:11434" />
            <small className="muted">이 PC(127.0.0.1)나 사내망 주소만 쓸 수 있습니다. 외부 인터넷 API는 막혀 있습니다.</small></label>
          <ModelPicker label="답변 모델(생성형)" value={form.chat_model} onChange={(v) => set('chat_model', v)} presets={data.presets.chat} installed={installed}
            help="근거 문단을 읽고 답을 씁니다. '사용 안 함'이면 근거 문단만 보여 줍니다." />
          <ModelPicker label="임베딩 모델(의미 검색)" value={form.embed_model} onChange={(v) => set('embed_model', v)} presets={data.presets.embed} installed={installed}
            help="낱말이 달라도 뜻이 비슷한 문단을 찾습니다. '사용 안 함'이면 낱말 검색만 합니다." />
          <label className="field"><span>근거 문단 수</span>
            <select value={form.top_k} onChange={(e) => set('top_k', Number(e.target.value))}>{[3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}개</option>)}</select></label>
          <label className="field"><span>답변 시간 제한</span>
            <select value={form.timeout} onChange={(e) => set('timeout', Number(e.target.value))}>{[60, 120, 180, 300].map((n) => <option key={n} value={n}>{n}초</option>)}</select></label>
        </div>
        <div className="panel-actions">
          <button className="btn" disabled={!dirty || busy} onClick={() => setForm(data.settings)}>되돌리기</button>
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => save()}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head"><h2>설치된 모델 <span className="muted small">{form.provider === 'ollama' ? 'Ollama' : 'OpenAI 호환 서버'}</span></h2>
            <button className="btn btn-sm" onClick={load}><RefreshCw size={13} /> 새로고침</button></div>
          {!st.reachable && <p className="muted small">{st.error || '모델 서버에 연결하지 못했습니다.'} 아래 '설치 안내'를 참고하세요.</p>}
          {st.reachable && (st.models.length ? (
            <div className="table-wrap"><table className="table dense">
              <thead><tr><th>모델</th><th>크기</th><th>쓰임</th><th /></tr></thead>
              <tbody>{st.models.map((m) => {
                const use = [form.chat_model === m.name || `${form.chat_model}:latest` === m.name ? '답변' : '', form.embed_model === m.name || `${form.embed_model}:latest` === m.name ? '임베딩' : ''].filter(Boolean).join(', ')
                return (
                  <tr key={m.name}>
                    <td><span className="mono">{m.name}</span>{m.parameter_size && <span className="muted small"> · {m.parameter_size}{m.quantization ? ` ${m.quantization}` : ''}</span>}</td>
                    <td className="small muted nowrap">{m.size ? fileSize(m.size) : '-'}</td>
                    <td className="small">{use || <span className="muted">-</span>}</td>
                    <td className="right">{form.provider === 'ollama' && <button className="btn btn-sm btn-ghost" onClick={() => remove(m.name)} title="모델 삭제"><Trash2 size={13} /> 삭제</button>}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          ) : <Empty>설치된 모델이 없습니다. 오른쪽에서 내려받으세요.</Empty>)}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>모델 내려받기 <span className="muted small">Ollama · 허용 라이선스 모델</span></h2></div>
          {data.pull.running ? (
            <div className="pull-box">
              <div className="small"><strong className="mono">{data.pull.model}</strong> {data.pull.status} {pct ? `${pct}%` : ''}</div>
              <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            </div>
          ) : data.pull.error ? <div className="hint hint-red"><span>{data.pull.model} 내려받기 실패: {data.pull.error}</span></div> : null}
          <ul className="preset-list">
            {[...data.presets.chat.map((p) => ({ ...p, kind: '답변' })), ...data.presets.embed.map((p) => ({ ...p, kind: '임베딩' }))].map((p) => {
              const have = installed.includes(p.name) || installed.includes(`${p.name}:latest`)
              return (
                <li key={p.name}>
                  <div className="preset-main">
                    <span className="mono strong">{p.name}</span> <span className="muted small">{p.kind} · {p.size} · {p.license}</span>
                    <div className="small muted">{p.note}</div>
                  </div>
                  {have ? <span className="st st-ok">설치됨</span>
                    : <button className="btn btn-sm" disabled={!!data.pull.running || !st.reachable || form.provider !== 'ollama'} onClick={() => pull(p.name)}><HardDriveDownload size={13} /> 내려받기</button>}
                </li>
              )
            })}
          </ul>
          <div className="inline-form">
            <input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="다른 모델 이름(예: qwen3:1.7b)" maxLength={100} aria-label="내려받을 모델 이름" />
            <button className="btn" disabled={!pullName.trim() || !!data.pull.running || !st.reachable || form.provider !== 'ollama'} onClick={() => pull(pullName)}>내려받기</button>
          </div>
          <p className="muted small">모델 라이선스가 사내 허용 목록(MIT·BSD·Apache-2.0 등) 안에 있는지 확인하고 받으세요. Llama·Gemma·EXAONE 등은 별도 라이선스라 기본 추천에서 뺐습니다.</p>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>근거 문단 색인</h2><button className="btn btn-sm" onClick={reindex}><RefreshCw size={13} /> 다시 만들기</button></div>
        <p className="small" style={{ margin: 0 }}>공식본 {prog.total}개 문단{form.embed_model ? ` · 임베딩 ${prog.done}개 완료` : ''}.
          {' '}게시하면 그 문서의 근거 문단이 자동으로 바뀌고, 임베딩은 서버가 뒤에서 채웁니다.{prog.last_error ? <span className="text-red"> 마지막 오류: {prog.last_error}</span> : null}</p>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>최근 질문 <span className="muted small">답이 없던 질문은 매뉴얼 보완 후보입니다</span></h2></div>
        {data.logs.length ? (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th>시각</th><th>사용자</th><th>질문</th><th>방식</th><th className="num">근거</th><th className="num">소요</th></tr></thead>
            <tbody>{data.logs.map((l) => (
              <tr key={l.id}>
                <td className="small muted nowrap">{fmtDateTime(l.at)}</td>
                <td className="small nowrap">{l.user_name || '-'}</td>
                <td className="small">{l.question}{l.error && <div className="text-red small">{l.error}</div>}</td>
                <td className="small nowrap">{LOG_MODE[l.mode] || l.mode}{l.model ? <span className="muted"> · {l.model}</span> : null}</td>
                <td className={cx('num', !l.source_count && 'text-red')}>{l.source_count}</td>
                <td className="num small muted">{l.ms != null ? `${(l.ms / 1000).toFixed(1)}초` : '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>아직 질문이 없습니다.</Empty>}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>설치 안내 <span className="muted small">모델은 이 PC에서만 돌아가고 문서는 밖으로 나가지 않습니다</span></h2></div>
        <ol className="guide small">
          <li><strong>Ollama 설치</strong>(MIT): 인터넷이 되는 PC에서 ollama.com의 Windows 설치 파일을 받아 이 PC에 설치합니다. 설치하면 <span className="mono">http://127.0.0.1:11434</span>에서 바로 동작합니다.</li>
          <li><strong>모델 받기</strong>: 위 '모델 내려받기'에서 <span className="mono">qwen3:4b</span>(답변)와 <span className="mono">bge-m3</span>(의미 검색)를 받습니다. 저사양 PC는 <span className="mono">qwen3:1.7b</span>.</li>
          <li><strong>망분리 PC</strong>: 인터넷 PC에서 <span className="mono">ollama pull qwen3:4b</span>, <span className="mono">ollama pull bge-m3</span>를 실행한 뒤 <span className="mono">%USERPROFILE%\.ollama\models</span> 폴더를 반입해 같은 위치에 복사합니다.</li>
          <li><strong>다른 서버</strong>: llama.cpp(<span className="mono">llama-server</span>)·vLLM처럼 OpenAI 호환 API를 내는 사내 서버는 종류를 'OpenAI 호환'으로 바꾸고 주소를 넣습니다.</li>
          <li><strong>끄기·빼기</strong>: 'AI 질의응답 사용'을 끄면 기능 전체가 꺼지고, 모델을 '사용 안 함'으로 두면 해당 모델만 빠집니다. 설치된 모델 목록의 '삭제'는 디스크에서도 지웁니다.</li>
        </ol>
      </section>
    </>
  )
}
