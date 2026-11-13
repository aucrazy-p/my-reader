#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const checks = [
  {
    name: '纯净模式状态模块',
    file: 'frontend/src/composables/useBorderlessMode.ts',
    markers: ['borderlessMode'],
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
