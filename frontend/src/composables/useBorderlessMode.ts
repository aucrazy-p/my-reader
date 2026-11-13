import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 「纯净无边框」模式 —— 对齐 binbyu/Reader 的 F12 行为。
 *
 * 桌面壳本来就是 `.decorations(false)` 的真无边框窗口，但前端自绘的
 * TitleBar.vue 仍占 32px、带 1px 下边线与毛玻璃，视觉上留下一条「假边框」。
 * 开启本模式后：标题栏不渲染、阅读页悬浮控件完全不呼出，正文从窗口顶边开始。
 * 关闭（再按一次 F12）则恢复标题栏与工具栏，用于改设置、拖窗口、最小化/关闭。
 *
 * 状态挂在 globalThis 上做全局单例：vite.config.ts 的 manualChunks 加上路由懒加载
 * 可能把本模块复制进多个 chunk，纯模块级 ref 会分裂成好几份 —— 表现为 App.vue
 * 已经藏掉标题栏，ReaderView.vue 却仍把悬浮控件弹出来。无需塞进 pinia：
 * 它只影响窗口外壳，不参与任何业务数据流。
 *
 * 默认开启：老用户升级后直接进入纯净阅读，想找回标题栏按一次 F12 即可。
 */
const STORAGE_KEY = 'reader-borderless-mode'

function readSavedMode(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    // 只有显式存过 'disabled' 才恢复成带标题栏；没有存档一律默认纯净。
    return localStorage.getItem(STORAGE_KEY) !== 'disabled'
  } catch {
    // 隐私模式 / 存储被禁用：保守回落到默认纯净。
    return true
  }
}

// 跨 chunk 共享的唯一 ref。用 globalThis 而不是模块级常量, 见文件头注释。
const globalRefs = globalThis as typeof globalThis & {
  __readerBorderlessModeRef__?: Ref<boolean>
}
let borderlessMode: Ref<boolean> = globalRefs.__readerBorderlessModeRef__ ?? ref(readSavedMode())
if (!globalRefs.__readerBorderlessModeRef__) {
  globalRefs.__readerBorderlessModeRef__ = borderlessMode
}

/**
 * 纯净模式硬闸：直接读 <html class="borderless-active">。
 * App.vue 的 watch 负责维护这个 class；它不走 Vue 响应式链路，所以在点击回调里
 * 实时读取一定是当前真实状态，即便构建分块再次把状态拆开也能兜住。
 */
export function isBorderlessActive(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('borderless-active')
}

export function useBorderlessMode() {
  function setBorderlessMode(value: boolean) {
    borderlessMode.value = value
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, value ? 'enabled' : 'disabled')
      }
    } catch {
      // 存储不可写时仍保留本次会话内的切换结果。
    }
  }

  function toggleBorderlessMode(): boolean {
    setBorderlessMode(!borderlessMode.value)
    return borderlessMode.value
  }

  return { borderlessMode, setBorderlessMode, toggleBorderlessMode }
}
