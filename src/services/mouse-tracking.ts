// ==========================================
// 鼠标追踪 —— 全屏视差跟随（可复用场景）
//
// 光标在整个电脑屏幕上移动时，多个视觉图层产生水平视差 + 垂直完全同步的跟随：
// - 数据源：OS 级全局光标（Rust get_normalized_cursor，Windows GetCursorPos /
//   macOS NSEvent.mouseLocation），不使用 clientX/clientY 作为主数据源
// - 归一化：Rust 侧以光标所在屏幕中心为原点归一化到 [-1,1]
// - 数学模型（参数集中在 MOUSE_PARALLAX_CONFIG）：
//     characterX  = normX × CHARACTER_X_FACTOR
//     backgroundX = normX × BACKGROUND_X_FACTOR   （两因子不同 → 水平视差）
//     sharedY     = normY × SHARED_Y_FACTOR       （同一变量 → 垂直完全同步）
//     分别 clamp 到 MAX_X / MAX_Y
// - 单一 rAF 循环：平滑作用于共享的归一化值，所有图层在同一次 tick 内
//   统一提交 transform，避免"局部先移动"的撕裂/波纹
// - 与序列帧动画完全解耦：只操作图层容器的 transform，
//   不触碰 src / 帧切换逻辑（帧动画自身不写 transform）
// ==========================================

import { invoke } from "@tauri-apps/api/core";

/** 全局归一化光标（以光标所在屏幕中心为原点，[-1,1]） */
export interface GlobalCursorState {
  normX: number;
  normY: number;
}

/** 全局光标数据源：一次 fetch 返回归一化光标位置 */
export interface GlobalMouseSource {
  fetch(): Promise<GlobalCursorState | null>;
  /** 窗口可见时轮询间隔 (ms)，默认 33 */
  intervalMs?: number;
  /** 窗口隐藏时心跳间隔 (ms)，默认 500 */
  hiddenIntervalMs?: number;
}

// ==========================================
// 全局光标共享轮询器（多个场景共用一个 IPC 轮询）
// ==========================================

type GlobalSubscriber = (state: GlobalCursorState) => void;

let globalSource: GlobalMouseSource | null = null;
const globalSubscribers = new Set<GlobalSubscriber>();
let globalTimer: ReturnType<typeof setTimeout> | null = null;
let globalVisibilityBound = false;

/** 注册/注销全局光标数据源（桌面主窗口启动时注册一次，所有场景共用） */
export function registerGlobalMouseSource(source: GlobalMouseSource | null): void {
  globalSource = source;
  if (source) {
    if (!globalVisibilityBound) {
      globalVisibilityBound = true;
      document.addEventListener("visibilitychange", onGlobalVisibility);
    }
    kickGlobalPoll();
  } else {
    if (globalVisibilityBound) {
      globalVisibilityBound = false;
      document.removeEventListener("visibilitychange", onGlobalVisibility);
    }
    if (globalTimer !== null) {
      clearTimeout(globalTimer);
      globalTimer = null;
    }
  }
}

function onGlobalVisibility(): void {
  if (!document.hidden) kickGlobalPoll();
}

function kickGlobalPoll(): void {
  if (!globalSource || globalSubscribers.size === 0) return;
  if (globalTimer !== null) clearTimeout(globalTimer);
  globalTimer = setTimeout(globalTick, 0);
}

function globalTick(): void {
  globalTimer = null;
  const src = globalSource;
  if (!src || globalSubscribers.size === 0) return;
  // 窗口隐藏时只保持低频心跳，恢复显示后立即回到正常频率
  if (document.hidden) {
    globalTimer = setTimeout(globalTick, src.hiddenIntervalMs ?? 500);
    return;
  }
  Promise.resolve(src.fetch())
    .then((state) => {
      if (!state || globalSubscribers.size === 0) return;
      for (const sub of globalSubscribers) {
        try { sub(state); } catch { /* ignore */ }
      }
    })
    .catch(() => { /* 保持下一轮轮询 */ })
    .finally(() => {
      if (globalTimer === null && globalSource && globalSubscribers.size > 0) {
        globalTimer = setTimeout(globalTick, src.intervalMs ?? 33);
      }
    });
}

/** Tauri 默认数据源：Rust 侧完成屏幕中心归一化 */
export const tauriGlobalMouseSource: GlobalMouseSource = {
  async fetch() {
    const p = await invoke<{ norm_x: number; norm_y: number }>("get_normalized_cursor");
    if (typeof p?.norm_x !== "number" || typeof p?.norm_y !== "number") return null;
    return { normX: p.norm_x, normY: p.norm_y };
  },
  intervalMs: 33,
  hiddenIntervalMs: 500,
};

// ==========================================
// 视差参数（集中管理，调整这里即可全局生效）
// ==========================================

export interface MouseParallaxConfig {
  /** 背景图层水平位移因子 */
  BACKGROUND_X_FACTOR: number;
  /** 人物图层水平位移因子（与背景不同以形成水平视差） */
  CHARACTER_X_FACTOR: number;
  /** 两个图层共享的垂直位移因子（保证 Y 完全同步） */
  SHARED_Y_FACTOR: number;
  /** 最大水平位移 (px) */
  MAX_X: number;
  /** 最大垂直位移 (px) */
  MAX_Y: number;
  /** 追踪平滑度 0~1（每 1/60s 的接近比例），越大越灵敏 */
  TRACKING_SMOOTHNESS: number;
}

