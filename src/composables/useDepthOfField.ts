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
 * 景深样式。
 *
 * 背景层放大 `blurScale` —— CSS blur 会采样到图像边界之外的透明区，
 * 不放大就会在四周出现一圈发虚的底。
 */
export function useDepthOfField(config: Ref<DofState>) {
  const hasImage = computed(() => config.value.url !== "")

  const backgroundStyle = computed<Record<string, string>>(() => {
    const c = config.value
    return {
      filter: [
        `blur(${c.blur.toFixed(1)}px)`,
        `brightness(${c.brightness.toFixed(2)})`,
        `contrast(${c.contrast.toFixed(2)})`,
        `saturate(${c.saturate.toFixed(2)})`,
      ].join(" "),
      transform: `scale(${c.blurScale.toFixed(3)})`,
    }
  })

  const foregroundStyle = computed<Record<string, string>>(() => {
    const style: Record<string, string> = {}
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
