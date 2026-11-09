import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import { normalizePastedColor } from './textStyle'

export type CalloutType = 'warning' | 'danger' | 'info'
export const CALLOUT_LABEL: Record<CalloutType, string> = { warning: '주의', danger: '중요', info: '참고' }

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      toggleCallout: (type: CalloutType) => ReturnType
    }
  }
}

// 업무 블록: 주의·중요·참고 3종만(기획서 7.1)
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => {
          const t = el.getAttribute('data-callout')
          return t === 'warning' || t === 'danger' || t === 'info' ? t : 'info'
        },
        renderHTML: (a) => ({ 'data-callout': a.type }),
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-callout]',
        contentElement: (el: HTMLElement) => (el.querySelector(':scope > .callout-body') as HTMLElement) || el,
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: `callout callout-${node.attrs.type}` }), 0]
  },
  addCommands() {
    return {
      toggleCallout:
        (type) =>
        ({ editor, commands }) => {
          if (editor.isActive('callout', { type })) return commands.lift('callout')
          if (editor.isActive('callout')) return commands.updateAttributes('callout', { type })
          return commands.wrapIn('callout', { type })
        },
    }
  },
})

export function buildExtensions(opts: { placeholder?: boolean } = {}) {
  const exts: any[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, autolink: true, protocols: ['mailto'], HTMLAttributes: { rel: 'noopener noreferrer', target: null } },
    }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 60 } }),
    Image.configure({
      inline: false,
      allowBase64: true,
      resize: { enabled: true, directions: ['right', 'bottom-right', 'left', 'bottom-left'], minWidth: 60, minHeight: 40, alwaysPreserveAspectRatio: true },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Callout,
    // 글자색·글꼴·글자 크기(값은 textStyle.ts 허용 목록에서만 고르고, 서버가 다시 걸러서 그린다)
    TextStyle,
    Color,
    FontFamily,
    FontSize,
  ]
  if (opts.placeholder)
    exts.push(
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? '제목' : '내용을 입력하세요. 한글·Word에서 복사해 붙여넣어도 표와 목록이 유지됩니다.'),
      }),
    )
  return exts
}

// Word가 클립보드에 함께 넣는 RTF에서 그림(PNG·JPEG)을 꺼낸다. HTML 쪽에는 그림이 로컬 경로(file://)로만 있어서
// 브라우저가 읽지 못하므로, 순서대로 짝지어 data URI로 바꿔 넣는다. WMF·EMF 같은 그림은 빈 문자열로 자리만 지킨다.
export function extractRtfImages(rtf: string): string[] {
  const out: string[] = []
  let i = 0
  while ((i = rtf.indexOf('{\\pict', i)) !== -1) {
    let depth = 0
    let j = i
    for (; j < rtf.length; j++) {
      const ch = rtf[j]
      if (ch === '\\') { j++; continue }
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) break
    }
    const group = rtf.slice(i, j + 1)
    const before = rtf.slice(Math.max(0, i - 40), i)
    i = j + 1
    if (/\\nonshppict\s*$/.test(before)) continue // 같은 그림의 WMF 대체본
    const type = /\\pngblip/.test(group) ? 'image/png' : /\\jpegblip/.test(group) ? 'image/jpeg' : null
    let body = group.slice(1, -1)
    // 하위 그룹({\*\blipuid …} 등)은 공백으로 바꾼다: 바로 뒤의 16진수가 앞 제어어(\bliptag-123)의 숫자로 읽히지 않게
    for (let k = 0; k < 20 && /\{[^{}]*\}/.test(body); k++) body = body.replace(/\{[^{}]*\}/g, ' ')
    // 제어어(\pngblip, \bliptag-123 …)를 지우면 그림의 16진수 데이터만 남는다
    const hex = body.replace(/\\[a-z]+(-?\d+)? ?/gi, '').replace(/\s+/g, '')
    if (!type || hex.length < 64 || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) { out.push(''); continue }
    let bin = ''
    for (let p = 0; p < hex.length; p += 2) bin += String.fromCharCode(parseInt(hex.substr(p, 2), 16))
    out.push(`data:${type};base64,${btoa(bin)}`)
  }
  return out
}

