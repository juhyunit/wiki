// 홈 'Insight Network' 그래프(옵시디언 그래프 보기 방식): 부서 · 매뉴얼 · 태그를 점으로, 소속·태그·문서 링크를 선으로.
// 외부 라이브러리 없이 캔버스에 힘-배치(밀어내기 + 스프링 + 중심 끌림)로 그린다. 볼 수 있는 매뉴얼만 서버가 준다.
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { GraphData, GraphNode } from '../api/types'
import { navigate } from '../lib/router'
import { cx } from '../lib/util'

type SimNode = GraphNode & { x: number; y: number; vx: number; vy: number; r: number; deg: number; fixed?: boolean }
type SimEdge = { s: SimNode; t: SimNode; kind: 'dept' | 'tag' | 'link' }

// 첫 번째 참고 이미지의 회색조를 바탕으로, 부서·선택·문서 링크에만 브랜드 네이비를 쓴다(styles.css 토큰과 같은 값)
// 기본은 첫 번째 참고 이미지의 회색조. 많이 이어진 점일수록 청록 → 파스텔 주황(이 그래프에서만 쓰는 데이터 색)
const C = {
  edge: '#dde2e9', edgeLink: '#b7c3d6', hi: '#263b63', hiEdge: '#263b63', label: '#3b475a', halo: 'rgba(247,248,250,0.92)',
}
const DENSITY = ['#c6ccd5', '#4a5466', '#5aa9a0', '#e9a06c'] // 적음 → 보통 → 많음 → 가장 많음
const densityColor = (n: { deg: number }, cut: number[]) => DENSITY[n.deg >= cut[2] ? 3 : n.deg >= cut[1] ? 2 : n.deg >= cut[0] ? 1 : 0]
const LEN = { dept: 80, tag: 40, link: 120 }
const STRENGTH = { dept: 0.06, tag: 0.09, link: 0.025 }

function build(data: GraphData, w: number, h: number) {
  const byId = new Map<string, SimNode>()
  // 부서는 원 둘레에, 나머지는 소속 부서 근처에서 출발(펼쳐지는 모양이 매번 비슷하게)
  const depts = data.nodes.filter((n) => n.kind === 'dept')
  const R = Math.min(w, h) * 0.28
  depts.forEach((n, i) => {
    const a = (i / Math.max(1, depts.length)) * Math.PI * 2 - Math.PI / 2
    byId.set(n.id, { ...n, x: Math.cos(a) * R, y: Math.sin(a) * R, vx: 0, vy: 0, r: 0, deg: 0 })
  })
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
  for (const n of data.nodes) {
    if (byId.has(n.id)) continue
    const d = n.kind === 'manual' ? byId.get(`d${n.dept}`) : null
    byId.set(n.id, { ...n, x: (d?.x ?? 0) + rnd() * 120, y: (d?.y ?? 0) + rnd() * 120, vx: 0, vy: 0, r: 0, deg: 0 })
  }
  const edges: SimEdge[] = []
  for (const e of data.edges) {
    const s = byId.get(e.s), t = byId.get(e.t)
    if (!s || !t) continue
    s.deg++
    t.deg++
    edges.push({ s, t, kind: e.kind })
  }
  // 태그는 처음에 이어진 매뉴얼들의 가운데에 둔다
  for (const n of byId.values()) {
    if (n.kind !== 'tag') continue
    const ms = edges.filter((e) => e.t === n).map((e) => e.s)
    if (ms.length) {
      n.x = ms.reduce((a, m) => a + m.x, 0) / ms.length + rnd() * 30
      n.y = ms.reduce((a, m) => a + m.y, 0) / ms.length + rnd() * 30
    }
  }
  // 크기는 종류가 아니라 이어진 수로만(부서가 혼자 커지지 않게, 차이는 작게)
  for (const n of byId.values()) n.r = 2.4 + Math.min(3.2, Math.sqrt(n.deg) * 0.9)
  // 연결 밀도 구간: 이어진 수 분포의 50·80·94% 지점
  const degs = [...byId.values()].map((n) => n.deg).sort((a, b) => a - b)
  const q = (p: number) => degs[Math.min(degs.length - 1, Math.floor(degs.length * p))] || 1
  const cut = [Math.max(2, q(0.5)), Math.max(3, q(0.8)), Math.max(4, q(0.94))]
  return { nodes: [...byId.values()], edges, byId, cut }
}

