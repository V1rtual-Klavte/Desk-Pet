<script setup lang="ts">
// ==========================================
// StreamView — 角色展示
//
// 两种效果互斥，由 CONFIG 的 appearance.effectMode 决定：
//   parallax — 五层灵动图层，层 DOM 始终渲染，display 由 layerStyles 控制
//   dof      — 单张素材景深，同图渲染两次（底层模糊 + 焦点区锐利）
// ==========================================

import { ref, computed, onMounted, onUnmounted, inject, type Ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { activateProfile, ensureProfileLoaded, getCharacterScaleMode, getActiveProfile, invalidateProfileCache, refreshProfileAssets, resolveProfileAssetUrl } from "@/services/profile";
import { useParallax, DEFAULT_PARALLAX_STATE, type ParallaxState } from "@/composables/useParallax";
import { useDepthOfField, type DofState } from "@/composables/useDepthOfField";
import { appearanceConfig, userConfig, reloadConfig, type EffectMode } from "@/services/config";
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

// ── 效果模式（由 reloadEffects() 从 CONFIG 同步，settings-saved 时刷新）──
const effectMode = ref<EffectMode>(userConfig.effectMode);

// ── 景深配置 ──
const dofConfig = ref<DofState>({
  image: "", url: "",
  blur: 8, scale: 1.0, offsetX: 0, offsetY: 0,
  brightness: 0.95, contrast: 1.0, saturate: 0.9,
  focus: [],
});
const { hasImage: dofHasImage, backgroundStyle: dofBgStyle, foregroundStyle: dofFgStyle } =
  useDepthOfField(dofConfig);

// ── 灵动图层配置 ──
const parallaxConfig = ref<ParallaxState>({
  enabled: true,
  intensity: userConfig.parallaxIntensity,
  // 初值留空：DEFAULT_PARALLAX_STATE 是 sugar-pink 的层，Profile 一就绪就会被拿去
  // 解析当前 Profile 的素材目录（yuki 没有 shield_gold.png），必然 404 一次。
  // 交给 reloadParallax() 填入当前 Profile 的层再渲染。
  layers: [],
});

// ── 图层素材 URL（activeProfileRevision 让 Profile 切换触发重新计算）──
const layerUrls = computed<(string | null)[]>(() => {
  const p = getActiveProfile();
  log.info(`layerUrls 求值: profile=${p ? p.id : "null"}, layersLen=${parallaxConfig.value.layers.length}`);
  if (!p) return [null, null, null, null, null];
  const result = parallaxConfig.value.layers.map((l) => {
    if (!l.image) return null;
    return resolveProfileAssetUrl(p, l.image);
  });
  log.info(`  → ${result.map((u, i) => `L${i}:${u ? u.split("/").pop() : "null"}`).join(" | ")}`);
  return result;
});

// ── 引擎（computed 直接响应光标变化）──
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

function reloadEffects() {
  const p = getActiveProfile();
  if (!p) {
    // Profile 尚未加载（冷启动时序：StreamView onMounted 早于 App initProfiles）。
    // 延迟重试兜底；正常切换由 deskpet-profile-updated 事件完成同步。
    if (!_reloadRetryId) {
      _reloadRetryId = setTimeout(() => {
        _reloadRetryId = null;
        reloadEffects();
      }, 500);
      log.info("Profile 未就绪，500ms 后重试效果加载...");
    }
    return;
  }

  effectMode.value = userConfig.effectMode;
  parallaxConfig.value.intensity = userConfig.parallaxIntensity;

  // 景深与灵动图层共用同一份素材目录，各自取自己的字段。
  const d = p.theme.depthOfField;
  dofConfig.value = { ...d, url: d.image ? resolveProfileAssetUrl(p, d.image) : "" };

  const pLayers = p.theme.parallax.layers;
  const newLayers: typeof parallaxConfig.value.layers = [];
  for (let i = 0; i < 5; i++) {
    const pLayer = pLayers?.[i];
    const merged = pLayer
      ? { ...DEFAULT_PARALLAX_STATE.layers[i], ...pLayer }
      : { ...DEFAULT_PARALLAX_STATE.layers[i] };

    // 向后兼容：整数=旧像素 → 百分比（拖拽产生小数，默认 0 不动）。
    if (merged.offsetX !== 0 && Number.isInteger(merged.offsetX)) {
      const oldOX = merged.offsetX;
      merged.offsetX = +(merged.offsetX / (userConfig.popupSize.w || 730) * 100).toFixed(2);
      log.debug("offset迁移 L" + i + ": " + oldOX + "px → " + merged.offsetX + "%");
    }
    if (merged.offsetY !== 0 && Number.isInteger(merged.offsetY)) {
      const oldOY = merged.offsetY;
      merged.offsetY = +(merged.offsetY / (userConfig.popupSize.h || 450) * 100).toFixed(2);
      log.debug("offset迁移 L" + i + " Y: " + oldOY + "px → " + merged.offsetY + "%");
    }

    newLayers.push(merged);
  }
  // 不再强制开启 L2：所有图层都由用户配置决定显隐（图层编辑器已解除 L2 限制）
  // ★ 替换整个数组引用，强制触发 Vue computed 重新求值
  parallaxConfig.value.layers = newLayers;

  // ★ 加载完成后打印各层状态，便于调试
  log.info("图层已加载: " + parallaxConfig.value.layers.map((l, i) =>
    `L${i}: ${l.enabled ? l.image : '(disabled)'}`).join(" | "));
}

let unlistenProfileUpdated: UnlistenFn | null = null;
let unlistenSettingsSaved: UnlistenFn | null = null;

async function syncActiveProfile(profileId?: string) {
  await reloadConfig();
  const id = profileId || appearanceConfig.activeProfile;
  invalidateProfileCache(id);
  const profile = await ensureProfileLoaded(id);
  if (!profile || !activateProfile(id)) {
    log.warn(`Profile 同步失败: ${id}`);
    return;
  }
  await refreshProfileAssets(id);
  reloadEffects();
}

onMounted(async () => {
  reloadEffects();
  unlistenProfileUpdated = await listen<{ profileId?: string }>("deskpet-profile-updated", async ({ payload }) => {
    await syncActiveProfile(payload?.profileId);
  })
  // 效果模式是 CONFIG 字段，设置页保存后重新读一次就能即时切换，不必重启。
  unlistenSettingsSaved = await listen("deskpet-settings-saved", async () => {
    await reloadConfig();
    reloadEffects();
  })
});
onUnmounted(() => {
  unlistenProfileUpdated?.();
  unlistenSettingsSaved?.();
  if (_reloadRetryId) clearTimeout(_reloadRetryId);
});

</script>

<template>
  <div id="parallax-stage" :style="{ aspectRatio: userConfig.popupSize.w + '/' + userConfig.popupSize.h }">
    <!-- 灵动图层：五层始终渲染，display 由 layerStyles 控制 -->
    <template v-if="effectMode === 'parallax'">
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
    </template>

    <!-- 景深：同一张图两次 —— 底层整体模糊，上层被焦点区遮罩裁出保持锐利 -->
    <template v-else-if="effectMode === 'dof' && dofHasImage">
      <img
        class="dof-layer dof-bg"
        :src="dofConfig.url"
        :style="{ ...dofBgStyle, imageRendering: scaleMode }"
        alt="" draggable="false"
        @error="onImgError"
      />
      <img
        class="dof-layer dof-fg"
        :src="dofConfig.url"
        :style="{ ...dofFgStyle, imageRendering: scaleMode }"
        alt="" draggable="false"
        @load="onImgLoad"
      />
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

/* 景深：两层同图上下叠放，上层靠 mask 裁出焦点区 */
.dof-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.dof-bg { z-index: 0; }
.dof-fg { z-index: 1; }
</style>
