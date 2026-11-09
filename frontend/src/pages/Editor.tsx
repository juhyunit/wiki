import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor as TEditor } from '@tiptap/react'
import { AlertTriangle, CheckCircle2, CloudOff, FileClock, FoldHorizontal, Loader2, Lock, MoreHorizontal, RotateCcw, Save, Trash2, UnfoldHorizontal, Unlock, X } from 'lucide-react'
import { api, ApiError } from '../api/client'
import type { Doc, ManualDetail, TreeManual, WorkContent } from '../api/types'
import { useApp } from '../app-context'
import { Link } from '../components/Link'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Modal, Spinner, useDialog, useToast } from '../components/ui'
import { buildExtensions, cleanPastedHTML, extractRtfImages } from '../editor/extensions'
import { fileToEditorHtml, IMPORT_ACCEPT, importKind } from '../editor/importers'
import { Toolbar } from '../editor/Toolbar'
import { navigate } from '../lib/router'
import { useWideView } from '../lib/wide'
import { CHANGE_TYPES, cx, fmtDateTime, fmtTime, storage } from '../lib/util'

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'lost'
// base: 편집을 시작한 버전 번호, serverAt: 이 브라우저가 마지막으로 확인한 서버 작업본 저장 시각
type Backup = { title: string; doc: Doc; at: number; base: number | null; serverAt: string | null }

const backupKey = (id: number) => `ww:draft:${id}`

function readBackup(id: number): Backup | null {
  try {
    return JSON.parse(storage.get(backupKey(id)) || 'null')
  } catch {
    return null
  }
}

