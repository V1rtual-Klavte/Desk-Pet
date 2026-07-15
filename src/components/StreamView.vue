<script setup lang="ts">
// ==========================================
// StreamView v5 — 五层灵动图层（直接映射）
// Layer DOM 始终渲染，display 由 layerStyles 控制
// ==========================================

import { ref, computed, onMounted, onUnmounted, inject, type Ref } from "vue";
import { getCharacterScaleMode, getActiveProfile } from "@/services/profile";
import { useParallax, DEFAULT_PARALLAX_STATE, type ParallaxState } from "@/composables/useParallax";
import { userConfig, refreshUserCache } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("Stream");

// ── 注入（App.vue 提供）──
const globalCursor = inject<Ref<{ x: number; y: number } | null>>("globalCursor", ref(null));
const windowPos = inject<Ref<{ x: number; y: number } | null>>("windowPos", ref(null));
const windowSize = inject<Ref<{ w: number; h: number }>>("windowSize", ref({ w: 730, h: 450 }));
const isRetracted = inject<Ref<boolean>>("isRetracted", ref(false));
const isVisible = computed(() => !isRetracted.value);

// ── Profile ──
const scaleMode = computed(() => getCharacterScaleMode() === "smooth" ? "auto" : "pixelated");
	const activeProfile = computed(() => getActiveProfile())

// ── 灵动图层配置 ──
const parallaxConfig = ref<ParallaxState>({
  enabled: userConfig.parallaxEnabled,
  intensity: userConfig.parallaxIntensity,
  layers: userConfig.parallaxLayers.map(l => ({ ...l })),
});

// ── 图层素材 URL（直接调 getActiveProfile()，不用 computed 包装避免死 computed）──
const layerUrls = computed<(string | null)[]>(() => {
  const p = activeProfile.value;
  log.info(`layerUrls 求值: profile=${p ? p.id : "null"}, layersLen=${parallaxConfig.value.layers.length}`);
  if (!p) return [null, null, null, null, null];
  const result = parallaxConfig.value.layers.map((l) => {
    if (!l.image) return null;
    return `${p.basePath}/${l.image}`;
  });
  log.info(`  → ${result.map((u, i) => `L${i}:${u ? u.split("/").pop() : "null"}`).join(" | ")}`);
  return result;
});

// ── 引擎（v2: computed 直接响应光标变化）──
const { layerStyles } = useParallax(globalCursor, windowPos, windowSize, parallaxConfig, isVisible);

// ── 图片加载调试 ──
function onImgError(e: Event) {
  const img = e.target as HTMLImageElement;
  log.warn(`图片加载失败: ${img.src}`);
  img.style.opacity = "0";
}
function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  log.debug(`图片加载成功: ${img.src.split("/").pop()}`);
}

// ── ☆ 图层重载：启动时 + 定期检查 dirty flag ──
let _reloadRetryId: ReturnType<typeof setTimeout> | null = null;

