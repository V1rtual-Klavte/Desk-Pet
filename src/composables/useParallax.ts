// ==========================================
// useParallax — 灵动图层引擎
// 五层直接映射，零惯性，指哪打哪
// ==========================================

import { computed, type Ref } from "vue";
import { userConfig } from "@/services/config";

// ── 类型 ──

export interface ParallaxLayerCfg {
  enabled: boolean
  image: string
  sensitivity: number
  shadow: number
  brightness: number
  contrast: number
  saturate: number
  scale: number
  offsetX: number
  offsetY: number
  locked: boolean
}

export interface ParallaxState {
  enabled: boolean
  intensity: number
  layers: ParallaxLayerCfg[]
}

/** 默认五层配置 (L0→L4) */
export const DEFAULT_LAYERS: ParallaxLayerCfg[] = [
  { enabled: true,  image: "materials/L0/bg_base.png",    sensitivity: 0.2, shadow: 0.25, brightness: 0.93, contrast: 0.96, saturate: 0.92, scale: 1.0, offsetX: 0, offsetY: 0, locked: false },
  { enabled: false, image: "",                          sensitivity: 0.5, shadow: 0.18, brightness: 0.95, contrast: 0.98, saturate: 0.95, scale: 1.0, offsetX: 0, offsetY: 0, locked: false },
  { enabled: true,  image: "materials/L2/body.png",        sensitivity: 0.8, shadow: 0.12, brightness: 1.00, contrast: 1.00, saturate: 1.00, scale: 1.0, offsetX: 0, offsetY: 0, locked: false },
  { enabled: false, image: "",                          sensitivity: 1.2, shadow: 0.06, brightness: 1.02, contrast: 1.02, saturate: 1.05, scale: 1.0, offsetX: 0, offsetY: 0, locked: false },
  { enabled: true,  image: "materials/L4/shield_gold.png", sensitivity: 1.6, shadow: 0.03, brightness: 1.03, contrast: 1.03, saturate: 1.08, scale: 1.0, offsetX: 0, offsetY: 0, locked: false },
];

export const DEFAULT_PARALLAX_STATE: ParallaxState = {
  enabled: false,
  intensity: 1.0,
  layers: DEFAULT_LAYERS.map(l => ({ ...l })),
};

// ── 图层名称 ──
export const LAYER_NAMES = ["底背景", "人物背景", "角色本体", "覆盖层1", "覆盖层2"];

// ── 工具 ──

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 图层深度 (0-1)，基于 sensitivity × intensity，和编辑器共用 */
export function layerDepth(sensitivity: number, intensity: number = 1.0): number {
  return clamp((sensitivity * intensity) / 1.6, 0, 1);
}

// ==========================================
// Composable
// ==========================================

/**
 * 灵动图层引擎 — 直接映射，零惯性
 *
 * 每帧根据光标相对窗口位置直接计算 translate，
 * 无弹簧、无速度累积、无 RAF 中间状态。
 * 依赖 Vue computed 响应式：globalCursor 变化 → 自动重算 layerStyles。
 *
 * @param globalCursor  全局鼠标坐标（从 Rust deskpet-cursor-move 事件，web 坐标系）
 * @param windowPos     窗口左上角在屏幕上的位置（web 坐标系）
 * @param windowSize    窗口逻辑尺寸
 * @param config        灵动图层运行时配置
 */
export function useParallax(
  globalCursor: Ref<{ x: number; y: number } | null>,
  windowPos: Ref<{ x: number; y: number } | null>,
  windowSize: Ref<{ w: number; h: number }>,
  config: Ref<ParallaxState>,
  isVisible: Ref<boolean>,
) {
  // ── 每层 CSS style（computed 直接响应 globalCursor 变化）──
  const layerStyles = computed(() => {
    const active = config.value.enabled && isVisible.value;
    const intensity = config.value.intensity;
    const gc = globalCursor.value;
    const wp = windowPos.value;
    const win = windowSize.value;

    const hasCursor = active && gc && wp && win.w > 0 && win.h > 0;
    let nx = 0, ny = 0;
    if (hasCursor) {
      const cx = win.w / 2;
      const cy = win.h / 2;
      nx = clamp((gc.x - wp.x - cx) / cx, -1, 1);
      ny = clamp((gc.y - wp.y - cy) / cy, -1, 1);
    }

    return config.value.layers.map((layer, _i) => {
      const style: Record<string, string> = {};

      if (!layer.enabled) {
        style.display = "none";
        return style;
      }

      // ── 位置：直接映射，无惯性 ──
      const s = layer.sensitivity * intensity;
      // ★ maxTravel 按窗口宽度等比缩放
      const maxTravel = s * 40 * (win.w / (userConfig.popupSize.w || 730));
      // ★ offset 兜底：整数=旧像素，当场转百分比（兼容所有未迁移数据）
      let ox = layer.offsetX;
      let oy = layer.offsetY;
      if (ox !== 0 && Number.isInteger(ox)) ox = +(ox / (win.w || 730) * 100).toFixed(2);
      if (oy !== 0 && Number.isInteger(oy)) oy = +(oy / (win.h || 450) * 100).toFixed(2);
      const px = (hasCursor ? nx * maxTravel : 0);
      const py = (hasCursor ? ny * maxTravel : 0);
      // scale：层自定义缩放 × 深度缩放（越外层越小）
      const depth = layerDepth(layer.sensitivity, intensity);
      const depthScale = lerp(1.02, 0.98, depth);
      const finalScale = (layer.scale ?? 1.0) * depthScale;
      style.transform = `translate(calc(${ox}% + ${px.toFixed(1)}px), calc(${oy}% + ${py.toFixed(1)}px)) scale(${finalScale.toFixed(3)})`;

      // ── 滤镜：drop-shadow + brightness + contrast + saturate ──
      const so = depth * 10;
      const sb = depth * 7;
      const sa = (0.12 + depth * 0.08).toFixed(2);
      const parts: string[] = [];
      parts.push(`drop-shadow(0 ${so.toFixed(1)}px ${sb.toFixed(1)}px rgba(0,0,0,${sa}))`);
      parts.push(`brightness(${layer.brightness.toFixed(2)})`);
      parts.push(`contrast(${layer.contrast.toFixed(2)})`);
      parts.push(`saturate(${layer.saturate.toFixed(2)})`);
      style.filter = parts.join(" ");

      return style;
    });
  });

  return { layerStyles };
}
