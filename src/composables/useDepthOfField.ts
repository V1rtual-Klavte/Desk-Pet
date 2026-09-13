// ==========================================
// useDepthOfField — 单张素材的景深效果
//
// 同一张图渲染两次：
//   底层 整体模糊 + 轻微压暗（背景）
//   上层 同一张图，被焦点区遮罩裁出，保持锐利（主体）
//
// 遮罩用 radial-gradient 做椭圆焦点区，边缘按 feather 羽化 ——
// 一行 CSS，不需要 canvas，也不需要预先抠图。
// ==========================================

import { computed, type Ref } from "vue"
import type { ProfileDepthOfField, ProfileDofRegion } from "@/services/profile"

export interface DofState extends ProfileDepthOfField {
  /** 素材的最终 URL；空串表示尚未配置 */
  url: string
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 生成焦点区遮罩。
 *
 * 多个区域时用逗号分隔的多层 radial-gradient 叠加 —— 任一层不透明即保留锐利，
 * 所以用 `mask-composite: add`（默认行为）就能得到并集。
 * 没有区域时返回 undefined，表示整张图统一模糊。
 */
export function buildFocusMask(regions: ProfileDofRegion[]): string | undefined {
  if (regions.length === 0) return undefined

  const layers = regions.map((r) => {
    const feather = clamp(r.feather, 0, 1)
    // 颜色停靠点：feather 之前全不透明，到边缘刚好透明 —— 这就是羽化。
    const solid = ((1 - feather) * 100).toFixed(1)
    return `radial-gradient(ellipse ${r.rx}% ${r.ry}% at ${r.x}% ${r.y}%, #000 0%, #000 ${solid}%, transparent 100%)`
  })

  return layers.join(", ")
}

/**
 * 模糊层额外放大的比例。
 *
 * CSS `blur()` 会采样到图像边界之外的透明区，不放大就会在四周透出一圈发虚的底。
 * 这是技术补偿，不是给用户调的参数，所以做成常量而不进配置。
 */
const BLUR_EDGE_MARGIN = 1.05

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
 * 景深样式。
 *
 * `scale` + `offsetX/Y` 是用户控制的取景：图与画布尺寸不合时缩放、平移，
 * 超出画布的部分由舞台的 `overflow: hidden` 裁掉。两层必须用同一组取景参数
 * 才能对齐，模糊层在其之上再乘一个技术补偿系数。
 */
export function useDepthOfField(config: Ref<DofState>) {
  const hasImage = computed(() => config.value.url !== "")

  /** 取景变换。两层共用，blur 层额外乘边缘补偿。 */
  function framing(margin: number): string {
    const c = config.value
    return `translate(${c.offsetX.toFixed(2)}%, ${c.offsetY.toFixed(2)}%) scale(${(c.scale * margin).toFixed(3)})`
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
      transform: framing(BLUR_EDGE_MARGIN),
    }
  })

  const foregroundStyle = computed<Record<string, string>>(() => {
    const style: Record<string, string> = { transform: framing(1) }
    const mask = buildFocusMask(config.value.focus)
    if (mask) {
      style.maskImage = mask
      style.WebkitMaskImage = mask
    } else {
      // 没有焦点区 = 整张图统一模糊，锐利副本不参与渲染。
      style.display = "none"
    }
    return style
  })

  return { hasImage, backgroundStyle, foregroundStyle }
}
