import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'

export type CalloutType = 'warning' | 'danger' | 'info'
export const CALLOUT_LABEL: Record<CalloutType, string> = { warning: '주의', danger: '중요', info: '참고' }

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      toggleCallout: (type: CalloutType) => ReturnType
    }
  }
}

// 업무 블록: 주의(노랑)·중요(빨강)·참고(파랑) 3종만(기획서 7.1)
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
  ]
  if (opts.placeholder)
    exts.push(
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? '제목' : '내용을 입력하세요. 한글·Word에서 복사해 붙여넣어도 표와 목록이 유지됩니다.'),
      }),
    )
  return exts
}

// 한글·Word 붙여넣기 정리(허용 서식 목록 방식): 스키마에 없는 글꼴·크기·색은 편집기가 버리고,
// 여기서는 조건부 주석·로컬 이미지 경로 같은 찌꺼기를 미리 지운다.
export function cleanPastedHTML(html: string) {
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
  let dropped = 0
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    // 사내 첨부(/api/files)와 붙여넣은 그림(data:)만 남긴다. 외부 주소 이미지는 내부망 원칙상 넣지 않는다
    if (!/^(\/api\/files\/\d+|data:image\/)/i.test(src)) {
      img.remove()
      dropped++
    }
  })
  if (dropped) window.dispatchEvent(new CustomEvent('ww:toast', { detail: { msg: `외부 주소 이미지 ${dropped}개는 넣지 않았습니다. 이미지는 따로 복사해 붙여넣거나 이미지 버튼으로 올려 주세요.`, kind: 'info' } }))
  doc.querySelectorAll('style, script, meta, link, xml').forEach((n) => n.remove())
  // 굵게·기울임은 살리고(한글은 span style로 표시), 글꼴·크기·색은 버린다
  doc.querySelectorAll('span, font').forEach((el) => {
    const st = (el.getAttribute('style') || '').toLowerCase()
    let wrapper: HTMLElement | null = null
    if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) wrapper = doc.createElement('strong')
    if (/font-style\s*:\s*italic/.test(st)) {
      const em = doc.createElement('em')
      if (wrapper) wrapper.appendChild(em)
      wrapper = wrapper || em
    }
    const parent = el.parentNode
    if (!parent) return
    const frag = doc.createDocumentFragment()
    while (el.firstChild) frag.appendChild(el.firstChild)
    if (wrapper) {
      const inner = (wrapper.querySelector('em') as HTMLElement) || wrapper
      inner.appendChild(frag)
      parent.replaceChild(wrapper, el)
    } else parent.replaceChild(frag, el)
  })
  doc.querySelectorAll('[style],[class],[lang],[align]').forEach((el) => {
    el.removeAttribute('style')
    el.removeAttribute('class')
    el.removeAttribute('lang')
    el.removeAttribute('align')
  })
  return doc.body.innerHTML
}