function reloadParallax() {
  const p = activeProfile.value;
  if (!p) {
    // Profile 尚未加载（冷启动时序：StreamView onMounted 早于 App initProfiles）
    // 延迟重试，同时依赖 activateProfile 的 dirty flag 触发
    if (!_reloadRetryId) {
      _reloadRetryId = setTimeout(() => {
        _reloadRetryId = null;
        reloadParallax();
      }, 500);
      log.info("Profile 未就绪，500ms 后重试图层加载...");
    }
    return;
  }

  refreshUserCache();
  parallaxConfig.value.enabled = userConfig.parallaxEnabled;
  parallaxConfig.value.intensity = userConfig.parallaxIntensity;

  let uLayers: any[] | null = null;
  // ★ 优先读 userConfig（持久化在 deskpet_user_settings），旧 key 为兼容回退
  uLayers = userConfig.parallaxLayers;
  if (!uLayers || uLayers.length === 0) {
    try {
      const raw = localStorage.getItem("deskpet_parallax_layers");
      if (raw) uLayers = JSON.parse(raw);
    } catch {}
  }

  const pLayers = p.theme.parallax.layers;
  const newLayers: typeof parallaxConfig.value.layers = [];
  for (let i = 0; i < 5; i++) {
    const pLayer = pLayers?.[i];
    const base = pLayer
      ? { ...DEFAULT_PARALLAX_STATE.layers[i], ...pLayer }
      : { ...DEFAULT_PARALLAX_STATE.layers[i] };
    const uLayer = uLayers?.[i];
        // 用户覆盖优先，向后兼容旧扁平路径 → 新 L{i}/ 结构
        const merged = uLayer ? { ...base, ...uLayer } : { ...base };
        if (merged.image && !merged.image.includes("/L") && merged.image.startsWith("materials/")) {
          const filename = merged.image.split("/").pop() || "";
          const LAYER_MIGRATION: Record<string, string> = { "bg_base.png": "L0", "body.png": "L2", "shield_gold.png": "L4" };
          if (filename && LAYER_MIGRATION[filename]) {
            merged.image = `materials/${LAYER_MIGRATION[filename]}/${filename}`;
          } else {
            merged.image = base.image;
          }
        }
        // ★ 向后兼容：整数=旧像素 → 百分比（拖拽产生小数，默认0不动）
        if (merged.offsetX !== 0 && Number.isInteger(merged.offsetX)) { const oldOX = merged.offsetX; merged.offsetX = +(merged.offsetX / (userConfig.popupSize.w || 730) * 100).toFixed(2); console.log("[StreamView] offset迁移 L"+i+": "+oldOX+"px → "+merged.offsetX+"%"); }
        if (merged.offsetY !== 0 && Number.isInteger(merged.offsetY)) { const oldOY = merged.offsetY; merged.offsetY = +(merged.offsetY / (userConfig.popupSize.h || 450) * 100).toFixed(2); console.log("[StreamView] offset迁移 L"+i+" Y: "+oldOY+"px → "+merged.offsetY+"%"); }

    newLayers.push(merged);
  }
  newLayers[2].enabled = true;
  // ★ 替换整个数组引用，强制触发 Vue computed 重新求值
  parallaxConfig.value.layers = newLayers;

  // ★ 加载完成后打印各层状态，便于调试
  log.info("图层已加载: " + parallaxConfig.value.layers.map((l, i) =>
    `L${i}: ${l.enabled ? l.image : '(disabled)'}`).join(" | "));
}

let pollId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  reloadParallax();
  pollId = setInterval(() => {
    if (localStorage.getItem("deskpet_parallax_dirty") === "1") {
      localStorage.removeItem("deskpet_parallax_dirty");
      reloadParallax();
    }
  }, 200);
});
onUnmounted(() => {
  if (pollId) clearInterval(pollId);
  if (_reloadRetryId) clearTimeout(_reloadRetryId);
});

</script>

<template>
  <div id="parallax-stage" :style="{ aspectRatio: userConfig.popupSize.w + '/' + userConfig.popupSize.h }">
    <!-- 五层始终渲染，display 由 layerStyles 控制 -->
    <template v-for="i in 5" :key="i">
      <div
        class="pl-layer"
        :class="`pl-layer-${i - 1}`"
        :style="layerStyles[i - 1]"
      >
        <img
          v-if="layerUrls[i - 1]"
          :src="layerUrls[i - 1]!"
          alt="" draggable="false"
          :style="{ imageRendering: scaleMode, width: '100%', height: '100%', objectFit: 'contain' }"
          @load="onImgLoad"
          @error="onImgError"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
#parallax-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  position: relative;
  overflow: hidden;
  z-index: 1;
}
/* ★ aspect-ratio 由 JS 动态绑定 :style 注入，锁定与编辑器一致的宽高比 */

.pl-layer {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  inset: 0;
  pointer-events: none;
  will-change: transform;
}
.pl-layer-0 { z-index: 0; }
.pl-layer-1 { z-index: 1; }
.pl-layer-2 { z-index: 2; }
.pl-layer-3 { z-index: 3; }
.pl-layer-4 { z-index: 4; }
</style>
