import { FormEvent, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { DemoUsers, Me } from '../api/types'
import { Logo } from '../components/AppBar'

export function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState<DemoUsers | null>(null)
  useEffect(() => {
    api.demoUsers().then(setDemo).catch(() => setDemo(null))
  }, [])
  const doLogin = async (u: string, p: string) => {
    setBusy(true)
    setErr('')
    try {
      onLogin(await api.login(u, p))
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (username && password) doLogin(username, password)
  }
  const isDemo = api.mode === 'demo'
  return (
    <div className="login-page">
      <div className="login-wrap">
      <div className="login-brand"><Logo size={28} /><strong>WorkWiki</strong><span>사내 업무 매뉴얼{isDemo ? ' · 데모' : ''}</span></div>
      <div className="login-box">
        <h1>{isDemo ? '계정 선택' : '로그인'}</h1>
        <p className="muted">{isDemo ? '역할을 골라 들어갑니다. 모든 부서·직원·매뉴얼은 가상 데이터입니다.' : '사내 계정으로 로그인하세요.'}</p>
        {!isDemo && (
          <form onSubmit={submit} className="login-form">
            <label className="field">
              <span>아이디</span>
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">
              <span>비밀번호</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {err && <div className="form-error">{err}</div>}
            <button className="btn btn-primary btn-block" disabled={busy || !username || !password}>로그인</button>
          </form>
        )}
        {demo?.enabled && (
          <div className="demo-accounts">
            <div className="demo-accounts-title">
              예시 계정{!isDemo && demo.password_hint && <span className="muted"> · 비밀번호 {demo.password_hint}</span>}
            </div>
            <ul>
              {demo.users.map((u) => (
                <li key={u.username}>
                  <button disabled={busy} onClick={() => doLogin(u.username, demo.password_hint || '1234')}>
                    <span className="da-name">{u.name} <span className="muted">{u.position}</span></span>
                    <span className="da-dept muted">{u.department}</span>
                    <span className="da-role muted">{u.role}</span>
                  </button>
                </li>
              ))}
            </ul>
            {isDemo && err && <div className="form-error">{err}</div>}
          </div>
        )}
        <p className="login-foot muted small">
          {isDemo ? '바꾼 내용은 이 브라우저에만 남습니다.' : '운영 전환 시 사내 SSO 로그인으로 바뀝니다.'}
        </p>
      </div>
      </div>
    </div>
  )
}