const pastedImageFiles = (cd: DataTransfer | null) => Array.from(cd?.files || []).filter((f) => f.type.startsWith('image/'))
// 캡처 이미지(그림만) 또는 웹·Word에서 그림 하나만 복사한 경우: 글자가 없고 그림 파일이 있다
const isImageOnlyPaste = (cd: DataTransfer | null) =>
  pastedImageFiles(cd).length > 0 && (cd?.getData('text/html') || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').length === 0

// data URI 그림을 파일로 바꾼다(CSP상 fetch(data:)는 막혀 있어 직접 디코딩)
function dataUrlToFile(src: string, n: number): File | null {
  const m = src.match(/^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/i)
  if (!m) return null
  const bin = atob(m[3])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase()
  return new File([bytes], `붙여넣은-그림-${n}.${ext}`, { type: m[1].toLowerCase() })
}

function insertImageNode(ed: TEditor, node: any, pos?: number) {
  if (pos != null) return ed.chain().focus().insertContentAt(pos, node).run()
  const { $from, empty } = ed.state.selection
  const block = $from.parent
  if (empty && block.isTextblock && block.content.size > 0) {
    return ed.chain().focus().insertContentAt($from.after($from.depth), node).run()
  }
  return ed.chain().focus().insertContent(node).run()
}

function SaveIndicator({ status, savedAt }: { status: SaveStatus; savedAt: string | null }) {
  if (status === 'saving') return <span className="save-ind"><Loader2 size={14} className="spin" /> 저장 중…</span>
  if (status === 'dirty') return <span className="save-ind muted">입력 중…</span>
  if (status === 'offline') return <span className="save-ind text-amber"><CloudOff size={14} /> 연결 끊김 — 이 브라우저에 임시 보관 중</span>
  if (status === 'lost') return <span className="save-ind text-red"><Lock size={14} /> 편집 잠금 해제됨</span>
  return <span className="save-ind text-green"><CheckCircle2 size={14} /> {savedAt ? `저장됨 ${fmtTime(savedAt)}` : '변경 없음'}</span>
}

function SaveModal({ detail, isFirst, onClose, onSave }: {
  detail: ManualDetail; isFirst: boolean; onClose: () => void
  onSave: (o: { change_type: string; change_reason: string; then: 'none' | 'request' | 'publish'; comment: string }) => Promise<void>
}) {
  const { me } = useApp()
  const types = isFirst ? ['최초 작성', ...CHANGE_TYPES] : CHANGE_TYPES
  const [ct, setCt] = useState(isFirst ? '최초 작성' : '')
  const [reason, setReason] = useState('')
  const skip = detail.dept_approval_mode === 'skip'
  const selfOk = me.admin_depts.find((d) => d.id === detail.department_id)?.can_self_publish !== false
  const canPublish = skip ? detail.perms.edit : detail.perms.publish_any && selfOk
  const [then, setThen] = useState<'none' | 'request' | 'publish'>(canPublish ? 'publish' : 'request')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async () => {
    if (!ct) return setErr('변경 사유를 고르세요.')
    if (ct === '규정 개정' && !reason.trim()) return setErr('규정 개정은 관련 규정이나 개정 내용을 한 줄로 적어 주세요.')
    setBusy(true)
    setErr('')
    try {
      await onSave({ change_type: ct, change_reason: reason.trim(), then, comment: comment.trim() })
    } catch (e: any) {
      setErr(e.message)
      setBusy(false)
    }
  }
  return (
    <Modal title="저장(버전 만들기)" onClose={onClose} width={520}
      footer={<><button className="btn" onClick={onClose} disabled={busy}>취소</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? '저장 중…' : then === 'publish' ? '저장하고 게시' : then === 'request' ? '저장하고 게시 요청' : '저장'}</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>저장하면 새 버전이 이력에 남습니다. 게시 전까지 직원들은 기존 공식본을 봅니다.</p>
      <div className="field">
        <span>변경 사유</span>
        <div className="seg">
          {types.map((t) => <button key={t} type="button" className={cx('seg-btn', ct === t && 'on')} onClick={() => setCt(t)}>{t}</button>)}
        </div>
      </div>
      <label className="field">
        <span>내용 한 줄 {ct === '규정 개정' ? '(필수)' : '(선택)'}</span>
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={ct === '규정 개정' ? '예: 취업규칙 제32조 개정 반영' : '예: 결재선 기준 수정'} />
      </label>
      <div className="field">
        <span>저장한 뒤</span>
        <div className="radio-list">
          <label className="radio"><input type="radio" checked={then === 'none'} onChange={() => setThen('none')} /> 저장만 하기 <span className="muted small">— 나중에 게시</span></label>
          {!skip && detail.perms.request_publish && (
            <label className="radio"><input type="radio" checked={then === 'request'} onChange={() => setThen('request')} /> 부서 관리자에게 게시 요청</label>
          )}
          {canPublish && (
            <label className="radio"><input type="radio" checked={then === 'publish'} onChange={() => setThen('publish')} /> 바로 게시 <span className="muted small">— 제{detail.edition + 1}판{skip ? ' (승인 생략 부서)' : ''}</span></label>
          )}
          {!skip && detail.perms.publish_any && !selfOk && (
            <p className="muted small">이 부서는 직무 분리 설정으로 본인이 만든 버전을 직접 게시할 수 없습니다.</p>
          )}
        </div>
      </div>
      {then !== 'none' && (
        <label className="field"><span>{then === 'request' ? '요청 메모(선택)' : '게시 의견(선택)'}</span>
          <input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} /></label>
      )}
      {err && <div className="form-error">{err}</div>}
    </Modal>
  )
}

