<script setup lang="ts">
// ==========================================
// StreamView v5 — 五层灵动图层（直接映射）
// Layer DOM 始终渲染，display 由 layerStyles 控制
// ==========================================

import { ref, computed, onMounted, onUnmounted, inject, type Ref } from "vue";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { getCharacterScaleMode, getActiveProfile } from "@/services/profile";
import { useParallax, DEFAULT_PARALLAX_STATE, type ParallaxState } from "@/composables/useParallax";
import { userConfig } from "@/services/config";
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

// ── 灵动图层配置 ──
const parallaxConfig = ref<ParallaxState>({
  enabled: userConfig.parallaxEnabled,
  intensity: userConfig.parallaxIntensity,
  layers: userConfig.parallaxLayers.map(l => ({ ...l })),
});

// ── 图层素材 URL（直接调 getActiveProfile()，不用 computed 包装避免死 computed）──
const layerUrls = computed<(string | null)[]>(() => {
  const p = getActiveProfile();
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
  const p = getActiveProfile();
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

  parallaxConfig.value.enabled = userConfig.parallaxEnabled;
  parallaxConfig.value.intensity = userConfig.parallaxIntensity;

  let uLayers: any[] | null = null;
  try {
    const raw = localStorage.getItem("deskpet_parallax_layers");
    if (raw) uLayers = JSON.parse(raw);
  } catch {}
  if (!uLayers) uLayers = userConfig.parallaxLayers;

  const pLayers = p.theme.parallax.layers;
  const newLayers: typeof parallaxConfig.value.layers = [];
  for (let i = 0; i < 5; i++) {
    const pLayer = pLayers?.[i];
    const base = pLayer
      ? { ...DEFAULT_PARALLAX_STATE.layers[i], ...pLayer }
      : { ...DEFAULT_PARALLAX_STATE.layers[i] };
    const uLayer = uLayers?.[i];
    // 用户覆盖优先，但过滤旧路径
    const merged = uLayer ? { ...base, ...uLayer } : { ...base };
    if (merged.image && (merged.image.includes("ui/") || merged.image === "body.png")) {
      merged.image = base.image;
    }
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

// ── 图层编辑器快速入口 ──
async function openLayerEditor() {
  try {
    const existing = await WebviewWindow.getByLabel("layer-editor");
    if (existing) { await existing.setFocus(); return; }
  } catch { /* ignore */ }
  const win = new WebviewWindow("layer-editor", {
    url: "layer-editor.html",
    title: "图层编辑器 - 糖糖桌宠",
    width: 820,
    height: 580,
    resizable: true,
    decorations: true,
    alwaysOnTop: true,
  });
  // 确保层级 + 聚焦
  setTimeout(async () => {
    try { await win.setAlwaysOnTop(true); } catch {}
    try { await win.setFocus(); } catch {}
    invoke("enhance_layer_editor_window").catch(() => {});
  }, 300);
}
</script>

<template>
  <div id="parallax-stage">
    <button class="layer-edit-btn" @click="openLayerEditor" title="编辑五层图层">🎨</button>

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
  position: relative;
  overflow: hidden;
  z-index: 1;
}
.layer-edit-btn {
  position: absolute;
  top: 6px; right: 6px;
  z-index: 100;
  padding: 2px 7px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.35);
  color: rgba(255,255,255,0.5);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  line-height: 1;
}
.layer-edit-btn:hover {
  background: rgba(196,39,111,0.25);
  border-color: rgba(196,39,111,0.4);
  color: #f0a0c0;
}
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