function tick(nodes: SimNode[], edges: SimEdge[], alpha: number) {
  // 밀어내기(점이 수백 개 수준이라 모든 쌍을 계산)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02 }
      if (d2 > 90000) continue
      const k = (a.kind === 'tag' || b.kind === 'tag' ? 260 : 900) * alpha / d2
      const d = Math.sqrt(d2)
      const fx = (dx / d) * k, fy = (dy / d) * k
      a.vx -= fx; a.vy -= fy
      b.vx += fx; b.vy += fy
    }
  }
  for (const e of edges) {
    const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = (d - LEN[e.kind]) * STRENGTH[e.kind] * alpha
    const fx = (dx / d) * f, fy = (dy / d) * f
    e.s.vx += fx; e.s.vy += fy
    e.t.vx -= fx; e.t.vy -= fy
  }
  for (const n of nodes) {
    // 가운데로 같은 힘으로 끌어 전체가 둥근 구 모양이 되게
    n.vx -= n.x * 0.018 * alpha
    n.vy -= n.y * 0.018 * alpha
    if (n.fixed) { n.vx = 0; n.vy = 0; continue }
    n.vx *= 0.6
    n.vy *= 0.6
    n.x += n.vx
    n.y += n.vy
  }
}

export function KnowledgeGraph() {
  const [data, setData] = useState<GraphData | null>(null)
  const [hover, setHover] = useState<SimNode | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sim = useRef<{ nodes: SimNode[]; edges: SimEdge[]; byId: Map<string, SimNode>; cut: number[] } | null>(null)
  const view = useRef({ x: 0, y: 0, k: 1, w: 0, h: 0 })
  const alpha = useRef(1)
  const hoverRef = useRef<SimNode | null>(null)
  const raf = useRef(0)

  useEffect(() => {
    api.graph().then(setData).catch(() => setData({ nodes: [], edges: [] }))
  }, [])
  const shown = data

  // 이웃(마우스를 올린 점과 이어진 점·선): 시뮬레이션을 만들 때 함께 만든다
  const neighborsRef = useRef(new Map<SimNode, Set<SimNode>>())

  const draw = () => {
    const cv = canvasRef.current
    const s = sim.current
    if (!cv || !s) return
    const ctx = cv.getContext('2d')!
    const { x: ox, y: oy, k, w, h } = view.current
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.translate(w / 2 + ox, h / 2 + oy)
    ctx.scale(k, k)
    const hv = hoverRef.current
    const near = hv ? neighborsRef.current.get(hv) || new Set<SimNode>() : null
    const on = (n: SimNode) => !hv || n === hv || near!.has(n)
    for (const e of s.edges) {
      const hot = hv && (e.s === hv || e.t === hv)
      ctx.globalAlpha = hv && !hot ? 0.25 : 1
      ctx.strokeStyle = hot ? C.hiEdge : e.kind === 'link' ? C.edgeLink : C.edge
      ctx.lineWidth = (hot ? 1.4 : e.kind === 'link' ? 1.3 : 0.9) / k
      ctx.beginPath()
      ctx.moveTo(e.s.x, e.s.y)
      ctx.lineTo(e.t.x, e.t.y)
      ctx.stroke()
    }
    for (const n of s.nodes) {
      ctx.globalAlpha = on(n) ? 1 : 0.25
      ctx.fillStyle = n === hv || (hv && near!.has(n)) ? C.hi : densityColor(n, s.cut)
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + (n === hv ? 1.5 : 0), 0, Math.PI * 2)
      ctx.fill()
    }
    // 이름: 부서는 늘, 매뉴얼은 가까이 보거나 마우스를 올렸을 때
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    for (const n of s.nodes) {
      const focus = hv && (n === hv || (near!.has(n) && n.kind !== 'tag'))
      if (!focus) continue
      const size = (n === hv ? 12.5 : 11) / k
      ctx.font = `${n === hv ? 600 : 400} ${size}px ui-sans-serif, -apple-system, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif`
      const text = n.kind === 'tag' ? `#${n.label}` : n.label
      ctx.globalAlpha = 1
      ctx.strokeStyle = C.halo
      ctx.lineWidth = 3 / k
      ctx.strokeText(text, n.x, n.y + n.r + 3 / k)
      ctx.fillStyle = n === hv ? C.hi : C.label
      ctx.fillText(text, n.x, n.y + n.r + 3 / k)
    }
    ctx.globalAlpha = 1
  }

  // 그래프 전체가 캔버스에 꽉 차게 확대·이동(이름이 들어갈 여백 포함)
  const fitView = () => {
    const s = sim.current
    const v = view.current
    if (!s || !s.nodes.length || !v.w) return
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const n of s.nodes) {
      x1 = Math.min(x1, n.x - n.r); y1 = Math.min(y1, n.y - n.r)
      x2 = Math.max(x2, n.x + n.r); y2 = Math.max(y2, n.y + n.r + 16)
    }
    const k = Math.max(0.4, Math.min(2.4, (v.w - 56) / Math.max(1, x2 - x1), (v.h - 40) / Math.max(1, y2 - y1)))
    v.k = k
    v.x = -((x1 + x2) / 2) * k
    v.y = -((y1 + y2) / 2) * k
  }

  // 시뮬레이션 시작·크기 맞추기
  useEffect(() => {
    if (!shown || !wrapRef.current || !canvasRef.current) return
    const wrap = wrapRef.current
    const cv = canvasRef.current
    const fit = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight
      const dpr = window.devicePixelRatio || 1
      cv.width = w * dpr
      cv.height = h * dpr
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      view.current.w = w
      view.current.h = h
      if (alpha.current <= 0.05) fitView()
      draw()
    }
    sim.current = build(shown, wrap.clientWidth, wrap.clientHeight)
    const nb = new Map<SimNode, Set<SimNode>>()
    for (const e of sim.current.edges) {
      if (!nb.has(e.s)) nb.set(e.s, new Set())
      if (!nb.has(e.t)) nb.set(e.t, new Set())
      nb.get(e.s)!.add(e.t)
      nb.get(e.t)!.add(e.s)
    }
    neighborsRef.current = nb
    setHover(null)
    view.current = { ...view.current, x: 0, y: 0, k: 1 }
    fit()
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    alpha.current = 1
    if (reduce) {
      for (let i = 0; i < 300; i++) tick(sim.current.nodes, sim.current.edges, 1 - i / 300)
      alpha.current = 0
      draw()
    } else {
      // 대부분은 화면에 그리기 전에 미리 계산하고, 마지막 정리만 움직임으로 보여 준다
      for (let i = 0; i < 260; i++) tick(sim.current.nodes, sim.current.edges, Math.max(0.12, 1 - i / 260))
      alpha.current = 0.12
    }
    fitView()
    draw()
    const loop = () => {
      if (alpha.current > 0.02 && sim.current) {
        tick(sim.current.nodes, sim.current.edges, alpha.current)
        alpha.current *= 0.985
        if (!drag.current) fitView()
        draw()
      }
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    return () => { cancelAnimationFrame(raf.current); ro.disconnect() }
  }, [shown])

  useEffect(() => { hoverRef.current = hover; draw() }, [hover])

  // ---------------- 마우스·터치: 점 끌기, 바탕 끌어 이동, Ctrl+휠·두 손가락으로 확대
  const toWorld = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const v = view.current
    return { x: (cx - r.left - v.w / 2 - v.x) / v.k, y: (cy - r.top - v.h / 2 - v.y) / v.k }
  }
  const hit = (cx: number, cy: number) => {
    const s = sim.current
    if (!s) return null
    const p = toWorld(cx, cy)
    let best: SimNode | null = null, bd = Infinity
    for (const n of s.nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      const lim = n.r + 6 / view.current.k
      if (d < lim && d < bd) { best = n; bd = d }
    }
    return best
  }
  const drag = useRef<{ node: SimNode | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    const n = hit(e.clientX, e.clientY)
    if (e.pointerType === 'touch' && !n) return // 손가락으로 바탕을 밀면 화면 스크롤
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { node: n, sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y, moved: false }
    if (n) n.fixed = true
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) {
      if (e.pointerType !== 'touch') {
        const n = hit(e.clientX, e.clientY)
        if (n !== hoverRef.current) setHover(n)
      }
      return
    }
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true
    if (d.node) {
      const p = toWorld(e.clientX, e.clientY)
      d.node.x = p.x
      d.node.y = p.y
      alpha.current = Math.max(alpha.current, 0.3)
      setHover(d.node)
    } else {
      view.current.x = d.ox + e.clientX - d.sx
      view.current.y = d.oy + e.clientY - d.sy
      draw()
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.node) d.node.fixed = false
    if (d.node && !d.moved) {
      const n = d.node
      if (n.kind === 'manual') navigate(`/m/${n.ref}`)
      else if (n.kind === 'dept') navigate(`/d/${n.ref}`)
      else navigate(`/search?q=${encodeURIComponent(String(n.ref))}`)
    }
  }
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // 그냥 휠은 화면 스크롤
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      const v = view.current
      const k2 = Math.min(4, Math.max(0.4, v.k * Math.exp(-e.deltaY * 0.01)))
      const mx = e.clientX - r.left - v.w / 2, my = e.clientY - r.top - v.h / 2
      v.x = mx - ((mx - v.x) / v.k) * k2
      v.y = my - ((my - v.y) / v.k) * k2
      v.k = k2
      draw()
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [shown])

  if (data && !data.nodes.length) return null
  return (
    <section className="kg" aria-label="Insight Network">
      <h2 className="kg-title">Insight Network</h2>
      <div className={cx('kg-canvas', hover && 'pointing')} ref={wrapRef}>
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => { if (!drag.current) setHover(null) }} role="img"
          aria-label="매뉴얼·부서·태그의 연결 그림" />
        {!data && <div className="kg-loading muted small">불러오는 중…</div>}
        {hover && (
          <div className="kg-tip">
            <strong>{hover.kind === 'tag' ? `#${hover.label}` : hover.label}</strong>
            <span>{hover.kind === 'manual' ? `${hover.no}${hover.published ? '' : ' · 작성 중'}` : hover.kind === 'dept' ? '부서' : '태그'} · 연결 {neighborsRef.current.get(hover)?.size ?? 0}</span>
          </div>
        )}
      </div>
    </section>
  )
}