function EditorBody({ id, initial, onChange, onReady, onDocLink, readOnly }: {
  id: number; initial: Doc; onChange: (doc: Doc) => void; onReady: (e: TEditor) => void; onDocLink: () => void; readOnly?: boolean
}) {
  const toast = useToast()
  const editorRef = useRef<TEditor | null>(null)
  const pasteInfo = useRef<{ rtf: string[]; imageOnly: boolean }>({ rtf: [], imageOnly: false })
  const inlineDone = useRef(new Set<string>())
  const inlineBusy = useRef(new Set<string>())
  // 붙여넣기로 들어온 data URI 그림을 첨부로 올리고 주소를 바꾼다(본문이 커지지 않게, 서버와 같은 크기 줄이기·형식 검사 적용)
  const uploadInlineImages = useCallback(async () => {
    const ed = editorRef.current
    if (!ed) return
    const srcs = new Set<string>()
    ed.state.doc.descendants((n) => {
      const s = n.type.name === 'image' ? String(n.attrs.src || '') : ''
      if (s.startsWith('data:image/') && !inlineDone.current.has(s) && !inlineBusy.current.has(s)) srcs.add(s)
    })
    let k = 0
    for (const src of srcs) {
      const file = dataUrlToFile(src, ++k)
      if (!file) { inlineDone.current.add(src); continue }
      inlineBusy.current.add(src)
      try {
        const a = await api.upload(id, file)
        inlineDone.current.add(a.url)
        const cur = editorRef.current
        if (!cur) return
        const tr = cur.state.tr
        cur.state.doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.src === src) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: a.url })
        })
        if (tr.docChanged) cur.view.dispatch(tr)
      } catch (e: any) {
        inlineDone.current.add(src)
        toast(e.message, 'err')
      } finally {
        inlineBusy.current.delete(src)
      }
    }
  }, [id])
  const uploadImages = useCallback(async (files: File[], pos?: number) => {
    for (const f of files) {
      try {
        const a = await api.upload(id, f)
        const ed = editorRef.current
        if (!ed) return
        insertImageNode(ed, { type: 'image', attrs: { src: a.url, alt: a.name } }, pos)
      } catch (e: any) {
        toast(e.message, 'err')
      }
    }
  }, [id])
  // 가져오기로 들어온 data URI 그림도 붙여넣기와 같이 첨부로 올린다
  useEffect(() => {
    const h = () => window.setTimeout(uploadInlineImages, 0)
    window.addEventListener('ww:inline-images', h)
    return () => window.removeEventListener('ww:inline-images', h)
  }, [uploadInlineImages])
  const docLinkRef = useRef(onDocLink)
  docLinkRef.current = onDocLink
  const editor = useEditor({
    extensions: buildExtensions({ placeholder: true }),
    content: initial,
    editable: !readOnly,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'prose editor-prose', spellcheck: 'false' },
      // '[['를 입력하면 문서 링크 고르기 창을 연다(입력한 '[['는 지운다)
      handleTextInput: (view, from, to, text) => {
        if (text === '[' && from > 0 && view.state.doc.textBetween(from - 1, from) === '[') {
          view.dispatch(view.state.tr.delete(from - 1, to))
          window.setTimeout(() => docLinkRef.current(), 0)
          return true
        }
        return false
      },
      transformPastedHTML: (html) => {
        const { rtf, imageOnly } = pasteInfo.current
        pasteInfo.current = { rtf: [], imageOnly: false }
        return cleanPastedHTML(html, { rtfImages: rtf, quiet: imageOnly })
      },
      handleDOMEvents: {
        // 편집기가 붙여넣기를 처리하기 전에 Word RTF의 그림을 꺼내 두고, 처리 뒤에 data URI 그림을 첨부로 올린다
        paste: (_view, event) => {
          const cd = (event as ClipboardEvent).clipboardData
          const html = cd?.getData('text/html') || ''
          const rtf = /<img[^>]+src=["']?file:/i.test(html) ? cd?.getData('text/rtf') || '' : ''
          pasteInfo.current = { rtf: rtf ? extractRtfImages(rtf) : [], imageOnly: isImageOnlyPaste(cd) }
          window.setTimeout(uploadInlineImages, 0)
          return false
        },
      },
      handlePaste: (_view, event) => {
        // 그림만 붙여넣은 경우: HTML(외부 주소 그림) 대신 그림 파일을 올린다
        if (isImageOnlyPaste(event.clipboardData)) {
          event.preventDefault()
          uploadImages(pastedImageFiles(event.clipboardData))
          return true
        }
        return false
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        uploadImages(files, pos)
        return true
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getJSON() as Doc),
  })
  useEffect(() => {
    if (editor) {
      editorRef.current = editor
      onReady(editor)
    }
  }, [editor])
  if (!editor) return null
  return <EditorContent editor={editor} className="editor-content" />
}

