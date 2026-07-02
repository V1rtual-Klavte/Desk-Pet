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
  const bodyUrl = profile ? `${profile.basePath}/body.png` : "/profiles/sugar-pink/body.png";
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

// ══════════════════════════════════════════
// 向后兼容：复用旧 API，内部走 Profile
// ══════════════════════════════════════════

/** @deprecated 使用 getAnimations() 代替，由 Profile 驱动 */
export const animations = new Proxy({} as Record<string, Animation>, {
  get(_target, prop: string) {
    if (prop === "then") return undefined; // Vue 响应式探测
    return getAnimations()[prop] || null;
  },
  ownKeys() {
    return Reflect.ownKeys(getAnimations());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const val = getAnimations()[prop as string];
    if (val) return { enumerable: true, configurable: true, value: val };
    return undefined;
  },
});
