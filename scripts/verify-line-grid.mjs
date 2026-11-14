#!/usr/bin/env node

/**
 * 阅读页整行排版几何断言（约定见 docs/reader-line-grid.md）。
 * 自包含：自己拉起 Vite dev server、跑完自动关闭，不需要手工开服务。
 *
 *   node scripts/verify-line-grid.mjs
 *
 * 合并上游 main 之后手动跑一次：上游若改动了阅读页，这里会直接暴露
 * 半截行回归或挂载点被冲掉（此时 --reader-line-remainder 恒为 0px）。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const frontend = resolve(root, 'frontend')
const PORT = Number(process.env.LINE_GRID_PORT || 5178)
const BASE = `http://127.0.0.1:${PORT}`
// 410 是真机实测的阅读区高度；此前只用 680~1000 的假想尺寸。
const VIEWPORTS = [410, 680, 740, 800, 860, 920, 1000]
const SCROLL_POINTS = [0, 12, 48.6, 1000.3, 1700.6, 2600.4]
const TOLERANCE = 1.0

// 验证样本必须是真实网络源章节：整块文本 + <br>、0 个 p 标签。
// 早期用 160 段 <p> 自造正文，掩盖了 collectFlowRects 拿不到行矩形的问题。
const FIXTURE = resolve(root, '.workbuddy/fixtures/real-chapter.html')
const content = readFileSync(FIXTURE, 'utf8')
if (content.length < 500 || /<p[\s>]/i.test(content)) {
  throw new Error('验证样本不是真实网络源结构（过短或含 p 标签），拒绝执行以免假绿')
}
const session = {
  book: {
    bookUrl: 'https://example.test/book/1', name: '截断测试书', author: '测试',
    origin: 'https://example.test/src.json', type: 0, coverUrl: '', intro: '',
    durChapterIndex: 0, durChapterTime: 0, group: 0, order: 0,
    originName: '测试书源', chapterUrl: 'https://example.test/book/1/ch1',
  },
  chapters: [{
    url: 'https://example.test/book/1/ch1', title: '第一章 测试', index: 0,
    isVolume: false, bookUrl: 'https://example.test/book/1',
  }],
  currentIndex: 0, chapterScrollProgress: 0, updatedAt: 0,
}

let server = null
let browser = null

async function startServer() {
  server = spawn(
    process.execPath,
    [resolve(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  server.stdout.on('data', (d) => { log += d.toString() })
  server.stderr.on('data', (d) => { log += d.toString() })
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('dev server 启动超时\n' + log)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'msedge', headless: true })
  } catch {
    return await chromium.launch({ headless: true })
  }
}

const measure = (page) => page.evaluate(() => {
  const c = document.querySelector('.reader-scroll-container')
  const t = document.querySelector('.chapter-text')
  const v = document.querySelector('.reader-view')
  if (!c || !t || !v) return null
  const cr = c.getBoundingClientRect()
  const lines = []
  // 与 useReaderLineGrid.textLineRects 同口径：逐文本节点取行矩形。
  // 直接 selectNodeContents(整章) 会把 div.con 的整块大矩形混进来，切行值失真。
  const blocks = t.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote')
  for (const root of blocks.length ? Array.from(blocks) : [t]) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent || !node.textContent.trim()) continue
      range.selectNodeContents(node)
      for (const x of range.getClientRects()) if (x.height > 4) lines.push(x)
    }
  }
  const cut = (edge, isTop) => {
    let worst = 0
    for (const l of lines) {
      if (l.top >= edge - 1 || l.bottom <= edge + 1) continue
      const amount = isTop ? edge - l.top : l.bottom - edge
      if (amount > worst) worst = amount
    }
    return +worst.toFixed(1)
  }
  return {
    topCut: cut(cr.top, true),
    bottomCut: cut(cr.bottom, false),
    remainder: getComputedStyle(v).getPropertyValue('--reader-line-remainder').trim(),
    clientHeight: c.clientHeight,
    scrollTop: +c.scrollTop.toFixed(1),
  }
})

const failures = []
try {
  await startServer()
  browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } })
  page.on('pageerror', (e) => failures.push(`页面异常: ${e.message}`))
  await page.addInitScript((s) => {
    localStorage.setItem('reader-last-session', JSON.stringify(s))
    // 记录所有 smooth 滚动：翻页路径不应产生任何一次（吸附不该二次修正）。
    window.__smoothScrolls = []
    const original = Element.prototype.scrollTo
    Element.prototype.scrollTo = function (opts) {
      if (opts && typeof opts === 'object' && opts.behavior === 'smooth') {
        window.__smoothScrolls.push(+Number(opts.top).toFixed(1))
      }
      return original.call(this, opts)
    }
  }, session)
  await page.route('**/reader3/**', async (route) => {
    const p = (route.request().url().split('/reader3/')[1] || '').split('?')[0]
    let data = {}
    if (/Shelf|Groups|List|list|Catalog|Sources|Rules|Bookmarks/i.test(p)) data = []
    if (p === 'getBookContent') data = content
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isSuccess: true, data, errorMsg: null }) })
  })
  await page.goto(`${BASE}/#/reader`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.chapter-text', { timeout: 15000 })
  await page.waitForFunction(
    () => (document.querySelector('.chapter-text')?.innerText || '').length > 200,
    null,
    { timeout: 15000 },
  )
  await page.waitForTimeout(1300)

  console.log('视口  | 最差顶切 | 最差底切 | 零头     | 结果')
  for (const height of VIEWPORTS) {
    await page.setViewportSize({ width: 1180, height })
    await page.waitForTimeout(600)
    let worstTop = 0
    let worstBottom = 0
    let remainder = ''
    const details = []
    for (const point of SCROLL_POINTS) {
      await page.evaluate((v) => { document.querySelector('.reader-scroll-container').scrollTop = v }, point)
      await page.waitForTimeout(750)
      const m = await measure(page)
      if (!m) { failures.push(`${height}px / ${point}: 阅读容器未渲染`); continue }
      worstTop = Math.max(worstTop, m.topCut)
      worstBottom = Math.max(worstBottom, m.bottomCut)
      remainder = m.remainder
      if (m.topCut > TOLERANCE || m.bottomCut > TOLERANCE) {
        details.push(`    ${point} → top ${m.topCut} / bottom ${m.bottomCut} (scrollTop ${m.scrollTop}, 容器 ${m.clientHeight})`)
        failures.push(`${height}px / scrollTop=${point}: top ${m.topCut}px, bottom ${m.bottomCut}px`)
      }
    }
    const ok = worstTop <= TOLERANCE && worstBottom <= TOLERANCE
    console.log(`${String(height).padEnd(5)} | ${String(worstTop).padEnd(8)} | ${String(worstBottom).padEnd(8)} | ${remainder.padEnd(8)} | ${ok ? 'ok' : 'FAIL'}`)
    for (const line of details) console.log(line)
  }

  // 真实滚轮手势后位置必须稳定（吸附不能与用户滚动互相拉扯）。
  await page.setViewportSize({ width: 1180, height: 800 })
  await page.waitForTimeout(500)
  await page.mouse.move(590, 400)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 90); await page.waitForTimeout(90) }
  await page.waitForTimeout(800)
  const a = await measure(page)
  await page.waitForTimeout(1200)
  const b = await measure(page)
  if (a && b && Math.abs(b.scrollTop - a.scrollTop) > 1) {
    failures.push(`滚轮后二次漂移 ${+(b.scrollTop - a.scrollTop).toFixed(1)}px`)
  }
  console.log(`滚轮稳定性: ${a && b ? (Math.abs(b.scrollTop - a.scrollTop).toFixed(1) + 'px 漂移') : '未取到数据'}`)

  // 连续空格翻页：补间停住后不得再被吸附拉一次（约定第 10 条）。
  // 补间默认 300ms ≈ 12 帧(25ms)，第 16 帧(400ms)之后若仍有位移即为回弹。
  await page.evaluate(() => {
    document.querySelector('.reader-scroll-container').scrollTop = 0
    window.__smoothScrolls = []
  })
  await page.waitForTimeout(600)
  console.log('\n翻页 | 400ms位置 | 稳定位置 | 二次位移 | 顶/底切 | 结果')
  let worstBounce = 0
  for (let k = 1; k <= 6; k++) {
    await page.keyboard.press('Space')
    const series = []
    for (let i = 0; i < 48; i++) {
      series.push(await page.evaluate(() => +document.querySelector('.reader-scroll-container').scrollTop.toFixed(1)))
      await page.waitForTimeout(25)
    }
    const early = series[16]
    const final = series[series.length - 1]
    let lastChange = 0
    for (let i = 1; i < series.length; i++) if (series[i] !== series[i - 1]) lastChange = i
    const bounce = lastChange > 16 ? +(final - early).toFixed(1) : 0
    worstBounce = Math.max(worstBounce, Math.abs(bounce))
    const m = await measure(page)
    const cuts = m ? `${m.topCut}/${m.bottomCut}` : 'n/a'
    const ok = Math.abs(bounce) <= TOLERANCE
      && (!m || (m.topCut <= TOLERANCE && m.bottomCut <= TOLERANCE))
    console.log(`${String(k).padEnd(4)} | ${String(early).padEnd(9)} | ${String(final).padEnd(9)} | ${String(bounce).padEnd(9)} | ${cuts.padEnd(8)} | ${ok ? 'ok' : 'FAIL'}`)
    if (Math.abs(bounce) > TOLERANCE) failures.push(`第 ${k} 次空格翻页后二次位移 ${bounce}px`)
    if (m && (m.topCut > TOLERANCE || m.bottomCut > TOLERANCE)) {
      failures.push(`第 ${k} 次翻页后切行 top ${m.topCut}px / bottom ${m.bottomCut}px`)
    }
    await page.waitForTimeout(400)
  }
  const smoothCalls = await page.evaluate(() => window.__smoothScrolls)
  if (smoothCalls.length) {
    failures.push(`翻页路径产生了 ${smoothCalls.length} 次 smooth 吸附: ${smoothCalls.join(', ')}`)
  }
  console.log(`翻页零回弹: 最差 ${worstBounce.toFixed(1)}px, smooth 吸附调用 ${smoothCalls.length} 次`)

  // 章末：真机阅读区高度就是 410px，切回去再测，避免只在 800px 下通过。
  // 从章首按空格到「物理到底」的次数不能超过理论页数 +1。
  await page.setViewportSize({ width: 1180, height: 410 })
  await page.waitForTimeout(600)
  // 吸附每页把 scrollTop 拉回会让 pageForward 的到底判定迟迟不成立，
  // 表现就是「本章最后要按好几次空格才翻页换章」。
  await page.evaluate(() => { document.querySelector('.reader-scroll-container').scrollTop = 0 })
  await page.waitForTimeout(600)
  const geom = await page.evaluate(() => {
    const c = document.querySelector('.reader-scroll-container')
    return { h: c.clientHeight, sh: c.scrollHeight }
  })
  const maxScroll = Math.max(0, geom.sh - geom.h)
  const startTop = await page.evaluate(() => document.querySelector('.reader-scroll-container').scrollTop)
  const maxLoop = Math.ceil(maxScroll / (geom.h * 0.75)) + 12
  let presses = 0
  let reachedBottom = false
  let firstStep = 0
  for (let i = 0; i < maxLoop; i++) {
    await page.keyboard.press('Space')
    presses++
    await page.waitForTimeout(500)
    const st = await page.evaluate(() => {
      const c = document.querySelector('.reader-scroll-container')
      return { top: c.scrollTop, bottom: c.scrollTop + c.clientHeight >= c.scrollHeight - 10 }
    })
    if (presses === 1) firstStep = st.top - startTop
    reachedBottom = st.bottom
    if (reachedBottom) break
  }
  const theoreticalPages = firstStep > 0 ? Math.ceil(maxScroll / firstStep) : -1
  console.log(`章末到底: 实测步长 ${firstStep.toFixed(1)}px / 理论 ${theoreticalPages} 页 / 按 ${presses} 次空格到底=${reachedBottom}`)
  if (!reachedBottom || theoreticalPages < 0 || presses > theoreticalPages + 1) {
    failures.push(`章末被拖住: 理论 ${theoreticalPages} 页, 实测按 ${presses} 次${reachedBottom ? '才到底' : '仍未到底'}`)
  }

  if (!a?.remainder || parseFloat(a.remainder) < 0) {
    failures.push('未检测到 --reader-line-remainder，挂载点可能被上游冲掉')
  }
} catch (err) {
  failures.push(`执行异常: ${err.message}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) server.kill('SIGTERM')
}

if (failures.length) {
  console.error(`\n整行排版校验失败（阈值 ${TOLERANCE}px）:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log(`\nLine grid verified: ${VIEWPORTS.length} 个视口 × ${SCROLL_POINTS.length} 个滚动位置，上下边界零截断；连续 6 次空格翻页零回弹`)
}