// 문서 링크 고르기: 내가 볼 수 있는 매뉴얼(왼쪽 메뉴와 같은 목록)에서 찾아 연결한다
function DocLinkPicker({ currentId, onPick, onClose }: { currentId: number; onPick: (m: TreeManual, dept: string) => void; onClose: () => void }) {
  const { tree } = useApp()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const all = useMemo(() => tree.flatMap((d) => d.manuals.filter((m) => m.id !== currentId).map((m) => ({ m, dept: d.name }))), [tree, currentId])
  const list = useMemo(() => {
    const k = q.trim().toLowerCase()
    return (k ? all.filter(({ m, dept }) => `${m.title} ${m.manual_no} ${dept}`.toLowerCase().includes(k)) : all).slice(0, 50)
  }, [all, q])
  useEffect(() => setSel(0), [q])
  return (
    <Modal title="문서 링크" onClose={onClose} width={560}>
      <input className="picker-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="매뉴얼 제목·문서 번호로 찾기" aria-label="매뉴얼 찾기"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
          if (e.key === 'Enter' && list[sel] && !e.nativeEvent.isComposing) { e.preventDefault(); onPick(list[sel].m, list[sel].dept) }
        }} />
      <div className="picker-list" role="listbox">
        {list.length === 0 && <div className="muted small pad">맞는 매뉴얼이 없습니다.</div>}
        {list.map(({ m, dept }, i) => (
          <button key={m.id} type="button" role="option" aria-selected={i === sel} className={cx('picker-item', i === sel && 'on')}
            onMouseEnter={() => setSel(i)} onClick={() => onPick(m, dept)}>
            <span className="picker-title">{m.title}</span>
            <span className="picker-meta">{m.manual_no} · {dept}{m.status === 'draft' ? ' · 작성 중' : ''}</span>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: '10px 0 0' }}>고른 글자가 있으면 그 글자에, 없으면 문서 제목으로 링크합니다.</p>
    </Modal>
  )
}

