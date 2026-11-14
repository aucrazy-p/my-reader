import { onMounted, onUnmounted, watch, type WatchSource } from 'vue'
import { APP_VIEWPORT_CHANGE_EVENT } from '../utils/viewport'

/**
 * 阅读页整行排版：视口有效高度对齐 + 真实行矩形吸附。
 * 约定见 docs/reader-line-grid.md。
 *
 * 独立成模块是为了隔离上游合并冲突：ReaderView.vue 是 fork 改动最密集的文件，
 * 这里只保留 import、一次调用与两三处挂载点，逻辑全在本文件（上游不会有同名文件）。
 */
export type LineGridOptions = {
  getContainer: () => HTMLElement | null | undefined
  isHorizontal: () => boolean
  fontSize: () => number
  lineHeight: () => number
  /** 除字号/行高外需要触发重算的响应式源（字体、边距、正文、面板、纯净模式等）。 */
  watchSources?: WatchSource[]
}

type LineRect = { top: number; bottom: number }

const TEXT_SELECTOR = '.chapter-text, .continuous-chapter, .epub-chapter-content'
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote'
const REMAINDER_VAR = '--reader-line-remainder'
const round = (n: number) => Math.round(n * 10) / 10

/** 取当前视口内真正显示着的正文元素；连续阅读/EPUB 多章时不能取第一个。 */
function activeReaderText(container: HTMLElement): HTMLElement | null {
  const view = container.getBoundingClientRect()
  const candidates = container.querySelectorAll<HTMLElement>(TEXT_SELECTOR)
  let best: HTMLElement | null = null
  let bestOverlap = 0
  for (const el of candidates) {
    const rect = el.getBoundingClientRect()
    const overlap = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = el
    }
  }
  return best || candidates[0] || null
}

function measureReaderLineHeight(container: HTMLElement, options: LineGridOptions): number {
  const text = activeReaderText(container)
  const lh = text ? parseFloat(getComputedStyle(text).lineHeight) : NaN
  if (Number.isFinite(lh) && lh > 0) return lh
  const fallback = options.fontSize() * options.lineHeight()
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0
}

/**
 * 逐文本节点取行矩形。
 *
 * 直接对整章元素 `range.selectNodeContents()` 会把内部的 `div.con` 等块级元素
 * 的**整体矩形**也一并返回（真机实测高度上千像素），混进切行评分后会把
 * topCut/bottomCut 算成 1583px、2106px 这种荒谬值，预对齐随之选错落点。
 * 只有文本节点的 `getClientRects()` 才是逐行矩形。
 */
function textLineRects(root: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    range.selectNodeContents(node)
    for (const r of range.getClientRects()) if (r.height > 4) rects.push(r)
  }
  return rects
}

/**
 * 内容流坐标下的真实文字行矩形。
 * 坐标 = 视口坐标 - 容器顶边 + scrollTop，因此不随当前滚动位置改变；
 * 而首屏底边恒为内容流坐标 `usable`，与用户当前滚到哪一屏无关。
 */
function collectFlowRects(container: HTMLElement, from: number, to: number): LineRect[] {
  const view = container.getBoundingClientRect()
  const scrollTop = container.scrollTop
  // 与 collectLineRects 保持同一套数据源。网络源章节常是「整块文本 + <br>」
  // （真机实测：.chapter-text 下只有 div.con，一个 p 都没有），此时必须回退到
  // 整章元素；否则这里拿到空数组，alignPageTarget 直接放弃预对齐，而吸附自带
  // 整章兜底照常工作 —— 翻页后每页被 smooth 再拉一次。
  const blocks = container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)
  const text = blocks.length ? null : activeReaderText(container)
  const roots: HTMLElement[] = blocks.length ? Array.from(blocks) : (text ? [text] : [])
  const rects: LineRect[] = []
  for (const root of roots) {
    for (const line of textLineRects(root)) {
      const top = line.top - view.top + scrollTop
      const bottom = line.bottom - view.top + scrollTop
      if (bottom > from && top < to) rects.push({ top, bottom })
    }
  }
  return rects
}

