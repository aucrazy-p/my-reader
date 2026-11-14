# 阅读页整行排版约定

> 2026-11-14 确认，同日路线 1 定稿。适用于纵向滚动阅读模式。
> 背景：网络源小说上/下边界出现半截行；上游与 `9f6edee` 都没有解决。
> 实现位置：`frontend/src/composables/useReaderLineGrid.ts`（独立模块）；
> `ReaderView.vue` 只保留挂载点。改动原因见「改动隔离与上游同步」。

## 目标

纵向滚动时视口上、下边界都不得出现半截行；**窗口可任意拉伸**，设置项（页宽、边距、字号、行高、字体、段距）不受限制；F12 纯净无边框与 `resizable` 行为不变；章节标题不被滚动顶掉。

## 约定（实现与维护必须遵守）

1. **窗口尺寸自由**：不得锁定、量化或吸附窗口高度。要对齐的是「正文可视区的有效高度」，不是窗口。
2. **零头留白（路线 1 定稿）**：把不足一行的零头 `r`（`0 ≤ r < 行高`）吸收进 `.reader-view.viewport-inset-mode` 的 `padding-bottom`（CSS 变量 `--reader-line-remainder`）。该层 `overflow: hidden`，正文永远滚不进这段留白，不产生黑边。
   - **禁止**用 `r = usable mod 行高` 这类理论公式：段距 `0.2em`、章节标题、图片让正文行不是均匀行网格，实测只在部分窗口高度恰好成立。
   - **必须**按真实几何动态选 `r`：归零补偿后，用 `Range.getClientRects()` 取内容流坐标前几屏的真实文字行沿，在 `[0, 行高)` 内生成候选（含 0.5px 细扫、理论值、首屏行沿反推值）。**首屏零截断是硬约束**（首屏不能靠滚动吸附修正），先过滤出首屏底边不切行的候选，再用若干「以行沿作顶边」的代表位置一起评分（最差值 ×2 + 平均值），选让最多中段位置底边也不切行的 `r`；平手取 `r` 最小。找不到行矩形时退回理论值，保证不比基线差。只按首屏选 `r` 会让 680/860px 中段残留 5～6px，实测已证伪。
   - 该区间长度恰为一行，而行沿最大间距不超过一行，因此**必有可行解**；落在某行上沿意味着那一行整行不显示，不是半截。
3. **零头只加底部**，不分摊到顶部。顶部必须保持内容流起点，否则顶部又偏。
   - **禁止**再试「把正文首行补到整行位置」（`--reader-line-head-inset`）：改内容流起点会被段距累积打崩，实测 800px 首屏从 0 恶化到 20.1px，已完整回退。路线 1 只调视口底边，两者不同。
4. **按真实行矩形吸附**：用 `Range.getClientRects()` 取视口附近的真实文字行，由「让任意行沿落到视口顶边/底边」生成位移候选（限一行内），再按滚动后上/下边界各切掉多少评分（顶边权重更高），选最完整的一个；不比原地更好就不动。禁止 `baseTop + n × lineHeight` 这类全局均匀网格假设。章节开头顶部是标题区时靠底边候选兜底。
5. **边缘不跳过**：吸附目标 `clamp` 到 `[0, maxScroll]`。唯一例外是 `scrollTop === 0`（首屏顶部本就完整，避免把章节标题滚掉）；其余含首屏附近与末屏区域一律照常吸附。**首屏零截断由第 2 条保证，不能靠首屏滚动吸附**（会顶掉标题、改写阅读进度）。
6. **行高按当前视口内的正文元素取** `computed lineHeight`，不取文档中第一个匹配元素（连续阅读多章节、EPUB 会算错基准）。
7. **重算时机**：挂载、`resize`、`APP_VIEWPORT_CHANGE_EVENT`、字号/行高/字体/上下左右边距/纯净模式/听书面板高度/章节内容变化。计算时先扣除滚动容器自身的 `padding-bottom`（听书面板会让内容可视区变矮），每次先归零再从「未补偿」布局重测，避免累加。
8. **左右分页模式不参与**：它自带整页机制，零头必须为 0，吸附函数直接返回。
9. **吸附手感**：只作用于纵向滚动；单次位移上限 1 行，找不到行矩形不吸附；保留 140ms debounce、320ms `isSnapping` 防抖与原生 smooth，避免和用户滚动抢位置。