export function EditorPage({ id }: { id: number }) {
  const { me, tree, reloadTree, refreshMe } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const [wide, toggleWide] = useWideView()
  const [phase, setPhase] = useState<'loading' | 'locked' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ManualDetail | null>(null)
  const [holder, setHolder] = useState<{ user_name: string; since: string } | null>(null)
  const [work, setWork] = useState<WorkContent | null>(null)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [recovered, setRecovered] = useState(false)
  const [showSave, setShowSave] = useState(false)
  const [menu, setMenu] = useState(false)
  const [editor, setEditor] = useState<TEditor | null>(null)
  const [docLink, setDocLink] = useState(false)

  const latest = useRef<{ title: string; doc: Doc } | null>(null)
  const serverAtRef = useRef<string | null>(null)
  const baseRef = useRef<number | null>(null)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const retry = useRef<number | undefined>(undefined)
  const leaving = useRef(false)
  const imgInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const docxInput = useRef<HTMLInputElement>(null)

  // ---------------- 불러오기 + 편집 잠금
  const load = useCallback(async () => {
    setPhase('loading')
    try {
      const d = await api.manual(id, 'work')
      setDetail(d)
      if (!d.perms.edit) {
        setError('이 매뉴얼을 편집할 권한이 없습니다.')
        setPhase('error')
        return
      }
      const lk = await api.lock(id)
      if (!lk.ok) {
        setHolder(lk.holder || null)
        setPhase('locked')
        return
      }
      const w = await api.workContent(id)
      let doc = w.content_json
      let t = w.title
      const b = readBackup(id)
      if (b && JSON.stringify(b.doc) !== JSON.stringify(doc)) {
        // 그 사이 서버 내용이 바뀌지 않았을 때만 자동 복구, 바뀌었으면 묻는다(오래된 내용으로 덮어쓰기 방지)
        const untouched = (b.base ?? null) === (w.base_version_no ?? null) && (b.serverAt ?? null) === (w.draft_saved_at ?? null)
        const ok = untouched || (await dialog({
          title: '저장되지 않은 입력이 있습니다',
          message: <>이 브라우저에 {new Date(b.at).toLocaleString('ko-KR')}에 입력하던 내용이 남아 있습니다. 그 뒤에 서버의 내용이 바뀌었습니다
            ({w.base_version_no ? `현재 v${w.base_version_no}` : '새 매뉴얼'}{w.draft_user_name ? `, ${w.draft_user_name} 님 작성 중` : ''}). 브라우저에 남은 내용으로 바꿀까요?</>,
          confirmText: '브라우저 내용으로 복구', cancelText: '서버 내용 유지',
        }))
        if (ok) {
          doc = b.doc
          t = b.title
          setRecovered(true)
          dirty.current = true
          setStatus('dirty')
        } else storage.del(backupKey(id))
      } else storage.del(backupKey(id))
      serverAtRef.current = w.draft_saved_at
      baseRef.current = w.base_version_no
      latest.current = { title: t, doc }
      setWork({ ...w, content_json: doc })
      setTitle(t)
      setSavedAt(w.draft_saved_at)
      setPhase('ready')
    } catch (e: any) {
      setError(e.message)
      setPhase('error')
    }
  }, [id, dialog])

  useEffect(() => {
    load()
  }, [load])

  // ---------------- 자동 저장(입력이 멈추고 2초 뒤)
  const flush = useCallback(async (keepalive = false) => {
    window.clearTimeout(timer.current)
    if (!dirty.current || !latest.current) return
    const snap = latest.current
    if (!keepalive) setStatus('saving')
    try {
      const r = await api.saveDraft(id, snap.title.trim() || '제목 없음', snap.doc, keepalive)
      if (latest.current === snap) {
        dirty.current = false
        storage.del(backupKey(id))
        if (!leaving.current) setStatus('saved')
      }
      serverAtRef.current = r.saved_at
      if (!leaving.current) setSavedAt(r.saved_at)
    } catch (e) {
      if (leaving.current) return
      if (e instanceof ApiError && e.status === 409) {
        setStatus('lost')
      } else {
        setStatus('offline')
        window.clearTimeout(retry.current)
        retry.current = window.setTimeout(() => flush(), 10000)
      }
    }
  }, [id])

  const schedule = useCallback(() => {
    if (!latest.current) return
    dirty.current = true
    setStatus((s) => (s === 'lost' ? s : 'dirty'))
    storage.set(backupKey(id), JSON.stringify({ ...latest.current, at: Date.now(), base: baseRef.current, serverAt: serverAtRef.current }))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush(), 2000)
  }, [flush, id])

  const onDocChange = useCallback((doc: Doc) => {
    latest.current = { title: latest.current?.title ?? '', doc }
    schedule()
  }, [schedule])

  const onTitleChange = (t: string) => {
    setTitle(t)
    if (latest.current) latest.current = { ...latest.current, title: t }
    schedule()
  }

  // 복구한 내용은 바로 서버 작업본으로 올린다
  useEffect(() => {
    if (phase === 'ready' && recovered) timer.current = window.setTimeout(() => flush(), 500)
  }, [phase, recovered])

  // ---------------- 잠금 유지·해제
  useEffect(() => {
    if (phase !== 'ready') return
    const hb = window.setInterval(async () => {
      try {
        const r = await api.lock(id)
        if (!r.ok) setStatus('lost')
      } catch {}
    }, 60000)
    const onHide = () => {
      leaving.current = true
      flush(true)
      api.unlock(id).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.clearInterval(hb)
      window.removeEventListener('pagehide', onHide)
      leaving.current = true
      window.clearTimeout(retry.current)
      flush(true).finally(() => api.unlock(id).catch(() => {}))
    }
  }, [phase, id])

  // Ctrl+S = 저장(버전 만들기)
  useEffect(() => {
    if (phase !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setShowSave(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  const relock = async () => {
    const r = await api.lock(id)
    if (r.ok) {
      setStatus('dirty')
      flush()
      toast('편집 잠금을 다시 잡았습니다.')
    } else toast(`${r.holder?.user_name} 님이 편집 중입니다. 입력한 내용은 이 브라우저에 보관되어 있습니다.`, 'err')
  }

  const doSave = async (o: { change_type: string; change_reason: string; then: 'none' | 'request' | 'publish'; comment: string }) => {
    if (!latest.current || !detail) return
    window.clearTimeout(timer.current)
    const t = latest.current.title.trim()
    if (!t) throw new Error('제목을 입력하세요.')
    const v = await api.saveVersion(id, { title: t, content_json: latest.current.doc, change_type: o.change_type, change_reason: o.change_reason })
    dirty.current = false
    storage.del(backupKey(id))
    let msg = `저장했습니다 (v${v.version_no})`
    let dest = `/m/${id}?v=work`
    try {
      if (o.then === 'request') {
        await api.requestPublish(id, o.comment || undefined)
        msg = `저장하고 게시를 요청했습니다 (v${v.version_no})`
      } else if (o.then === 'publish') {
        const p = await api.publish(id, o.comment || undefined)
        msg = `게시했습니다 — 제${p.edition}판 (v${v.version_no})`
        dest = `/m/${id}`
      }
    } catch (e: any) {
      toast(`저장은 됐지만 ${o.then === 'publish' ? '게시' : '게시 요청'}하지 못했습니다: ${e.message}`, 'err')
    }
    leaving.current = true
    await api.unlock(id).catch(() => {})
    toast(msg)
    reloadTree()
    refreshMe()
    navigate(dest, { replace: true })
  }

  const insertLink = async () => {
    if (!editor) return
    const prev = editor.getAttributes('link').href || ''
    const v = await dialog({ title: '링크', input: { label: '주소 (비우면 링크 해제)', placeholder: 'https://', defaultValue: prev }, confirmText: '적용' })
    if (v === null) return
    if (!v) return editor.chain().focus().extendMarkRange('link').unsetLink().run()
    const href = /^(https?:|mailto:)/i.test(v) ? v : `https://${v}`
    if (editor.state.selection.empty && !editor.isActive('link'))
      editor.chain().focus().insertContent({ type: 'text', text: v, marks: [{ type: 'link', attrs: { href } }] }).run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }

  const insertDocLink = (m: TreeManual) => {
    setDocLink(false)
    if (!editor) return
    const href = `#/m/${m.id}`
    if (editor.state.selection.empty) {
      editor.chain().focus().insertContent([{ type: 'text', text: m.title, marks: [{ type: 'link', attrs: { href } }] }, { type: 'text', text: ' ' }]).run()
    } else editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }

  const onPickImage = async (files: FileList | null) => {
    if (!files || !editor) return
    for (const f of Array.from(files)) {
      try {
        const a = await api.upload(id, f)
        insertImageNode(editor, { type: 'image', attrs: { src: a.url, alt: a.name } })
      } catch (e: any) {
        toast(e.message, 'err')
      }
    }
  }
  const onPickFile = async (files: FileList | null) => {
    if (!files || !editor) return
    for (const f of Array.from(files)) {
      try {
        const a = await api.upload(id, f)
        editor.chain().focus().insertContent([
          { type: 'text', text: `📎 ${a.name}`, marks: [{ type: 'link', attrs: { href: a.url } }] },
          { type: 'text', text: ' ' },
        ]).run()
        toast('파일을 첨부했습니다. 본문 링크와 문서 하단 첨부 목록에 표시됩니다.')
      } catch (e: any) {
        toast(e.message, 'err')
      }
    }
  }
  // 가져오기: 바꿀지 뒤에 붙일지 묻고 편집기에 넣는다(DOCX는 서버 변환, Markdown·HTML은 이 화면에서 변환)
  const putImported = async (html: string, label: string) => {
    if (!editor) return
    const empty = editor.getText().trim().length === 0
    let mode: 'replace' | 'append' = 'replace'
    if (!empty) {
      const ok = await dialog({ title: `${label} 가져오기`, message: '현재 내용을 가져온 내용으로 바꿀까요? “뒤에 붙이기”를 누르면 현재 내용 뒤에 붙입니다.', confirmText: '바꾸기', cancelText: '뒤에 붙이기' })
      mode = ok ? 'replace' : 'append'
    }
    if (mode === 'replace') editor.chain().focus().setContent(html, { emitUpdate: true }).run()
    else editor.chain().focus('end').insertContent(html).run()
    window.dispatchEvent(new Event('ww:inline-images'))
  }
  const onPickImport = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f || !editor) return
    const kind = importKind(f.name)
    if (!kind) return toast('가져올 수 있는 파일은 Word(.docx), Markdown(.md), HTML(.html)입니다.', 'err')
    if (kind === 'docx') return onPickDocx(files)
    try {
      const r = await fileToEditorHtml(f)
      await putImported(r.html, kind === 'md' ? 'Markdown' : 'HTML')
      if (r.title && !title.trim()) onTitleChange(r.title)
      toast('가져왔습니다. 표·목록·박스가 맞게 들어왔는지 확인하고 저장하세요.')
    } catch (e: any) {
      toast(e.message || '파일을 읽지 못했습니다.', 'err')
    }
  }
  const onPickDocx = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f || !editor) return
    if (api.mode !== 'server') return toast('Word(DOCX) 가져오기는 PC에 설치한 버전(서버)에서 동작합니다. Markdown·HTML은 데모에서도 됩니다.', 'info')
    try {
      toast('DOCX를 변환하는 중입니다…', 'info')
      const r = await api.importDocx(id, f)
      await putImported(r.html, 'DOCX')
      toast('가져왔습니다. 변환 결과는 초안이니 원본(첨부에 보관)과 비교해 다듬어 주세요.')
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }

  const discard = async () => {
    setMenu(false)
    const ok = await dialog({ title: '작성 중 내용 폐기', message: `자동 저장된 작성 중 내용을 지우고 마지막 버전(v${work?.base_version_no})으로 돌아갑니다.`, confirmText: '폐기', danger: true })
    if (!ok) return
    window.clearTimeout(timer.current)
    dirty.current = false
    storage.del(backupKey(id))
    try {
      await api.discardDraft(id)
      leaving.current = true
      await api.unlock(id).catch(() => {})
      toast('작성 중 내용을 폐기했습니다.')
      navigate(`/m/${id}?v=work`, { replace: true })
    } catch (e: any) {
      toast(e.message, 'err')
    }
  }

  const crumbs = useMemo(() => detail ? [
    { label: detail.department_name, to: `/d/${detail.department_id}`, code: tree.find((d) => d.id === detail.department_id)?.code },
    { label: detail.title, to: `/m/${id}${detail.published ? '' : '?v=work'}` },
    { label: '편집' },
  ] : [{ label: '편집' }], [detail, tree])

  if (phase === 'loading') return <><PageHeader crumbs={crumbs} /><div className="page"><Spinner /></div></>
  if (phase === 'error') return <><PageHeader crumbs={crumbs} /><div className="page"><ErrorBox error={error} onRetry={load} /></div></>
  if (phase === 'locked' && detail) {
    return (
      <>
        <PageHeader crumbs={crumbs} actions={<Link to={`/m/${id}`} className="btn">보기로 돌아가기</Link>} />
        <div className="page doc-page"><div className="doc-layout"><article className="doc">
          <div className="banner banner-gray">
            <Lock size={16} /> <span><strong>{holder?.user_name} 님이 {fmtTime(holder?.since)}부터 편집 중입니다.</strong> 동시에 고치면 내용이 섞일 수 있어 읽기 전용으로 열었습니다.</span>
            {detail.perms.force_unlock && (
              <div className="banner-actions">
                <button className="btn btn-sm" onClick={async () => {
                  if (await dialog({ title: '편집 잠금 해제', message: `${holder?.user_name} 님의 잠금을 해제하고 편집을 시작합니다. 상대방이 입력 중이던 내용은 자동 저장분까지만 남습니다.`, confirmText: '해제 후 편집' })) {
                    try { await api.unlock(id, true); load() } catch (e: any) { toast(e.message, 'err') }
                  }
                }}><Unlock size={14} /> 잠금 해제</button>
              </div>
            )}
          </div>
          <h1 className="doc-title">{detail.shown_title}</h1>
          <div className="prose" dangerouslySetInnerHTML={{ __html: detail.content_html }} />
        </article></div></div>
      </>
    )
  }
  if (!detail || !work) return null

  return (
    <>
      <PageHeader crumbs={crumbs} actions={<>
        <SaveIndicator status={status} savedAt={savedAt} />
        <button className={cx('icon-btn hide-md', wide && 'on')} onClick={toggleWide} aria-pressed={wide}
          title={wide ? '기본 폭으로 보기' : '넓게 보기'} aria-label={wide ? '기본 폭으로 보기' : '넓게 보기'}>
          {wide ? <FoldHorizontal size={17} /> : <UnfoldHorizontal size={17} />}
        </button>
        <div className="pop-wrap">
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="더 보기"><MoreHorizontal size={18} /></button>
          {menu && (
            <div className="popover menu-pop right" onMouseLeave={() => setMenu(false)}>
              {detail.perms.view_work && detail.latest_version_no && (
                <Link to={`/m/${id}/history`} className="menu-item"><FileClock size={15} /> 이력·비교</Link>
              )}
              {work.base_version_no != null && (
                <button className="menu-item danger" onClick={discard}><Trash2 size={15} /> 작성 중 내용 폐기</button>
              )}
            </div>
          )}
        </div>
        <button className="btn hide-sm" onClick={() => navigate(`/m/${id}${detail.published ? '' : '?v=work'}`)}>닫기</button>
        <button className="btn btn-primary" onClick={() => setShowSave(true)} disabled={status === 'lost'} title="저장 (Ctrl+S)">저장</button>
      </>} />
      <div className={cx('editor-page', wide && 'wide')}>
        {status === 'lost' && (
          <div className="banner banner-red editor-banner">
            <AlertTriangle size={16} /> <span>편집 잠금이 해제되었습니다(관리자가 해제했거나 15분 이상 응답이 없었음). 입력한 내용은 이 브라우저에 보관되어 있습니다.</span>
            <div className="banner-actions"><button className="btn btn-sm" onClick={relock}><RotateCcw size={14} /> 다시 잠그기</button></div>
          </div>
        )}
        {recovered && (
          <div className="banner banner-navy editor-banner">
            <RotateCcw size={16} /> <span>서버에 저장되지 않은 입력이 이 브라우저에 남아 있어 복구했습니다.</span>
            <div className="banner-actions"><button className="btn btn-sm" onClick={() => setRecovered(false)}>확인</button></div>
          </div>
        )}
        {work.source === 'draft' && !recovered && work.base_version_no != null && (
          <div className="editor-note muted small">
            {work.draft_user_name && work.draft_user_name !== me.name ? `${work.draft_user_name} 님이 ` : ''}{fmtDateTime(work.draft_saved_at)}에 자동 저장한 작성 중 내용을 이어서 엽니다 (마지막 버전 v{work.base_version_no}).
          </div>
        )}
        {editor && (
          <Toolbar editor={editor} onImage={() => imgInput.current?.click()} onFile={() => fileInput.current?.click()} onLink={insertLink}
            onDocLink={() => setDocLink(true)} onImport={() => docxInput.current?.click()} />
        )}
        <div className="editor-sheet">
          <input className="doc-title-input" value={title} onChange={(e) => onTitleChange(e.target.value)} placeholder="매뉴얼 제목" maxLength={200} aria-label="제목" />
          <div className="editor-meta muted small">
            {detail.manual_no} · {detail.department_name} · {work.base_version_no ? `v${work.base_version_no}에서 수정 중` : '새 매뉴얼'}
          </div>
          <EditorBody id={id} initial={work.content_json} onChange={onDocChange} onReady={setEditor} onDocLink={() => setDocLink(true)} />
        </div>
        <input ref={imgInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { onPickImage(e.target.files); e.target.value = '' }} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { onPickFile(e.target.files); e.target.value = '' }} />
        <input ref={docxInput} type="file" accept={IMPORT_ACCEPT} hidden onChange={(e) => { onPickImport(e.target.files); e.target.value = '' }} />
      </div>
      {docLink && <DocLinkPicker currentId={id} onPick={insertDocLink} onClose={() => { setDocLink(false); editor?.commands.focus() }} />}
      {showSave && <SaveModal detail={detail} isFirst={work.base_version_no == null} onClose={() => setShowSave(false)} onSave={doSave} />}
    </>
  )
}
