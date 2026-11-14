#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const checks = [
  {
    name: '纯净模式状态模块',
    file: 'frontend/src/composables/useBorderlessMode.ts',
    markers: ['borderlessMode', 'globalThis', 'isBorderlessActive'],
  },
  {
    name: 'F12 全局切换',
    file: 'frontend/src/App.vue',
    markers: ['handleGlobalBorderlessKey', "'F12'"],
  },
  {
    name: '标题栏隐藏与拖拽条',
    file: 'frontend/src/App.vue',
    markers: ['!appStore.isWebMode && !borderlessMode', 'borderless-drag-strip'],
  },
  {
    name: '阅读页悬浮 UI 双拦',
    file: 'frontend/src/views/ReaderView.vue',
    markers: [
      '!borderlessMode && (showControls',
      'if (!borderlessMode.value) store.readerControlsVisible = value',
    ],
  },
  {
    name: '老板键默认启用',
    file: 'frontend/src/stores/app.ts',
    markers: ["localStorage.getItem(BOSS_KEY_KEY) !== 'disabled'"],
  },
  {
    name: 'CI 上游同步与标签输入',
    file: '.github/workflows/release.yml',
    markers: ['upstream_sha', 'release_tag:'],
  },
  {
    name: '窗口初始无阴影且可拉伸',
    file: 'desktop/src-tauri/src/main.rs',
    markers: ['.shadow(false)', '.resizable(true)'],
  },
  {
    name: 'F12 运行时切换窗口阴影',
    file: 'frontend/src/App.vue',
    markers: ['syncWindowShadow', 'setShadow(', 'setResizable(true)'],
  },
  {
    name: '阴影与拉伸权限',
    file: 'desktop/src-tauri/capabilities/default.json',
    markers: ['core:window:allow-set-shadow', 'core:window:allow-set-resizable'],
  },
  {
    name: '纯净模式点击路径硬闸',
    file: 'frontend/src/views/ReaderView.vue',
    markers: ['isBorderlessActive()', "action !== 'prevPage'", '!borderlessMode && store.activePanel'],
  },
  {
    name: '边距设置三模式同源',
    file: 'frontend/src/views/ReaderView.vue',
    markers: ['config.pageSidePadding', 'var(--reader-page-vertical-padding'],
  },
  {
    name: '左右边距配置与滑块',
    file: 'frontend/src/stores/reader.ts',
    markers: ['pageSidePadding', 'READER_PAGE_SIDE_PADDING_MAX'],
  },
  {
    name: '视口级边距(拉伸/滚动后保持)',
    file: 'frontend/src/views/ReaderView.vue',
    markers: ['viewport-inset-mode', '.reader-view.viewport-inset-mode .chapter-content'],
  },
  {
    name: '整行排版独立模块',
    file: 'frontend/src/composables/useReaderLineGrid.ts',
    markers: [
      'export function useReaderLineGrid',
      'chooseRemainder',
      'collectFlowRects',
      'scheduleSnap',
      'APP_VIEWPORT_CHANGE_EVENT',
    ],
  },
  {
    name: '整行排版挂载点',
    file: 'frontend/src/views/ReaderView.vue',
    markers: [
      "import { useReaderLineGrid } from '../composables/useReaderLineGrid'",
      'const lineGrid = useReaderLineGrid({',
      'lineGrid.scheduleSnap()',
      'lineGrid.sync()',
      'lineGrid.alignPageTarget(',
      '--reader-line-remainder',
    ],
  },
  {
    name: '排版约定文档',
    file: 'docs/reader-line-grid.md',
    markers: ['路线 1', '改动隔离与上游同步', '禁止'],
  },
  {
    name: '几何断言脚本',
    file: 'scripts/verify-line-grid.mjs',
    markers: ['chromium', 'topCut', 'bottomCut', 'VIEWPORTS', '__smoothScrolls', '翻页零回弹'],
  },
]

const failures = []
for (const check of checks) {
  const full = join(root, check.file)
  if (!existsSync(full)) {
    failures.push(`${check.name}: 缺少文件 ${check.file}`)
    continue
  }
  const source = readFileSync(full, 'utf8')
  const missing = check.markers.filter((marker) => !source.includes(marker))
  if (missing.length) {
    failures.push(`${check.name} (${check.file}) 缺少：${missing.join(' / ')}`)
  } else {
    console.log(`  ok  ${check.name}`)
  }
}

if (failures.length) {
  throw new Error(`自定义功能校验失败，构建中止：\n  - ${failures.join('\n  - ')}`)
}

console.log(`Borderless features verified: ${checks.length}/${checks.length}`)
