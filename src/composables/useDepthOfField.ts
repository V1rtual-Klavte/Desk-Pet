// ==========================================
// useDepthOfField — 单张素材的景深 + 视差
//
// 同一张图渲染两次：
//   底层 整体模糊 + 轻微压暗（背景），跟着光标动得**少**
//   上层 同一张图，被焦点区遮罩裁出，保持锐利（主体），跟着光标动得**多**
//
// 两层的速度差就是深度的来源 —— 只做模糊不做位移是张静态图，
// 看起来只是「糊了一片」，没有 iOS 透视壁纸那种立体感。
//
// 遮罩用 radial-gradient 做椭圆焦点区，一行 CSS，
// 不需要 canvas，也不需要预先抠图。
// ==========================================

import { computed, type Ref } from "vue"
import type { ProfileDepthOfField, ProfileDofRegion } from "@/services/profile"

/** 与 useParallax 一致的位移基准：灵敏度 1 在 730px 宽窗口下最多移动 40px */
const TRAVEL_BASE_PX = 40
const REFERENCE_WIN_WIDTH = 730

export interface DofState extends ProfileDepthOfField {
  /** 素材的最终 URL；空串表示尚未配置 */
  url: string
}

/** 光标本与窗口位置，交给 useDepthOfField 计算两层各自的位移 */
export interface DofViewport {
  cursor: Ref<{ x: number; y: number } | null>
  windowPos: Ref<{ x: number; y: number } | null>
  windowSize: Ref<{ w: number; h: number }>
  isVisible: Ref<boolean>
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 单个焦点区的遮罩。
 *
 * 每个焦点区是一个**独立的层**，所以遮罩只描述自己那一个椭圆，不是并集 ——
 * 否则它们只能一起移动，做不出分层级。
 */
export function buildFocusMask(region: ProfileDofRegion): string {
  const feather = clamp(region.feather, 0, 1)
  const solid = ((1 - feather) * 100).toFixed(1)
  return `radial-gradient(ellipse ${region.rx}% ${region.ry}% at ${region.x}% ${region.y}%, #000 0%, #000 ${solid}%, transparent 100%)`
}

/**
 * 素材坐标(%) → 画布坐标(%)。
 *
 * 素材被以画布中心为原点缩放并平移，焦点椭圆活在**素材坐标系**里（这样缩放后
 * 仍然贴着主体），而拖拽发生在画布坐标系里，两边必须显式换算，否则缩放之后
 * 看到的圈和实际清晰区就对不上了。
 */
export function imageToCanvas(v: number, offset: number, scale: number): number {
  return 50 + (v - 50) * scale + offset
}

/** 画布坐标(%) → 素材坐标(%)，imageToCanvas 的逆运算 */
export function canvasToImage(v: number, offset: number, scale: number): number {
  const s = scale || 1
  return 50 + (v - offset - 50) / s
}

/**
 * 模糊层额外放大的比例。
 *
 * CSS `blur()` 会采样到图像边界之外的透明区，不放大就会在四周透出一圈发虚的底。
 * 这是技术补偿，不是给用户调的参数，所以做成常量而不进配置。
 */
const BLUR_EDGE_MARGIN = 1.05

/**
 * 景深样式与视差位移。
 *
 * `scale` + `offsetX/Y` 是用户控制的取景：图与画布尺寸不合时缩放、平移，
 * 超出画布的部分由舞台的 `overflow: hidden` 裁掉。两层共用同一组取景参数，
 * 在此之上各自叠加自己的视差位移。
 */
export function useDepthOfField(config: Ref<DofState>, viewport: DofViewport) {
  const hasImage = computed(() => config.value.url !== "")

  /** 光标相对窗口中心的归一化位置，±1 */
  const norm = computed<{ x: number; y: number }>(() => {
    const gc = viewport.cursor.value
    const wp = viewport.windowPos.value
    const win = viewport.windowSize.value
    if (!viewport.isVisible.value || !gc || !wp || win.w <= 0 || win.h <= 0) return { x: 0, y: 0 }
    const halfW = win.w / 2
    const halfH = win.h / 2
    return {
      x: clamp((gc.x - wp.x - halfW) / halfW, -1, 1),
      y: clamp((gc.y - wp.y - halfH) / halfH, -1, 1),
    }
  })

  /** 某层在给定灵敏度下的位移（px） */
  function travel(sensitivity: number): { x: number; y: number } {
    const win = viewport.windowSize.value
    const max = sensitivity * TRAVEL_BASE_PX * (win.w / REFERENCE_WIN_WIDTH)
    return { x: norm.value.x * max, y: norm.value.y * max }
  }

  /** 背景层位移 */
  const backgroundTravel = computed(() => travel(config.value.bgSensitivity))

  /**
   * 取景变换 + 视差位移。两层共用取景，位移各算各的。
   *
   * 取景是百分比、位移是像素，必须用 calc 分开相加 —— 直接相加会把 px 当 % 用。
   */
  function transform(motion: { x: number; y: number }, margin: number): string {
    const c = config.value
    return [
      `translate(calc(${c.offsetX.toFixed(2)}% + ${motion.x.toFixed(1)}px), ` +
      `calc(${c.offsetY.toFixed(2)}% + ${motion.y.toFixed(1)}px))`,
      `scale(${(c.scale * margin).toFixed(3)})`,
    ].join(" ")
  }

  const backgroundStyle = computed<Record<string, string>>(() => {
    const c = config.value
    return {
      filter: [
        `blur(${c.blur.toFixed(1)}px)`,
        `brightness(${c.brightness.toFixed(2)})`,
        `contrast(${c.contrast.toFixed(2)})`,
        `saturate(${c.saturate.toFixed(2)})`,
      ].join(" "),
      transform: transform(backgroundTravel.value, BLUR_EDGE_MARGIN),
    }
  })

  /**
   * 焦点层列表：每个焦点区一张同图副本，各自遮罩 + 各自灵敏度。
   *
   * 分开成独立层才能「分层级」—— 近处焦点区动得多、远处动得少；
   * 合成在一起的话它们只能同进同退。
   */
  const focusLayers = computed(() =>
    config.value.focus.map((r) => {
      const motion = travel(r.sensitivity)
      return {
        style: {
          transform: transform(motion, 1),
          maskImage: buildFocusMask(r),
          WebkitMaskImage: buildFocusMask(r),
        } as Record<string, string>,
        /** 编辑器的焦点圈要跟着这一层对齐 */
        travel: motion,
      }
    }),
  )

  return { hasImage, backgroundStyle, focusLayers }
}