// Word 목록(mso-list 문단)을 진짜 글머리 기호·번호 목록으로 바꾼다. 앞에 붙은 "1." "·" 같은 표시는 지운다
function convertWordLists(doc: Document) {
  const isItem = (el: Element | null): el is HTMLElement =>
    !!el && el.tagName === 'P' && /mso-list\s*:\s*l\d+\s+level\d+/i.test(el.getAttribute('style') || '')
  doc.querySelectorAll('p').forEach((first) => {
    if (!isItem(first) || isItem(first.previousElementSibling)) return
    const run: HTMLElement[] = []
    for (let el: Element | null = first; isItem(el); el = el.nextElementSibling) run.push(el)
    const stack: { level: number; list: HTMLElement }[] = []
    let root: HTMLElement | null = null
    for (const p of run) {
      const level = Number((p.getAttribute('style') || '').match(/level(\d+)/i)?.[1] || 1)
      const markers = Array.from(p.querySelectorAll('span')).filter((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute('style') || ''))
      const mark = (markers[0]?.textContent || '').replace(/ /g, ' ').trim()
      const ordered = /^\(?[0-9a-zA-Zㄱ-ㅎ가-힣ⅰ-ⅻⅠ-Ⅻ]{1,4}[.)]$/.test(mark)
      markers.forEach((s) => s.remove())
      while (stack.length && stack[stack.length - 1].level > level) stack.pop()
      if (!stack.length || stack[stack.length - 1].level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul')
        if (stack.length) {
          (stack[stack.length - 1].list.lastElementChild || stack[stack.length - 1].list).appendChild(list)
        } else if (!root) {
          first.parentNode?.insertBefore(list, first)
          root = list
        } else {
          root.after(list)
          root = list
        }
        stack.push({ level, list })
      }
      const li = doc.createElement('li')
      const para = doc.createElement('p')
      while (p.firstChild) para.appendChild(p.firstChild)
      li.appendChild(para)
      stack[stack.length - 1].list.appendChild(li)
      p.remove()
    }
  })
}

// 한글·Word 붙여넣기 정리(허용 서식 목록 방식): 조건부 주석·로컬 이미지 경로 같은 찌꺼기를 지우고
// 굵게·기울임·글자색만 살린다(글꼴·크기는 문서마다 달라지지 않게 버리고, 필요하면 편집기에서 다시 지정).
export function cleanPastedHTML(html: string, opts: { rtfImages?: string[]; quiet?: boolean } = {}) {
  const rtfImages = opts.rtfImages || []
  const pre = html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(pre, 'text/html')
  } catch {
    return pre
  }
  convertWordLists(doc)
  // Word의 로컬 경로 그림을 RTF에서 꺼낸 그림으로 바꾼다(개수가 맞을 때만, 순서대로)
  const localImgs = Array.from(doc.querySelectorAll('img')).filter((img) => /^file:/i.test(img.getAttribute('src') || ''))
  if (localImgs.length && rtfImages.length) {
    const pics = rtfImages.length === localImgs.length ? rtfImages : rtfImages.filter(Boolean)
    if (pics.length === localImgs.length) localImgs.forEach((img, k) => (pics[k] ? img.setAttribute('src', pics[k]) : img.remove()))
  }
  let dropped = 0
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    // 사내 첨부(/api/files)와 붙여넣은 그림(data:)만 남긴다. 외부 주소 이미지는 내부망 원칙상 넣지 않는다
    if (!/^(\/api\/files\/\d+|data:image\/)/i.test(src)) {
      img.remove()
      dropped++
    }
  })
  if (dropped && !opts.quiet) window.dispatchEvent(new CustomEvent('ww:toast', { detail: { msg: `외부 주소 이미지 ${dropped}개는 넣지 않았습니다. 이미지는 따로 복사해 붙여넣거나 이미지 버튼으로 올려 주세요.`, kind: 'info' } }))
  doc.querySelectorAll('style, script, meta, link, xml').forEach((n) => n.remove())
  // 굵게·기울임·글자색은 살리고(한글은 span style로 표시), 글꼴·크기는 버린다
  doc.querySelectorAll('span, font').forEach((el) => {
    const st = (el.getAttribute('style') || '').toLowerCase()
    const wrappers: HTMLElement[] = []
    if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) wrappers.push(doc.createElement('strong'))
    if (/font-style\s*:\s*italic/.test(st)) wrappers.push(doc.createElement('em'))
    const color = normalizePastedColor(st.match(/(?:^|;)\s*color\s*:\s*([^;]+)/)?.[1] || el.getAttribute('color'))
    if (color) {
      const c = doc.createElement('span')
      c.setAttribute('data-ww-color', color)
      wrappers.push(c)
    }
    const parent = el.parentNode
    if (!parent) return
    const frag = doc.createDocumentFragment()
    while (el.firstChild) frag.appendChild(el.firstChild)
    if (wrappers.length) {
      wrappers.reduce((outer, inner) => (outer.appendChild(inner), inner)).appendChild(frag)
      parent.replaceChild(wrappers[0], el)
    } else parent.replaceChild(frag, el)
  })
  doc.querySelectorAll('[style],[class],[lang],[align]').forEach((el) => {
    el.removeAttribute('style')
    el.removeAttribute('class')
    el.removeAttribute('lang')
    el.removeAttribute('align')
  })
  doc.querySelectorAll('span[data-ww-color]').forEach((el) => {
    el.setAttribute('style', `color: ${el.getAttribute('data-ww-color')}`)
    el.removeAttribute('data-ww-color')
  })
  return doc.body.innerHTML
}
