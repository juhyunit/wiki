// Markdown·HTML 파일 가져오기: 파일 → 편집기에 넣을 HTML.
// 편집기(TipTap)는 허용한 노드·마크만 남기고, 저장하면 서버가 JSON에서 HTML을 다시 만든다(클라이언트 HTML은 저장하지 않음).
// WorkWiki에서 내보낸 파일(머리말·주의/중요/참고 박스·체크리스트·그림)은 그대로 돌아오게 맞춘다.
import { marked } from 'marked'
import { cleanPastedHTML } from './extensions'

export const IMPORT_ACCEPT = '.docx,.md,.markdown,.html,.htm,.txt'
const MAX_IMPORT = 5 * 1024 * 1024

export type ImportKind = 'docx' | 'md' | 'html'
export function importKind(name: string): ImportKind | null {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'docx') return 'docx'
  if (['md', 'markdown', 'txt'].includes(ext)) return 'md'
  if (['html', 'htm'].includes(ext)) return 'html'
  return null
}

const ALERT: Record<string, string> = { NOTE: 'info', TIP: 'info', WARNING: 'warning', IMPORTANT: 'danger', CAUTION: 'danger' }

function frontMatter(src: string): { body: string; title?: string } {
  const m = src.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { body: src.replace(/^﻿/, '') }
  const t = m[1].match(/^title:\s*(.+)$/m)?.[1]?.trim()
  let title: string | undefined
  if (t) {
    try { title = t.startsWith('"') ? JSON.parse(t) : t.replace(/^'|'$/g, '') } catch { title = t }
  }
  return { body: src.slice(m[0].length), title }
}

// 붙여넣기 정리 전에 WorkWiki 고유 구조(박스·체크리스트·그림 캡션·내부 링크)를 편집기가 읽는 모양으로 바꾼다
function normalize(doc: Document) {
  doc.querySelectorAll('.callout-label').forEach((n) => n.remove())
  doc.querySelectorAll('.table-wrap').forEach((w) => w.replaceWith(...Array.from(w.childNodes)))
  doc.querySelectorAll('figure').forEach((f) => {
    const img = f.querySelector('img')
    const cap = f.querySelector('figcaption')?.textContent?.trim()
    if (img && cap) img.setAttribute('title', cap)
    if (img) f.replaceWith(img)
  })
  // GitHub 알림 문법(> [!NOTE]) → 참고·주의·중요 박스
  doc.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild
    const m = p?.textContent?.match(/^\s*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/i)
    if (!p || !m) return
    const div = doc.createElement('div')
    div.setAttribute('data-callout', ALERT[m[1].toUpperCase()])
    // 첫 줄의 [!TYPE] 표시만 지운다
    const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const first = walker.nextNode() as Text | null
    if (first) first.textContent = (first.textContent || '').replace(/^\s*\[![A-Za-z]+\]\s*/, '')
    if (p.firstChild?.nodeName === 'BR') p.firstChild.remove()
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove()
    while (bq.firstChild) div.appendChild(bq.firstChild)
    bq.replaceWith(div)
  })
  // Markdown 체크리스트(<li><input type=checkbox> 글자) → 편집기 체크리스트
  doc.querySelectorAll('ul').forEach((ul) => {
    const items = Array.from(ul.children).filter((c) => c.tagName === 'LI')
    if (!items.length || !items.every((li) => li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]'))) return
    ul.setAttribute('data-type', 'taskList')
    items.forEach((li) => {
      const box = li.querySelector('input[type=checkbox]') as HTMLInputElement
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-checked', box.hasAttribute('checked') ? 'true' : 'false')
      box.remove()
      if (!li.querySelector(':scope > p')) {
        const p = doc.createElement('p')
        Array.from(li.childNodes).filter((n) => !(n.nodeType === 1 && ['UL', 'OL'].includes((n as Element).tagName))).forEach((n) => p.appendChild(n))
        li.insertBefore(p, li.firstChild)
      }
    })
  })
  // 내보낸 파일 안의 같은 서버 문서 링크(http://주소/#/m/12)는 다시 내부 링크로
  doc.querySelectorAll('a[href]').forEach((a) => {
    const h = a.getAttribute('href') || ''
    const m = h.match(/^(https?:\/\/[^#]*)?#\/m\/(\d+)/)
    if (m && (!m[1] || m[1].replace(/\/$/, '') === location.origin + location.pathname.replace(/\/[^/]*$/, ''))) a.setAttribute('href', `#/m/${m[2]}`)
  })
}

export async function fileToEditorHtml(file: File): Promise<{ html: string; title?: string; kind: ImportKind }> {
  const kind = importKind(file.name)
  if (!kind || kind === 'docx') throw new Error('Markdown(.md)·HTML(.html) 파일만 여기서 가져옵니다.')
  if (file.size > MAX_IMPORT) throw new Error('가져올 파일은 5MB까지입니다. 큰 그림은 따로 올려 주세요.')
  const text = await file.text()
  let html: string
  let title: string | undefined
  if (kind === 'md') {
    const fm = frontMatter(text)
    title = fm.title
    html = marked.parse(fm.body, { gfm: true, breaks: false, async: false }) as string
  } else {
    html = text
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // WorkWiki에서 내보낸 HTML이면 본문(.prose)만 가져온다(제목·문서 정보 표는 편집기 머리에 따로 있음)
  const prose = doc.querySelector('.prose')
  if (prose) {
    title = title || doc.querySelector('.doc-title')?.textContent?.trim() || undefined
    doc.body.innerHTML = prose.innerHTML
  }
  const first = doc.body.firstElementChild
  if (first?.tagName === 'H1' && (!title || first.textContent?.trim() === title)) {
    title = title || first.textContent?.trim() || undefined
    first.remove()
  }
  normalize(doc)
  return { html: cleanPastedHTML(doc.body.innerHTML), title, kind }
}
