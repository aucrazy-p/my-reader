import { ref } from 'vue'

/**
 * 「纯净无边框」模式 —— 对齐 binbyu/Reader 的 F12 行为。
 *
 * 桌面壳本来就是 `.decorations(false)` 的真无边框窗口，但前端自绘的
 * TitleBar.vue 仍占 32px、带 1px 下边线与毛玻璃，视觉上留下一条「假边框」。
 * 开启本模式后：标题栏不渲染、阅读页悬浮控件完全不呼出，正文从窗口顶边开始。
 * 关闭（再按一次 F12）则恢复标题栏与工具栏，用于改设置、拖窗口、最小化/关闭。
 *
 * 状态是模块级单例：App.vue（顶层外壳）与 ReaderView.vue（路由内阅读页）共享
 * 同一份，无需塞进 pinia —— 它只影响窗口外壳，不参与任何业务数据流。
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

const borderlessMode = ref(readSavedMode())

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
