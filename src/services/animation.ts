// ==========================================
// 动画系统 v2 — 从 Profile 加载
// ==========================================
import { getActiveProfile } from "@/services/profile";

// 动画类型定义
export interface Frame {
  src: string;
  duration: number; // 显示时长（毫秒）
}

export interface Animation {
  frames: Frame[];
  loop: boolean;
}

/**
 * 从当前激活的 Profile 获取所有动画定义。
 * 路径已解析为完整 URL（相对于 public/）。
 */
export function getAnimations(): Record<string, Animation> {
  const profile = getActiveProfile();
  if (!profile || Object.keys(profile.animations).length === 0) {
    return getFallbackAnimations();
  }

  const result: Record<string, Animation> = {};
  for (const [name, def] of Object.entries(profile.animations)) {
    result[name] = {
      loop: def.loop,
      frames: def.frames.map(f => ({
        src: f.f,
        duration: f.d,
      })),
    };
  }
  return result;
}

/**
 * Profile 未加载时的最小 fallback — 使用当前激活 profile 的 body.png
 */
function getFallbackAnimations(): Record<string, Animation> {
  const profile = getActiveProfile();
  const bodyUrl = profile ? `${profile.basePath}/materials/L2/body.png` : "/profiles/sugar-pink/materials/L2/body.png";
  return {
    idle: {
      frames: [{ src: bodyUrl, duration: 3000 }],
      loop: true,
    },
  };
}

/**
 * 获取单个动画定义
 */
export function getAnimation(name: string): Animation | null {
  return getAnimations()[name] || null;
}

