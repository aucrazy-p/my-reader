/**
 * 真机回归：CDP 接管正在运行的 Reader，连续按空格翻页并逐帧量文字屏幕坐标。
 *
 * 前置（必须用户手动做，脚本不启动程序）：
 *   在自己的 CMD 里，先 cd 到程序目录，再
 *     set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --remote-allow-origins=*"
 *     Reader.exe
 *   等窗口恢复到正文阅读页，别关。
 *
 * 用法：node scripts/verify-line-grid-live.mjs
 * 环境变量：LIVE_PORT(9222) / LIVE_PAGES(30) / LIVE_DWELL(900)
 *
 * 为什么需要它：本地 verify-line-grid.mjs 用单章 mock + 固定视口，曾三次「全绿」但真机
 * 仍晃动（尤其 1px 级评分分歧残差只在大样本、多章 remainder 重算后才偶发）。真机扫描
 * 是判据的最终口径，不是可选项。
 *
 * 判据（硬）：
 *   - 每次按键 100ms 之后，正文首行屏幕坐标与 scrollTop 不得再有任何变化（二次位移 = 0）；
 *   - 翻页/换章路径不得出现 behavior:'smooth' 的 scrollTo（吸附不该补拉）；
 *   - 连续 LIVE_PAGES 次按键须跨越多章，remainder 重算后仍满足上面两条。
 */
import { chromium } from '@playwright/test'

const PORT = Number(process.env.LIVE_PORT || 9222)
const PAGES = Number(process.env.LIVE_PAGES || 30)
const DWELL = Number(process.env.LIVE_DWELL || 900)
const eps = 0.4

let browser
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
} catch (e) {
  console.error(`CDP 未就绪 (127.0.0.1:${PORT})。请先按文件头说明带调试端口启动程序，停在正文阅读页。`)
  process.exit(2)
}
const pages = browser.contexts().flatMap((c) => c.pages())
const page = pages.find((x) => x.url().includes('tauri')) || pages[0]
if (!page) { console.error('没有可接管的页面'); process.exit(2) }

const state = await page.evaluate(() => {
  const c = document.querySelector('.reader-scroll-container')
  return {
    ok: !!c && !!c.querySelector('.chapter-text'),
    title: document.querySelector('.chapter-title')?.innerText,
    h: c?.clientHeight, sh: c?.scrollHeight, st: c?.scrollTop,
    rem: getComputedStyle(document.querySelector('.reader-view') || document.body).getPropertyValue('--reader-line-remainder').trim(),
  }
})
console.log('PAGE', JSON.stringify(state))
if (!state.ok) { console.error('NOT_ON_READER_PAGE：请先切到正文阅读页'); process.exit(2) }

await page.evaluate(() => {
  const S = (window.__liveVerify = { t0: performance.now(), phase: 'init', events: [], calls: [], marks: [], on: true })
  const now = () => +(performance.now() - S.t0).toFixed(1)
  const orig = Element.prototype.scrollTo
  Element.prototype.scrollTo = function (...args) {
    try {
      const o = typeof args[0] === 'object' && args[0] ? args[0] : { top: args[0], left: args[1] }
      S.calls.push({ t: now(), phase: S.phase, behavior: o.behavior || 'auto', top: typeof o.top === 'number' ? +o.top.toFixed(2) : null, cur: +this.scrollTop.toFixed(2) })
    } catch { /* ignore */ }
    return orig.apply(this, args)
  }
  const sample = () => {
    if (!S.on) return
    const c = document.querySelector('.reader-scroll-container')
    if (c) {
      const t = c.querySelector('.chapter-text')
      let fl = null
      if (t) {
        try {
          const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT)
          let n
          while ((n = w.nextNode())) {
            if (n.nodeValue && n.nodeValue.trim()) {
              const r = document.createRange(); r.selectNodeContents(n)
              const rs = r.getClientRects()
              if (rs.length) { fl = rs[0].top; break }
            }
          }
        } catch { /* ignore */ }
      }
      S.events.push({
        t: now(), phase: S.phase, st: +c.scrollTop.toFixed(2), sh: c.scrollHeight, ch: c.clientHeight,
        rem: getComputedStyle(document.querySelector('.reader-view') || document.body).getPropertyValue('--reader-line-remainder').trim(),
        fl: fl === null ? null : +fl.toFixed(2),
        title: (document.querySelector('.chapter-title')?.innerText || '').slice(0, 22),
      })
    }
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
})

for (let i = 1; i <= PAGES; i++) {
  await page.evaluate((n) => {
    window.__liveVerify.phase = 'P' + n
    window.__liveVerify.marks.push({ n, t: +(performance.now() - window.__liveVerify.t0).toFixed(1) })
  }, i)
  await page.keyboard.press('Space')
  await page.waitForTimeout(DWELL)
}

const d = await page.evaluate(() => {
  window.__liveVerify.on = false
  const S = window.__liveVerify
  return { events: S.events, calls: S.calls, marks: S.marks }
})

function segs(rows, key) {
  const out = []
  let cur = null
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], z = rows[i]
    if (a[key] == null || z[key] == null) { cur = null; continue }
    const dd = +(z[key] - a[key]).toFixed(2)
    if (Math.abs(dd) < eps) { cur = null; continue }
    if (!cur) { cur = { from: a.t, to: z.t, delta: 0 }; out.push(cur) }
    cur.to = z.t; cur.delta = +(cur.delta + dd).toFixed(2)
  }
  return out.filter((s) => Math.abs(s.delta) >= eps)
}

let lateCount = 0
const lateDetail = []
for (let i = 1; i <= PAGES; i++) {
  const ph = 'P' + i
  const rows = d.events.filter((e) => e.phase === ph)
  if (!rows.length) continue
  const mark = d.marks.find((m) => m.n === i)?.t ?? rows[0].t
  const st = segs(rows, 'st').map((s) => ({ ...s, rel: +(s.from - mark).toFixed(0) }))
  const fl = segs(rows.filter((r) => r.fl != null), 'fl').map((s) => ({ ...s, rel: +(s.from - mark).toFixed(0) }))
  // 动画时长为 0 时翻页是即时（<20ms）；>100ms 后的任何变化都是吸附/布局二次位移。
  const bad = [...st, ...fl].filter((s) => s.rel > 100)
  if (bad.length) { lateCount++; lateDetail.push({ page: i, st, fl }) }
}
const smooth = d.calls.filter((c) => c.behavior === 'smooth')
const chapters = [...new Set(d.events.map((e) => e.title).filter(Boolean))]
const rems = [...new Set(d.events.map((e) => e.rem))]

console.log(`\n连续 ${PAGES} 次空格，跨 ${chapters.length} 章，remainder=${rems.join('/')}`)
console.log(`按键 100ms 后的二次位移: ${lateCount} 次`, lateDetail.length ? JSON.stringify(lateDetail) : '')
console.log(`behavior:'smooth' 调用: ${smooth.length} 次`, smooth.length ? JSON.stringify(smooth.slice(0, 10)) : '')
console.log('其余 scrollTo:', d.calls.length - smooth.length, '次（换章 instant 到 0 属正常）')
console.log('章节序列:', chapters.join(' -> '))
const pass = lateCount === 0 && smooth.length === 0 && chapters.length >= 2
console.log('VERDICT', pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
