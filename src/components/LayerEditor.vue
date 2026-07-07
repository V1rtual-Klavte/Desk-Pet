<script setup lang="ts">
// ==========================================
// LayerEditor v5 — WYSIWYG 五层编辑器
// 逻辑已提取至 useLayerEditor composable
// ==========================================

import { useLayerEditor } from "@/composables/useLayerEditor";

const {
  fileInput,
  layers,
  selectedIndex,
  ready,
  profile,
  canvasSize,
  canvasWrap,
  canvasEl,
  actualWinSize,
  dragHint,
  saved,
  uploading,
  showPicker,
  assetList,
  assetLoading,
  pickerPreview,
  selectedLayer,
  isL2,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  toggleLock,
  toggleEnabled,
  resetLayer,
  resetPosition,
  save,
  closeWindow,
  uploadImage,
  onFileSelected,
  removeImage,
  openPicker,
  previewAsset,
  selectAsset,
  closePicker,
  onImgLoad,
  onImgError,
  layerDepth,
  userConfig,
} = useLayerEditor();
</script>

<template>
  <div id="le-root">
    <!-- 隐藏文件选择器（必须存在于DOM中，Tauri WebView 才能正常弹出）-->
    <input ref="fileInput" type="file" accept="image/png,image/jpg,image/jpeg,image/gif,image/webp" style="display:none" @change="onFileSelected" />
    <!-- 工具栏 -->
    <div id="le-toolbar">
      <div class="le-tabs">
        <button v-for="(l, i) in layers" :key="i" class="le-tab"
          :class="{ active: selectedIndex === i, disabled: !l.config.enabled, locked: l.config.locked }"
          @click="selectedIndex = i">
          <span class="le-dot" :class="`ldot-${i}`"></span>
          <span class="le-tab-name">{{ l.name }}</span>
          <span v-if="l.config.locked" class="le-tag">🔒</span>
          <span v-else-if="!l.config.enabled" class="le-tag off">关</span>
          <span v-if="l.loadFailed" class="le-tag err">⚠</span>
        </button>
      </div>
      <div class="le-actions">
        <button class="le-btn" @click="toggleLock()" :title="selectedLayer.config.locked?'解锁':'锁定'">
          {{ selectedLayer.config.locked ? '🔒 已锁' : '🔓 解锁' }}
        </button>
        <button class="le-btn" @click="toggleEnabled()" :disabled="isL2">
          {{ selectedLayer.config.enabled ? '👁 可见' : '🚫 隐藏' }}
        </button>
        <button class="le-btn le-btn-d" @click="resetLayer()">↺ 重置</button>
        <span class="le-spacer"></span>
        <span v-if="saved" class="le-saved">✅ 已保存</span>
        <button class="le-btn le-btn-primary" @click="save()">💾 保存</button>
        <button class="le-btn le-btn-d" @click="closeWindow()">✕ 关闭</button>
      </div>
    </div>

    <!-- 主体 -->
    <div id="le-body">
      <!-- ── WYSIWYG 预览画布 ── -->
      <div id="le-canvas-wrap">
        <div id="le-canvas" ref="canvasEl"
          :style="{ width: canvasSize.w + 'px', height: canvasSize.h + 'px' }"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel.prevent="onWheel"
        >
          <div class="le-grid-h" style="top:50%"></div>
          <div class="le-grid-v" style="left:50%"></div>

          <!-- 窗口边框指示 -->
          <div class="le-win-border">
            <span class="le-win-label">{{ actualWinSize.w }} × {{ actualWinSize.h }}</span>
          </div>

          <div v-if="!ready" class="le-loading">加载中...</div>

          <!-- ★ 全部五层始终渲染 ★ -->
          <template v-for="(l, i) in layers" :key="i">
            <div
              v-if="ready"
              class="le-preview-layer"
              :class="{ selected: selectedIndex === i, locked: l.config.locked }"
              :style="{
                zIndex: i,
                transform: `translate(${(l.config.offsetX / 100 * canvasSize.w).toFixed(1)}px, ${(l.config.offsetY / 100 * canvasSize.h).toFixed(1)}px) scale(${((l.config.scale ?? 1) * (1.02 - layerDepth(l.config.sensitivity, userConfig.parallaxIntensity) * 0.04)).toFixed(3)})`,
                opacity: selectedIndex === i ? 1 : l.config.enabled ? 0.6 : 0.15,
              }"
              @pointerdown.prevent="onPointerDown(i, $event)"
            >
              <img
                v-if="l.url && !l.loadFailed"
                :src="l.url"
                alt="" draggable="false"
                class="le-layer-img"
                :style="{
                  filter: `brightness(${l.config.brightness.toFixed(2)}) contrast(${l.config.contrast.toFixed(2)}) saturate(${l.config.saturate.toFixed(2)}) drop-shadow(0 ${(layerDepth(l.config.sensitivity, userConfig.parallaxIntensity) * 10).toFixed(1)}px ${(layerDepth(l.config.sensitivity, userConfig.parallaxIntensity) * 7).toFixed(1)}px rgba(0,0,0,${(0.12 + layerDepth(l.config.sensitivity, userConfig.parallaxIntensity) * 0.08).toFixed(2)}))`,
                }"
                @load="onImgLoad(i)"
                @error="(e: Event) => onImgError(i, e)"
              />
              <span v-else class="le-no-img">
                {{ l.loadFailed ? '⚠' : i === 2 ? '🎯' : '' }}
              </span>
            </div>
          </template>

          <div v-if="dragHint" class="le-drag-hint">{{ dragHint }}</div>
        </div>
      </div>

      <!-- 属性面板 -->
      <div id="le-panel">
        <div class="le-panel-head">
          <span class="le-dot" :class="`ldot-${selectedIndex}`"></span>
          <span class="le-panel-title">{{ selectedLayer.name }}</span>
          <span v-if="selectedLayer.config.locked" class="le-tag">🔒</span>
          <span v-if="selectedLayer.loadFailed" class="le-tag err">⚠ 素材缺失</span>
        </div>

        <!-- 素材管理 — 所有层通用 -->
        <div class="le-prop-section">
          <div class="le-prop-row">
            <span class="le-prop-label">素材</span>
            <span class="le-prop-val" :class="{ empty: !selectedLayer.config.image }">
              {{ selectedLayer.config.image || '未设置' }}
            </span>
          </div>
          <div class="le-prop-row" style="gap:3px;flex-wrap:wrap">
            <button class="le-btn le-btn-xs" @click="openPicker()">
              🖼 更换
            </button>
            <button class="le-btn le-btn-xs" @click="uploadImage()" :disabled="uploading === selectedIndex">
              {{ uploading === selectedIndex ? '⏳' : '📤 上传' }}
            </button>
            <button class="le-btn le-btn-xs le-btn-d" @click="removeImage()" :disabled="!selectedLayer.config.image">
              ✕ 移除
            </button>
            <span v-if="isL2" class="le-prop-val" style="font-size:8px;opacity:0.35;margin-left:4px">帧动画/静态图均可</span>
          </div>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">灵敏度</span>
          <input type="range" class="le-range" min="0.1" max="2" step="0.1" v-model.number="selectedLayer.config.sensitivity" />
          <span class="le-prop-num">{{ selectedLayer.config.sensitivity.toFixed(1) }}</span>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">大小</span>
          <input type="range" class="le-range" min="0.2" max="3" step="0.05" v-model.number="selectedLayer.config.scale" />
          <span class="le-prop-num">{{ (selectedLayer.config.scale ?? 1).toFixed(2) }}</span>
          <button class="le-btn le-btn-d le-btn-xs" @click="selectedLayer.config.scale = 1" :disabled="(selectedLayer.config.scale ?? 1) === 1">↺</button>
          <span class="le-prop-val" style="flex:1;font-size:8px;text-align:right">🖱 滚轮</span>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">阴影</span>
          <input type="range" class="le-range" min="0" max="1" step="0.01" v-model.number="selectedLayer.config.shadow" />
          <span class="le-prop-num">{{ selectedLayer.config.shadow.toFixed(2) }}</span>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">偏移 X%</span>
          <input class="le-inp-num" type="number" step="0.01" v-model.number="selectedLayer.config.offsetX" :disabled="selectedLayer.config.locked" />
          <span class="le-prop-label">Y%</span>
          <input class="le-inp-num" type="number" step="0.01" v-model.number="selectedLayer.config.offsetY" :disabled="selectedLayer.config.locked" />
          <button class="le-btn le-btn-d le-btn-xs" @click="resetPosition()" :disabled="selectedLayer.config.locked">↺</button>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">亮度</span>
          <input type="range" class="le-range" min="0.2" max="2.5" step="0.01" v-model.number="selectedLayer.config.brightness" />
          <span class="le-prop-num">{{ selectedLayer.config.brightness.toFixed(2) }}</span>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">对比度</span>
          <input type="range" class="le-range" min="0.2" max="2.5" step="0.01" v-model.number="selectedLayer.config.contrast" />
          <span class="le-prop-num">{{ selectedLayer.config.contrast.toFixed(2) }}</span>
        </div>

        <div class="le-prop-row">
          <span class="le-prop-label">饱和度</span>
          <input type="range" class="le-range" min="0" max="3" step="0.01" v-model.number="selectedLayer.config.saturate" />
          <span class="le-prop-num">{{ selectedLayer.config.saturate.toFixed(2) }}</span>
        </div>

        <div class="le-filter-preview">
          <code>滤镜: brightness({{ selectedLayer.config.brightness.toFixed(2) }}) contrast({{ selectedLayer.config.contrast.toFixed(2) }}) saturate({{ selectedLayer.config.saturate.toFixed(2) }})</code>
        </div>
      </div>
    </div>

    <!-- ── ☆ 素材选择器弹窗 ── -->
    <Transition name="picker-fade">
      <div v-if="showPicker" class="picker-overlay" @click.self="closePicker()">
        <div class="picker-dialog">
          <div class="picker-head">
            <span>🖼 选择素材 — {{ profile?.meta.name }}</span>
            <button class="le-btn le-btn-d" @click="closePicker()">✕</button>
          </div>
          <div class="picker-body">
            <!-- 预览 -->
            <div class="picker-preview" v-if="pickerPreview">
              <img :src="pickerPreview" @error="($event.target as HTMLImageElement).style.display='none'" />
            </div>
            <div class="picker-preview picker-preview-empty" v-else>
              <span>👆 悬停预览</span>
            </div>
            <!-- 列表 -->
            <div class="picker-list">
              <div v-if="assetLoading" class="picker-loading">加载中...</div>
              <div v-else-if="assetList.length === 0" class="picker-loading">无素材</div>
              <button
                v-for="f in assetList" :key="f"
                class="picker-item"
                :class="{ active: selectedLayer.config.image === f }"
                @click="selectAsset(f)"
                @mouseenter="previewAsset(f)"
              >
                <span class="picker-icon">🖼</span>
                <span class="picker-name">{{ f }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style>
html, body {
  margin: 0; padding: 0;
  background: #1a1025;
  color: #e0d0e8;
  font-family: "zpix", "pixel-mplus", "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 12px;
  overflow: hidden;
  user-select: none;
}
#le-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}
</style>

<style scoped>
/* ── 工具栏 ── */
#le-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  background: rgba(0,0,0,0.35);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0; flex-wrap: wrap;
}
.le-tabs { display: flex; gap: 3px; flex: 1; }
.le-tab {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
  color: #a090b0; cursor: pointer; font-size: 11px;
  font-family: inherit; transition: all 0.12s;
}
.le-tab:hover { background: rgba(255,255,255,0.08); color: #d0c0e0; }
.le-tab.active { background: rgba(196,39,111,0.25); border-color: rgba(196,39,111,0.45); color: #f0a0c0; }
.le-tab.disabled { opacity: 0.35; }
.le-tab.locked { border-style: dashed; border-color: rgba(196,39,111,0.3); }
.le-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.ldot-0 { background: #60a0f0; } .ldot-1 { background: #60c0a0; }
.ldot-2 { background: #f0a0c0; } .ldot-3 { background: #f0c060; }
.ldot-4 { background: #c060f0; }
.le-tab-name { font-size: 10px; }
.le-tag { font-size: 8px; background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 4px; }
.le-tag.off { background: rgba(255,255,255,0.05); color: #666; }
.le-tag.err { background: rgba(240,160,60,0.2); color: #f0a060; }

.le-actions { display: flex; gap: 4px; align-items: center; }
.le-spacer { width: 8px; }
.le-saved { color: #80f0a0; font-size: 10px; }

.le-btn {
  padding: 3px 10px; border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: #c0b0d0; cursor: pointer; font-size: 11px;
  font-family: inherit; white-space: nowrap; transition: all 0.12s;
}
.le-btn:hover { background: rgba(255,255,255,0.12); color: #e0d0f0; }
.le-btn:disabled { opacity: 0.3; cursor: default; }
.le-btn-d { opacity: 0.5; } .le-btn-d:hover { opacity: 0.8; }
.le-btn-primary { background: rgba(196,39,111,0.3); border-color: rgba(196,39,111,0.5); color: #f0a0c0; }
.le-btn-primary:hover { background: rgba(196,39,111,0.45); }
.le-btn-xs { padding: 1px 4px; font-size: 9px; }

/* ── 主体 ── */
#le-body { flex: 1; display: flex; overflow: hidden; }

/* ── 预览区外层（居中 + 等比例）── */
#le-canvas-wrap {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 8px; min-width: 0;
}

/* ── ☆ WYSIWYG 画布 — JS 显式宽高，维持等比例 ── */
#le-canvas {
  flex-shrink: 0;
  background: rgba(0,0,0,0.4);
  border-radius: 6px;
  position: relative; overflow: hidden;
  cursor: grab;
  touch-action: none;
}
#le-canvas:active { cursor: grabbing; }
.le-grid-h, .le-grid-v {
  position: absolute; pointer-events: none; z-index: 99;
  border-color: rgba(255,255,255,0.06); border-style: dashed;
}
.le-grid-h { left: 0; right: 0; border-top-width: 1px; }
.le-grid-v { top: 0; bottom: 0; border-left-width: 1px; }

/* 窗口边框指示 */
.le-win-border {
  position: absolute; inset: 0;
  border: 1px solid rgba(255,255,255,0.1);
  pointer-events: none; z-index: 100;
  border-radius: 6px;
}
.le-win-label {
  position: absolute; bottom: 3px; right: 6px;
  font-size: 8px; opacity: 0.25; pointer-events: none;
}

.le-loading {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.3); font-size: 14px;
}
.le-preview-layer {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto;
  will-change: transform;
}
.le-preview-layer.selected { outline: 2px solid rgba(240,160,192,0.7); outline-offset: -2px; z-index: 50 !important; }
.le-preview-layer.locked .le-layer-img { cursor: default; }
.le-layer-img {
  width: 100%; height: 100%;
  object-fit: contain; pointer-events: none;
  image-rendering: pixelated; cursor: move;
}
.le-no-img {
  font-size: 11px; color: rgba(255,255,255,0.2); pointer-events: none;
}
.le-drag-hint {
  position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
  padding: 3px 10px; background: rgba(0,0,0,0.75);
  border-radius: 4px; font-size: 10px; color: #f0c060;
  pointer-events: none; z-index: 200; white-space: nowrap;
}

/* ── 属性面板 ── */
#le-panel {
  width: 220px; flex-shrink: 0;
  padding: 8px 10px;
  background: rgba(0,0,0,0.2);
  border-left: 1px solid rgba(255,255,255,0.06);
  display: flex; flex-direction: column; gap: 6px;
  overflow-y: auto;
}
.le-panel-head {
  display: flex; align-items: center; gap: 6px;
  padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.le-panel-title { font-size: 12px; font-weight: bold; color: #f0a0c0; }
.le-prop-section { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.le-prop-row { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.le-prop-label { font-size: 10px; opacity: 0.5; min-width: 42px; flex-shrink: 0; }
.le-prop-val { font-size: 10px; opacity: 0.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.le-prop-val.empty { opacity: 0.25; font-style: italic; }
.le-prop-num { font-size: 10px; width: 30px; text-align: right; opacity: 0.6; }
.le-range { flex: 1; height: 3px; accent-color: #c4276f; min-width: 0; }
.le-inp-num {
  width: 48px; background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;
  color: #f0e0f0; padding: 1px 4px; font-size: 10px;
  font-family: inherit; text-align: center;
}
.le-inp-num:focus { border-color: #c4276f; outline: none; }
.le-inp-num:disabled { opacity: 0.3; }
.le-filter-preview {
  margin-top: 4px; padding: 4px 6px;
  background: rgba(0,0,0,0.3); border-radius: 4px;
}
.le-filter-preview code {
  font-size: 8.5px; opacity: 0.4; word-break: break-all;
  font-family: "SF Mono", "Fira Code", monospace;
}

/* ── ☆ 素材选择器弹窗 ── */
.picker-overlay {
  position: fixed; inset: 0; z-index: 999;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
}
.picker-dialog {
  width: 560px; max-width: 90vw;
  height: 420px; max-height: 80vh;
  background: #2a1535;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
}
.picker-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: rgba(0,0,0,0.3);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 12px; color: #f0a0c0;
}
.picker-body {
  display: flex; flex: 1; overflow: hidden;
}
.picker-preview {
  width: 200px; height: 200px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.2);
  border-right: 1px solid rgba(255,255,255,0.06);
  padding: 8px; overflow: hidden;
}
.picker-preview img {
  max-width: 100%; max-height: 100%;
  object-fit: contain; image-rendering: pixelated;
}
.picker-preview-empty {
  color: rgba(255,255,255,0.2); font-size: 13px;
}
.picker-list {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column; gap: 1px;
  padding: 4px;
  max-height: 360px;
}
.picker-loading {
  padding: 20px; text-align: center;
  color: rgba(255,255,255,0.3); font-size: 12px;
}
.picker-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px;
  border: none; border-radius: 4px;
  background: transparent;
  color: #c0b0d0; cursor: pointer;
  font-size: 11px; font-family: inherit;
  text-align: left; transition: all 0.1s;
}
.picker-item:hover { background: rgba(255,255,255,0.06); color: #e0d0f0; }
.picker-item.active { background: rgba(196,39,111,0.2); color: #f0a0c0; }
.picker-icon { font-size: 14px; flex-shrink: 0; }
.picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.picker-fade-enter-active, .picker-fade-leave-active { transition: opacity 0.15s; }
.picker-fade-enter-from, .picker-fade-leave-to { opacity: 0; }
</style>