export const MOUSE_PARALLAX_CONFIG: MouseParallaxConfig = {
  BACKGROUND_X_FACTOR: 5,
  CHARACTER_X_FACTOR: 14,
  SHARED_Y_FACTOR: 7,
  MAX_X: 16,
  MAX_Y: 10,
  TRACKING_SMOOTHNESS: 0.12,
};

// ==========================================
// 视差场景（单一 rAF 循环，同帧提交全部图层）
// ==========================================

export interface MouseParallaxTarget {
  /** 图层容器元素（transform 只由场景写入，避免与序列帧动画系统冲突） */
  element: HTMLElement;
  /** 该图层水平位移因子（各图层可不同 → 水平视差） */
  xFactor: number;
  /** 附加缩放，用于全幅背景平移时防止露出边缘，默认 1 */
  scale?: number;
}

export interface MouseParallaxScene {
  start(): void;
  stop(): void;
}

/** 收敛判定阈值（归一化单位），小于该值视为已到位并暂停 rAF */
const SETTLE_EPSILON = 0.0005;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 创建一个全屏视差追踪场景。
 * 所有图层共享同一份平滑后的归一化光标值：
 * - X 位移 = 平滑 normX × 各图层 xFactor（独立 → 视差）
 * - Y 位移 = 平滑 normY × SHARED_Y_FACTOR（同一变量 → 完全同步）
 * 全部 transform 在同一次 rAF tick 内提交，不会出现图层间相位差/撕裂。
 */
export function createMouseParallaxScene(
  targets: MouseParallaxTarget[],
  config: MouseParallaxConfig = MOUSE_PARALLAX_CONFIG,
): MouseParallaxScene {
  const layers = targets.map((t) => ({
    element: t.element,
    xFactor: t.xFactor,
    scale: t.scale ?? 1,
  }));
  const targetNorm = { x: 0, y: 0 };
  const smooth = { x: 0, y: 0 };
  let rafId: number | null = null;
  let lastTs = 0;
  let running = false;
  const lastWrites: string[] = [];

  function setTarget(nx: number, ny: number): void {
    // 目标无实质变化时不唤醒 rAF（轮询仍在跑，但零渲染开销）
    if (Math.abs(nx - targetNorm.x) < SETTLE_EPSILON && Math.abs(ny - targetNorm.y) < SETTLE_EPSILON) return;
    targetNorm.x = nx;
    targetNorm.y = ny;
    if (running) ensureLoop();
  }

  function ensureLoop(): void {
    if (rafId !== null) return;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function cancelLoop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function tick(ts: number): void {
    rafId = null;
    if (!running) return;

    const dt = lastTs > 0 ? clamp(ts - lastTs, 0, 100) : 1000 / 60;
    lastTs = ts;
    // 帧率无关：换算为当前帧时长下的接近比例
    const factor = 1 - Math.pow(1 - config.TRACKING_SMOOTHNESS, dt / (1000 / 60));
    smooth.x += (targetNorm.x - smooth.x) * factor;
    smooth.y += (targetNorm.y - smooth.y) * factor;
    applyTransforms();

    if (Math.hypot(targetNorm.x - smooth.x, targetNorm.y - smooth.y) < SETTLE_EPSILON) {
      // 收敛：吸附到目标值并暂停循环，下一次输入再唤醒
      smooth.x = targetNorm.x;
      smooth.y = targetNorm.y;
      applyTransforms();
      lastTs = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  /** 同一次调用内提交全部图层 transform：sharedY 对所有图层完全相同 */
  function applyTransforms(): void {
    const sharedY = clamp(smooth.y * config.SHARED_Y_FACTOR, -config.MAX_Y, config.MAX_Y);
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const x = clamp(smooth.x * layer.xFactor, -config.MAX_X, config.MAX_X);
      const next = `translate3d(${x.toFixed(2)}px, ${sharedY.toFixed(2)}px, 0) scale(${layer.scale})`;
      if (next !== lastWrites[i]) {
        lastWrites[i] = next;
        layer.element.style.transform = next;
      }
    }
  }

  function onGlobalState(state: GlobalCursorState): void {
    if (!running) return;
    setTarget(state.normX, state.normY);
  }

  function onVisibility(): void {
    if (document.hidden) {
      // 窗口隐藏：立即归零停止，恢复显示时从初始状态开始
      targetNorm.x = 0;
      targetNorm.y = 0;
      smooth.x = 0;
      smooth.y = 0;
      cancelLoop();
      applyTransforms();
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    applyTransforms();
    globalSubscribers.add(onGlobalState);
    document.addEventListener("visibilitychange", onVisibility);
    kickGlobalPoll();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    cancelLoop();
    globalSubscribers.delete(onGlobalState);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const layer of layers) {
      layer.element.style.transform = "";
    }
    lastWrites.length = 0;
  }

  return { start, stop };
}