/** 某条边界切掉的最大行高（0 = 没有半截行）。 */
function cutAt(rects: LineRect[], boundary: number): number {
  let worst = 0
  for (const line of rects) {
    if (line.top >= boundary - 1 || line.bottom <= boundary + 1) continue
    const cut = line.bottom - boundary
    if (cut > worst) worst = cut
  }
  return worst
}

/**
 * 路线 1（扩展）：按真实几何选零头，而不是 `usable mod 行高`。
 *
 * 设 r 后容器 clientHeight = usable - r，首屏底边 = 内容流坐标 usable - r。
 * r ∈ [0, 行高) 意味着底边可在长度一行的区间内移动；该区间必然覆盖至少一个
 * 真实行沿（行沿最大间距不超过一行，更大的间隔本身就是空白），把底边对齐
 * 过去就不会切开任何文字行。段距、标题、图片、任意窗口高度都天然兼容。
 *
 * 但 r 是全篇共用的：中段吸附把顶边对齐到某个行沿后，底边 = 该行沿 + clientHeight，
 * 未必落在另一个行沿上。所以除首屏硬约束外，还要用若干「行沿作为顶边」的
 * 代表位置一起评分，挑让最多位置底边不切行的 r。
 */
function chooseRemainder(container: HTMLElement, usable: number, lineHeight: number): number {
  const lines = Math.max(1, Math.floor((usable + 0.5) / lineHeight))
  const theoretical = Math.max(0, Math.min(lineHeight, usable - lines * lineHeight))
  const clampR = (n: number) => round(Math.max(0, Math.min(lineHeight - 0.1, n)))
  const fallback = clampR(theoretical)

  // 覆盖前几屏：首屏底边、以及中段「顶边对齐到某行沿后」的底边都在这个范围内。
  const rects = collectFlowRects(container, 0, usable * 4 + lineHeight * 2)
  if (!rects.length) return fallback

  const edges = Array.from(new Set(rects.flatMap((r) => [round(r.top), round(r.bottom)])))
    .filter((e) => e > 0 && e < usable * 3.5)
    .sort((a, b) => a - b)
  const step = Math.max(1, Math.floor(edges.length / 32))
  const anchors = edges.filter((_, i) => i % step === 0).slice(0, 32)

  const candidates = new Set<number>([fallback])
  for (let r = 0; r < lineHeight; r += 0.5) candidates.add(clampR(r))
  // 首屏底边对齐到真实行沿的候选，保证路线 1 的原始解在池里。
  for (const line of rects) {
    for (const edge of [line.top, line.bottom]) {
      if (edge >= usable - lineHeight - 0.5 && edge <= usable + 0.5) {
        candidates.add(clampR(usable - edge))
      }
    }
  }

  // 首屏零截断是硬约束（它不能靠滚动吸附修正），只在满足它的候选里挑中段最优。
  const viable = [...candidates].filter((r) => cutAt(rects, usable - r) <= 1)
  const pool = viable.length ? viable : [fallback]
  let bestR = pool[0]
  let bestScore = Infinity
  for (const r of pool) {
    const height = usable - r
    let worst = 0
    let sum = 0
    for (const e of anchors) {
      const cut = cutAt(rects, e + height)
      if (cut > worst) worst = cut
      sum += cut
    }
    const score = worst * 2 + sum / Math.max(1, anchors.length)
    if (score < bestScore - 0.01 || (Math.abs(score - bestScore) <= 0.01 && r < bestR)) {
      bestScore = score
      bestR = r
    }
  }
  return bestR
}