## 依据

底部边界 = `scrollTop + clientHeight`。JS 只能改 `scrollTop`；只要底边落在某一行中间，吸附也救不了首屏（`scrollTop = 0` 不能动）。实测：视口 800px 时 `clientHeight = 752`、行高 32.4px、`752 mod 32.4 = 6.8`，首屏底部被切 21.6px。

旧版用「视口高度取行高整数倍」后，800/860px 全点位归零，但多视口扫描暴露 680/740/920/1000px 首屏仍切 14.1 / 21.3 / 3.2 / 13.9px——理论网格假设不成立，故改路线 1。

路线 1 首版只按首屏选 `r`：6 个视口首屏全部归零，但 680/860px 中段残留 5.2～6.3px 底切（`r` 全篇共用，中段顶边对齐后底边未必落在行沿上）。把「多个真实行沿作顶边」的代表位置纳入评分后，`scripts/verify-line-grid.mjs` 实测 **6 视口 × 6 滚动位置 topCut / bottomCut 全为 0**，真实滚轮连滚无二次漂移。

## 改动隔离与上游同步

fork 的 12 个自定义提交留在 `main`，不得挪到分支：CI 由 `v*` 标签或手动 `workflow_dispatch` 触发，默认从 `main` checkout，再临时合并上游最新 `main`；`main` 若退回纯上游，默认构建会丢掉无边框功能且 `verify-borderless.mjs` 直接报错。

- **逻辑必须放在独立文件** `frontend/src/composables/useReaderLineGrid.ts`。新文件上游永远不会有，合并零冲突；`ReaderView.vue` 是该仓库改动最频繁的文件（fork 累计 30+ hunk），只保留 import、一次 `useReaderLineGrid()` 调用、`handleScroll` 里的 `scheduleSnap()`、`onMounted` 里一次 `sync()`，以及 CSS 里 `--reader-line-remainder` 的引用。
- **生命周期自包含**：composable 内部用 `onMounted` / `onUnmounted` / `watch` 自行注册与清理 `resize`、`APP_VIEWPORT_CHANGE_EVENT`、rAF 与定时器，不在 `ReaderView.vue` 的卸载函数里加清理代码。
- **CI 护栏**：`scripts/verify-borderless.mjs` 检查独立文件与挂载点 marker（已有 CI 步骤，零新增成本）；`scripts/verify-line-grid.mjs` 提供 Playwright 几何断言，合并上游后手动跑一次。上游若自行引入同类吸附机制，两套会打架，composable 必须能一键禁用。
- **同步策略**：CI 的临时合并保留作「构建时用最新上游」的保险（只在 runner 工作区，不 push 回仓库）；另外定期在本地 `fetch upstream && merge upstream/main`，解一次冲突后 push 到 `origin/main`，让 CI 那步退化为 no-op。

## 验证口径

- `npx vue-tsc -b`、`npm test`、`npm run build`（正式构建前须先清理旧 `frontend/dist`）。
- `node scripts/verify-borderless.mjs`：自定义功能 marker 全绿。
- `node scripts/verify-line-grid.mjs`（自包含：自动起 Vite dev server + Edge），注入 `reader-last-session` 模拟网络源章节，用 `Range.getClientRects()` 逐行矩形与容器上/下边界比对：任意滚动位置 `topCut` / `bottomCut` 应 ≈ 0；真实滚轮连滚后无二次漂移。
- **多视口扫描必测**：窗口高度 680 / 740 / 800 / 860 / 920 / 1000px，每个都测首屏 `scrollTop = 0` 与中段随机位置；这是发现旧版残留的关键手段。
- 回归基线：800px 首屏（原切 21.6px）、`scrollTop = 12`（原切 9.6px）、1000.3 / 1700.6 / 2600.4、接近 `maxScroll`、826px 拉伸后零头重算。

## 禁止

- 恢复 `scroll-snap-type: y mandatory`：长段落中段会被硬拉回段首。
- 用全局行网格公式（`usable mod 行高`、`baseTop + n × 行高`）决定零头或吸附位置。
- 把段距强行改成行高整数倍，或改动任何排版设置项来「顺便」修截断。
- 允许首屏滚动吸附（会顶掉章节标题、改写阅读进度）。
- 锁死窗口高度、把零头做成黑边、用渐隐遮罩遮住半截行当作「修好」。
