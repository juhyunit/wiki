import { ReactNode, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlertOctagon, AlertTriangle, Baseline, Bold, Columns3, FileSymlink, FileUp, ImagePlus, Indent, Info, Italic, Link2, List, ListChecks, ListOrdered,
  Minus, Outdent, Paperclip, Quote, Redo2, Rows3, Strikethrough, Table2, TableCellsMerge, TableCellsSplit, Trash2, Underline, Undo2,
} from 'lucide-react'
import { cx } from '../lib/util'
import { FONT_FAMILIES, FONT_SIZES, TEXT_COLORS } from './textStyle'

function TB({ on, disabled, onClick, title, children, className }: { on?: boolean; disabled?: boolean; onClick: () => void; title: string; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={cx('tb', on && 'on', className)} disabled={disabled} title={title} aria-label={title} aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )
}

const Sep = () => <span className="tb-sep" />

function ColorPicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const cur = editor.getAttributes('textStyle').color as string | undefined
  const pick = (v: string | null) => {
    const ch = editor.chain().focus()
    ;(v ? ch.setColor(v) : ch.unsetColor()).run()
    setOpen(false)
  }
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className={cx('tb tb-color', (open || !!cur) && 'on')} title="글자색" aria-label="글자색" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Baseline size={16} /><span className="tb-color-bar" style={{ background: cur || 'var(--t1)' }} />
      </button>
      {open && (
        <div className="popover color-pop" role="menu" aria-label="글자색">
          <button type="button" className="color-default" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null)}>기본색</button>
          {TEXT_COLORS.map((c) => (
            <button key={c.value} type="button" className={cx('color-swatch', cur === c.value && 'on')} style={{ background: c.value }}
              title={c.label} aria-label={c.label} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.value)} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Toolbar({ editor, onImage, onFile, onLink, onDocLink, onImport }: {
  editor: Editor; onImage: () => void; onFile: () => void; onLink: () => void; onDocLink: () => void; onImport?: () => void
}) {
  const c = () => editor.chain().focus()
  const block = editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p'
  const inList = editor.isActive('listItem') || editor.isActive('taskItem')
  const listType = editor.isActive('taskItem') ? 'taskItem' : 'listItem'
  const inTable = editor.isActive('table')
  const inImage = editor.isActive('image')
  const img = inImage ? editor.getAttributes('image') : {}
  const ts = editor.getAttributes('textStyle') as { fontFamily?: string; fontSize?: string }
  // 크기 버튼: 속성을 바꾸고, 크기 조절 노드 뷰가 화면을 바로 다시 그리지 않으므로 표시 크기도 직접 맞춘다
  const setImgWidth = (w: number | null) => {
    const pos = editor.state.selection.from
    editor.chain().focus().updateAttributes('image', { width: w, height: null }).run()
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null
    const el = (dom?.tagName === 'IMG' ? dom : dom?.querySelector?.('img')) as HTMLImageElement | null
    if (el) {
      el.style.width = w ? `${w}px` : ''
      el.style.height = 'auto'
    }
  }
  return (
    <div className="toolbar-wrap">
      <div className="toolbar" role="toolbar" aria-label="편집 도구">
        <TB title="실행 취소 (Ctrl+Z)" onClick={() => c().undo().run()} disabled={!editor.can().undo()}><Undo2 size={16} /></TB>
        <TB title="다시 실행 (Ctrl+Y)" onClick={() => c().redo().run()} disabled={!editor.can().redo()}><Redo2 size={16} /></TB>
        <Sep />
        <select className="tb-select" value={block} aria-label="문단 스타일"
          onChange={(e) => {
            const v = e.target.value
            if (v === 'p') c().setParagraph().run()
            else c().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run()
          }}>
          <option value="p">본문</option>
          <option value="h1">제목 1</option>
          <option value="h2">제목 2</option>
          <option value="h3">제목 3</option>
        </select>
        <Sep />
        <TB title="굵게 (Ctrl+B)" on={editor.isActive('bold')} onClick={() => c().toggleBold().run()}><Bold size={16} /></TB>
        <TB title="기울임 (Ctrl+I)" on={editor.isActive('italic')} onClick={() => c().toggleItalic().run()}><Italic size={16} /></TB>
        <TB title="밑줄 (Ctrl+U)" on={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()}><Underline size={16} /></TB>
        <TB title="취소선" on={editor.isActive('strike')} onClick={() => c().toggleStrike().run()}><Strikethrough size={16} /></TB>
        <ColorPicker editor={editor} />
        <select className="tb-select tb-font" value={ts.fontFamily || ''} aria-label="글꼴" title="글꼴"
          onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value) : c().unsetFontFamily()).run()}>
          <option value="">기본 글꼴</option>
          {FONT_FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select className="tb-select tb-size" value={ts.fontSize || ''} aria-label="글자 크기" title="글자 크기"
          onChange={(e) => (e.target.value ? c().setFontSize(e.target.value) : c().unsetFontSize()).run()}>
          <option value="">기본 크기</option>
          {FONT_SIZES.map((s) => <option key={s} value={s}>{parseInt(s)}</option>)}
        </select>
        <Sep />
        <TB title="글머리 기호" on={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()}><List size={16} /></TB>
        <TB title="번호 매기기" on={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()}><ListOrdered size={16} /></TB>
        <TB title="체크리스트" on={editor.isActive('taskList')} onClick={() => c().toggleTaskList().run()}><ListChecks size={16} /></TB>
        <TB title="들여쓰기 (Tab)" disabled={!inList || !editor.can().sinkListItem(listType)} onClick={() => c().sinkListItem(listType).run()}><Indent size={16} /></TB>
        <TB title="내어쓰기 (Shift+Tab)" disabled={!inList || !editor.can().liftListItem(listType)} onClick={() => c().liftListItem(listType).run()}><Outdent size={16} /></TB>
        <Sep />
        <TB title="표 넣기" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={16} /></TB>
        <TB title="이미지 넣기 (캡처 붙여넣기·끌어놓기도 됩니다)" onClick={onImage}><ImagePlus size={16} /></TB>
        <TB title="파일 첨부" onClick={onFile}><Paperclip size={16} /></TB>
        <TB title="웹 링크" on={editor.isActive('link') && !String(editor.getAttributes('link').href || '').startsWith('#/m/')} onClick={onLink}><Link2 size={16} /></TB>
        <TB title="문서 링크 — 다른 매뉴얼 연결 ([[ 입력으로도 열림)" className="tb-text" on={String(editor.getAttributes('link').href || '').startsWith('#/m/')} onClick={onDocLink}>
          <FileSymlink size={15} /><span>문서 링크</span></TB>
        <Sep />
        <TB title="주의 박스" className="tb-callout warning" on={editor.isActive('callout', { type: 'warning' })} onClick={() => c().toggleCallout('warning').run()}>
          <AlertTriangle size={15} /><span>주의</span></TB>
        <TB title="중요 박스" className="tb-callout danger" on={editor.isActive('callout', { type: 'danger' })} onClick={() => c().toggleCallout('danger').run()}>
          <AlertOctagon size={15} /><span>중요</span></TB>
        <TB title="참고 박스" className="tb-callout info" on={editor.isActive('callout', { type: 'info' })} onClick={() => c().toggleCallout('info').run()}>
          <Info size={15} /><span>참고</span></TB>
        <Sep />
        <TB title="인용" on={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()}><Quote size={16} /></TB>
        <TB title="구분선" onClick={() => c().setHorizontalRule().run()}><Minus size={16} /></TB>
        {onImport && (
          <>
            <Sep />
            <TB title="가져오기 — Word(.docx)·Markdown(.md)·HTML(.html). HWP는 한글에서 DOCX로 저장 후" className="tb-text" onClick={onImport}><FileUp size={15} /><span>가져오기</span></TB>
          </>
        )}
      </div>
      {inImage && (
        <div className="toolbar sub-bar" role="toolbar" aria-label="이미지 도구">
          <span className="tb-label">이미지</span>
          <TB title="작게 (가로 320px)" className="tb-text" on={img.width === 320} onClick={() => setImgWidth(320)}><span>작게</span></TB>
          <TB title="중간 (가로 560px)" className="tb-text" on={img.width === 560} onClick={() => setImgWidth(560)}><span>중간</span></TB>
          <TB title="원래 크기" className="tb-text" on={!img.width} onClick={() => setImgWidth(null)}><span>원래 크기</span></TB>
          <Sep />
          <label className="caption-field">
            <span>캡션</span>
            <input value={img.title || ''} maxLength={200} placeholder="이미지 아래에 표시할 설명"
              onChange={(e) => editor.commands.updateAttributes('image', { title: e.target.value || null, alt: e.target.value || img.alt || null })} />
          </label>
        </div>
      )}
      {inTable && (
        <div className="toolbar sub-bar" role="toolbar" aria-label="표 도구">
          <span className="tb-label">표</span>
          <TB title="위에 행 추가" className="tb-text" onClick={() => c().addRowBefore().run()}><Rows3 size={14} /><span>위 행</span></TB>
          <TB title="아래에 행 추가" className="tb-text" onClick={() => c().addRowAfter().run()}><Rows3 size={14} /><span>아래 행</span></TB>
          <TB title="왼쪽에 열 추가" className="tb-text" onClick={() => c().addColumnBefore().run()}><Columns3 size={14} /><span>왼쪽 열</span></TB>
          <TB title="오른쪽에 열 추가" className="tb-text" onClick={() => c().addColumnAfter().run()}><Columns3 size={14} /><span>오른쪽 열</span></TB>
          <Sep />
          <TB title="행 삭제" className="tb-text" onClick={() => c().deleteRow().run()}><span>행 삭제</span></TB>
          <TB title="열 삭제" className="tb-text" onClick={() => c().deleteColumn().run()}><span>열 삭제</span></TB>
          <Sep />
          <TB title="셀 병합 (여러 셀을 끌어 선택)" className="tb-text" disabled={!editor.can().mergeCells()} onClick={() => c().mergeCells().run()}><TableCellsMerge size={14} /><span>병합</span></TB>
          <TB title="셀 나누기" className="tb-text" disabled={!editor.can().splitCell()} onClick={() => c().splitCell().run()}><TableCellsSplit size={14} /><span>나누기</span></TB>
          <TB title="머리행 켜기/끄기" className="tb-text" onClick={() => c().toggleHeaderRow().run()}><span>머리행</span></TB>
          <Sep />
          <TB title="표 삭제" className="tb-text danger" onClick={() => c().deleteTable().run()}><Trash2 size={14} /><span>표 삭제</span></TB>
        </div>
      )}
    </div>
  )
}