export function useReaderLineGrid(options: LineGridOptions) {
  let frame = 0
  let snapTimer: ReturnType<typeof setTimeout> | null = null
  let isSnapping = false
  let disposed = false

  /** 把不足一行的零头写进 .reader-view 下留白；先归零再从未补偿布局重测，避免累加。 */
  function sync() {
    if (frame) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      if (disposed) return
      const container = options.getContainer()
      const view = container?.closest('.reader-view') as HTMLElement | null
      if (!container || !view) return
      if (options.isHorizontal()) {
        view.style.setProperty(REMAINDER_VAR, '0px')
        return
      }
      const lineHeight = measureReaderLineHeight(container, options)
      if (!(lineHeight > 0)) return
      view.style.setProperty(REMAINDER_VAR, '0px')
      const inset = parseFloat(getComputedStyle(container).paddingBottom) || 0
      const usable = Math.max(0, container.clientHeight - inset)
      if (usable <= lineHeight) return
      view.style.setProperty(REMAINDER_VAR, `${chooseRemainder(container, usable, lineHeight)}px`)
    })
  }

  /** 视口附近的真实文字行矩形（视口坐标，供吸附评分用）。 */
  function collectLineRects(container: HTMLElement, lineHeight: number): LineRect[] {
    const text = activeReaderText(container)
    if (!text) return []
    const view = container.getBoundingClientRect()
    const from = view.top - lineHeight * 2
    const to = view.bottom + lineHeight * 2
    const blocks = text.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)
    const roots: HTMLElement[] = blocks.length ? Array.from(blocks) : [text]
    const rects: LineRect[] = []
    for (const root of roots) {
      for (const line of textLineRects(root)) {
        if (line.bottom <= from || line.top >= to) continue
        rects.push({ top: line.top, bottom: line.bottom })
      }
    }
    return rects
  }

  /** 滚动 delta 后，某条视口边界切掉的最大行高。 */
  function edgeCut(rects: LineRect[], boundary: number, delta: number, isTop: boolean): number {
    let worst = 0
    for (const line of rects) {
      const top = line.top - delta
      const bottom = line.bottom - delta
      if (top >= boundary - 1 || bottom <= boundary + 1) continue
      const cut = isTop ? boundary - top : bottom - boundary
      if (cut > worst) worst = cut
    }
    return worst
  }

  function snapScrollToLine() {
    if (disposed) return
    const container = options.getContainer()
    if (!container || options.isHorizontal()) return
    const lineHeight = measureReaderLineHeight(container, options)
    if (!(lineHeight > 0)) return
    const maxScroll = container.scrollHeight - container.clientHeight
    if (maxScroll <= 0) return
    // 首屏顶部本来完整，别为了对齐把章节标题滚出视口；其余位置一律吸附。
    if (container.scrollTop <= 0) return
    const view = container.getBoundingClientRect()
    const rects = collectLineRects(container, lineHeight)
    if (!rects.length) return
    const candidates = new Set<number>()
    for (const line of rects) {
      for (const boundary of [view.top, view.bottom]) {
        for (const edge of [line.top, line.bottom]) {
          const d = edge - boundary
          if (Math.abs(d) >= 1 && Math.abs(d) <= lineHeight) candidates.add(round(d))
        }
      }
    }
    const score = (d: number) => edgeCut(rects, view.top, d, true) * 2 + edgeCut(rects, view.bottom, d, false)
    let delta = 0
    let best = score(0)
    let bestAbs = 0
    for (const d of candidates) {
      const s = score(d)
      if (s < best - 0.5 || (Math.abs(s - best) <= 0.5 && Math.abs(d) < bestAbs)) {
        best = s
        bestAbs = Math.abs(d)
        delta = d
      }
    }
    if (!delta) return
    const targetTop = Math.max(0, Math.min(maxScroll, container.scrollTop + delta))
    if (Math.abs(targetTop - container.scrollTop) < 1) return
    isSnapping = true
    container.scrollTo({ top: targetTop, behavior: 'smooth' })
    setTimeout(() => { isSnapping = false }, 320)
  }

  function scheduleSnap() {
    if (disposed || options.isHorizontal() || isSnapping) return
    if (snapTimer !== null) clearTimeout(snapTimer)
    snapTimer = setTimeout(snapScrollToLine, 140)
  }

  /**
   * 翻页目标预先对齐：把吸附的「事后修正」前移到翻页决策里（约定第 10 条）。
   *
   * getPageStep() 用 floor(clientHeight / 行高) × 行高 作步长，假设正文是均匀
   * 行网格；段距/标题/图片会破坏它，翻页落点逐页偏离真实行沿，停手 140ms 后
   * 吸附再 smooth 拉一次（实测连续翻页每页回弹 9~11px），即「文字上下晃动」。
   *
   * 这里在原始目标 ± 一行内，按内容流坐标的真实行沿挑一个上下边界都零截断的
   * 落点，翻页补间直接停在那里；吸附再评分时 score(0)=0、delta=0，自然不动。
   * 吸附本身不删不改，继续为滚轮/触控板/滚动条等自由滚动兜底。
   */
  function alignPageTarget(container: HTMLElement | null | undefined, rawTop: number): number {
    if (!container || disposed || options.isHorizontal()) return rawTop
    const lineHeight = measureReaderLineHeight(container, options)
    if (!(lineHeight > 0)) return rawTop
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    const target = round(Math.max(0, Math.min(maxScroll, rawTop)))
    const height = container.clientHeight
    // 内容流坐标，多取两行保证跨边界的长行也在集合里。
    const rects = collectFlowRects(container, target - lineHeight * 2, target + height + lineHeight * 2)
    if (!rects.length) return target

    // 与 snapScrollToLine 的 edgeCut 评分同构（顶边权重更高），只是换成内容流坐标：
    // 顶边 = t，底边 = t + height。两者一致，翻页后吸附才不会二次修正。
    const cutTop = (t: number) => {
      let worst = 0
      for (const line of rects) {
        if (line.top >= t - 1 || line.bottom <= t + 1) continue
        const cut = t - line.top
        if (cut > worst) worst = cut
      }
      return worst
    }
    const cutBottom = (t: number) => cutAt(rects, t + height)
    const score = (t: number) => cutTop(t) * 2 + cutBottom(t)

    const candidates = new Set<number>([target])
    for (const line of rects) {
      for (const edge of [line.top, line.bottom]) {
        // 顶边落在行沿
        if (Math.abs(edge - target) <= lineHeight) candidates.add(round(edge))
        // 底边落在行沿，反推顶边
        const t = edge - height
        if (Math.abs(t - target) <= lineHeight) candidates.add(round(t))
      }
    }
    // 行沿稀疏/大段空白时补 1px 细扫，保证至少能找到零截断区间。
    for (let t = target - lineHeight; t <= target + lineHeight; t += 1) {
      candidates.add(round(Math.max(0, Math.min(maxScroll, t))))
    }

    let best = target
    let bestScore = score(best)
    let bestDist = 0
    for (const t of candidates) {
      if (t < 0 || t > maxScroll + 0.5) continue
      const s = score(t)
      const dist = Math.abs(t - target)
      if (s < bestScore - 0.5 || (Math.abs(s - bestScore) <= 0.5 && dist < bestDist)) {
        bestScore = s
        best = t
        bestDist = dist
      }
    }
    return best
  }

  watch(
    [options.fontSize, options.lineHeight, ...(options.watchSources ?? [])],
    () => sync(),
    { flush: 'post' },
  )

  onMounted(() => {
    window.addEventListener('resize', sync)
    window.addEventListener(APP_VIEWPORT_CHANGE_EVENT, sync)
    sync()
  })

  onUnmounted(() => {
    disposed = true
    window.removeEventListener('resize', sync)
    window.removeEventListener(APP_VIEWPORT_CHANGE_EVENT, sync)
    if (frame) cancelAnimationFrame(frame)
    if (snapTimer !== null) clearTimeout(snapTimer)
  })

  return { sync, scheduleSnap, alignPageTarget }
}
