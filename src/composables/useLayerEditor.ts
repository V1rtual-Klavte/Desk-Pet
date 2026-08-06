// ==========================================
// useLayerEditor — WYSIWYG 五层编辑器状态 & 逻辑
// LayerEditor composable
// ==========================================

import { ref, computed, onMounted, onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { initProfiles, getActiveProfile, type ProfileData } from "@/services/profile";
import { userConfig } from "@/services/config";
import { DEFAULT_LAYERS, LAYER_NAMES, layerDepth, type ParallaxLayerCfg } from "@/composables/useParallax";
import { createLogger } from "@/services/logger";

export function useLayerEditor() {
  const log = createLogger("LayerEditor");
  const win = getCurrentWebviewWindow();

  // ── 实际窗口尺寸（StreamView 的弹窗大小）──
  const actualWinSize = computed(() => userConfig.popupSize);

  // ── 状态 ──
  const profile = ref<ProfileData | null>(null);
  const selectedIndex = ref(2);
  const ready = ref(false);

  interface LayerState {
    index: number;
    name: string;
    config: ParallaxLayerCfg;
    url: string | null;
    loadFailed: boolean;
  }

  const layers = ref<LayerState[]>(
    Array.from({ length: 5 }, (_, i) => ({
      index: i,
      name: LAYER_NAMES[i],
      config: { ...DEFAULT_LAYERS[i] },
      url: null,
      loadFailed: false,
    }))
  );

  const saved = ref(false);
  const uploading = ref<number | null>(null);
  const showPicker = ref(false);
  const assetList = ref<string[]>([]);
  const assetLoading = ref(false);
  const pickerPreview = ref("");
  const fileInput = ref<HTMLInputElement | null>(null);

  const selectedLayer = computed(() => layers.value[selectedIndex.value]);
  const isL2 = computed(() => selectedIndex.value === 2);

  // ── 画布自适应尺寸（维持实际窗口等比例）──
  const canvasWrap = ref<HTMLElement | null>(null);
  const canvasSize = ref({ w: 600, h: 370 });

  function updateCanvasSize() {
    const wrap = canvasWrap.value;
    if (!wrap) return;
    const cw = wrap.clientWidth - 16;
    const ch = wrap.clientHeight - 16;
    const ratio = actualWinSize.value.w / actualWinSize.value.h;
    let w: number, h: number;
    if (cw / ch > ratio) {
      h = ch;
      w = h * ratio;
    } else {
      w = cw;
      h = w / ratio;
    }
    canvasSize.value = { w: Math.max(200, Math.round(w)), h: Math.max(120, Math.round(h)) };
  }

  let resizeObs: ResizeObserver | null = null;

  // ── 初始化 ──
  async function initFromStorage() {
    try {
      log.info("开始初始化...");
      await initProfiles();
      const p = getActiveProfile();
      profile.value = p;
      if (!p) {
        log.error("getActiveProfile() 返回 null！");
        return;
      }
      log.info(`Profile: ${p.id} basePath=${p.basePath}`);

      // 优先读 deskpet_parallax_layers（编辑器自己写的），回退到 userConfig.parallaxLayers
      let uLayers = null;
      try {
        const raw = localStorage.getItem("deskpet_parallax_layers");
        if (raw) uLayers = JSON.parse(raw);
      } catch {}
      if (!uLayers) uLayers = userConfig.parallaxLayers;
      log.info("uLayers:", uLayers);

      for (let i = 0; i < 5; i++) {
        const pLayer = p.theme.parallax.layers?.[i];
        const base = pLayer
          ? { ...DEFAULT_LAYERS[i], ...pLayer }
          : { ...DEFAULT_LAYERS[i] };
        const uLayer = uLayers?.[i];
        layers.value[i].config = uLayer ? { ...base, ...uLayer } : { ...base };
        // 版本迁移：整数=旧像素，小数=新百分比（拖拽产生小数）
        const cfg = layers.value[i].config;
        if (cfg.offsetX !== 0 && Number.isInteger(cfg.offsetX)) {
          cfg.offsetX = +((cfg.offsetX / userConfig.popupSize.w) * 100).toFixed(2);
        }
        if (cfg.offsetY !== 0 && Number.isInteger(cfg.offsetY)) {
          cfg.offsetY = +((cfg.offsetY / userConfig.popupSize.h) * 100).toFixed(2);
        }
        refreshLayerUrl(i);
        log.info(`L${i}: url="${layers.value[i].url}" image="${layers.value[i].config.image}"`);
      }
      layers.value[2].config.enabled = true;
      ready.value = true;
      log.info("就绪");
    } catch (err) {
      log.error("init 异常:", err);
    }
  }

  function refreshLayerUrl(i: number) {
    const p = profile.value;
    if (!p) {
      layers.value[i].url = null;
      return;
    }
    if (layers.value[i].config.image) {
      layers.value[i].url = `${p.basePath}/${layers.value[i].config.image}`;
    } else {
      layers.value[i].url = null;
    }
    layers.value[i].loadFailed = false;
  }

  // ── 素材回调 ──
  function onImgLoad(_i: number) {}
  function onImgError(i: number, e: Event) {
    const img = e.target as HTMLImageElement;
    const p = profile.value;
    img.style.display = "none";
    log.warn(`L${i} 加载失败: ${img.src}`);
    if (p && p.id !== "sugar-pink") {
      const fb = "/profiles/sugar-pink";
      const lImg = layers.value[i].config.image;
      const fbUrl = lImg ? `${fb}/${lImg}` : `${fb}/materials/L2/body.png`;
      log.warn(`L${i} 尝试回退: ${fbUrl}`);
      img.src = fbUrl;
      img.style.display = "";
      return;
    }
    layers.value[i].loadFailed = true;
  }

  // ── 拖拽状态（非响应式）──
  let dragActive = false;
  let dragLayerIdx = 2;
  let dragSX = 0,
    dragSY = 0;
  let dragLX = 0,
    dragLY = 0;
  const dragHint = ref("");
  const canvasEl = ref<HTMLElement | null>(null);

  function onPointerDown(index: number, e: PointerEvent) {
    log.info("pointerdown L" + index + " locked=" + layers.value[index].config.locked);
    selectedIndex.value = index;
    if (layers.value[index].config.locked) return;
    const el = canvasEl.value;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragActive = true;
    dragLayerIdx = index;
    dragSX = e.clientX;
    dragSY = e.clientY;
    dragLX = layers.value[index].config.offsetX;
    dragLY = layers.value[index].config.offsetY;
    dragHint.value = layers.value[index].name + ": (0, 0)";
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragActive) return;
    const dx = e.clientX - dragSX;
    const dy = e.clientY - dragSY;
    const l = layers.value[dragLayerIdx];
    l.config.offsetX = dragLX + (dx / canvasSize.value.w) * 100;
    l.config.offsetY = dragLY + (dy / canvasSize.value.h) * 100;
    dragHint.value =
      l.name + " → (" + l.config.offsetX.toFixed(1) + "%, " + l.config.offsetY.toFixed(1) + "%)";
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragActive) return;
    dragActive = false;
    dragHint.value = "";
    const el = canvasEl.value;
    if (el && el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  }

  // ── 滚轮调整选中层大小 ──
  function onWheel(e: WheelEvent) {
    const l = layers.value[selectedIndex.value];
    const s = (l.config.scale ?? 1) - e.deltaY * 0.001;
    l.config.scale = Math.max(0.2, Math.min(3, Math.round(s * 100) / 100));
  }

  // ── 锁定/启用 ──
  function toggleLock() {
    layers.value[selectedIndex.value].config.locked = !selectedLayer.value.config.locked;
  }
  function toggleEnabled() {
    if (isL2.value) return;
    selectedLayer.value.config.enabled = !selectedLayer.value.config.enabled;
  }
  function resetPosition() {
    selectedLayer.value.config.offsetX = 0;
    selectedLayer.value.config.offsetY = 0;
  }
  function resetLayer() {
    const i = selectedIndex.value;
    const p = profile.value;
    const pLayer = p?.theme?.parallax?.layers?.[i];
    const base = pLayer
      ? { ...DEFAULT_LAYERS[i], ...pLayer }
      : { ...DEFAULT_LAYERS[i] };
    layers.value[i].config = { ...base };
    if (i === 2) layers.value[i].config.enabled = true;
    refreshLayerUrl(i);
  }

  // ── 素材上传/移除 ──
  let _uploadTargetLayer = -1;
  function uploadImage() {
    _uploadTargetLayer = selectedIndex.value;
    fileInput.value?.click();
  }
  function onFileSelected(e: Event) {
    const i = _uploadTargetLayer;
    if (i < 0) return;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploading.value = i;
    const p = profile.value!;
    log.info(
      `上传开始 — 层: L${i} "${LAYER_NAMES[i]}" | 文件: ${file.name} (${(file.size / 1024).toFixed(1)}KB) | Profile: ${p.id}`
    );
    const ext = file.name.split(".").pop() || "png";
    const fileName = `layer_${i}_${Date.now()}.${ext}`;
    const relativePath = `materials/L${i}/${fileName}`;
    layers.value[i].config.image = relativePath;
    layers.value[i].url = URL.createObjectURL(file);
    layers.value[i].loadFailed = false;
    log.info(`预览已设置 | ObjectURL | config.image="${relativePath}"`);
    uploadToProfile(i, file, relativePath);
    input.value = "";
  }

  async function uploadToProfile(i: number, file: File, relativePath: string) {
    const p = profile.value!;
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const { invoke } = await import("@tauri-apps/api/core");
      const targetDir = `profiles/${p.id}/materials/L${i}/`;
      log.info(`写入目标: ${targetDir} | 文件: ${relativePath.split("/").pop()}`);
      await invoke("profile_file_write", {
        profileId: p.id,
        relativePath,
        content: bytes,
      });
      log.info(`写入完成 | AppData/desk-pet/${targetDir}${relativePath.split("/").pop()}`);
      log.info(`dev同步 | public/${targetDir}${relativePath.split("/").pop()}`);
    } catch (e: any) {
      log.error(`后台写入失败 | 目录: profiles/${p.id}/materials/L${i}/ | 错误:`, e?.message || e);
    } finally {
      uploading.value = null;
    }
  }

  function removeImage() {
    const i = selectedIndex.value;
    layers.value[i].config.image = "";
    layers.value[i].url = null;
    layers.value[i].loadFailed = false;
  }

  // ── 素材选择器 ──
  async function openPicker() {
    const i = selectedIndex.value;
    const subdir = `materials/L${i}`;
    log.info(`打开素材选择器 | 层: L${i} "${LAYER_NAMES[i]}" | 查询目录: ${subdir}/`);
    showPicker.value = true;
    assetList.value = [];
    assetLoading.value = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const files: string[] = await invoke("list_profile_files", {
        profileId: profile.value!.id,
        subdir,
      });
      assetList.value = files;
      log.info(`素材列表 | ${subdir}/ → ${files.length} 个文件:`, files);
    } catch (e: any) {
      log.warn(`素材列表加载失败 | ${subdir}/ | 错误:`, e?.message || e);
      const defaults = [
        "materials/L0/bg_base.png",
        "materials/L2/body.png",
        "materials/L4/shield_gold.png",
      ];
      assetList.value = defaults.filter((f) =>
        f.startsWith(`materials/L${selectedIndex.value}/`)
      );
    } finally {
      assetLoading.value = false;
    }
  }

  function previewAsset(path: string) {
    pickerPreview.value = `${profile.value!.basePath}/${path}`;
  }

  async function selectAsset(path: string) {
    const i = selectedIndex.value;
    const prefix = `materials/L${i}/`;
    if (!path.startsWith(prefix)) {
      uploading.value = i;
      log.info(`跨层复制 | 源: ${path} → 目标层: L${i}/${prefix}`);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const bytes: number[] = await invoke("profile_file_read", {
          profileId: profile.value!.id,
          relativePath: path,
        });
        log.info(`读取源文件 | ${path} | ${bytes.length} bytes`);
        const ext = path.split(".").pop() || "png";
        const newPath = `${prefix}layer_${i}_${Date.now()}.${ext}`;
        await invoke("profile_file_write", {
          profileId: profile.value!.id,
          relativePath: newPath,
          content: bytes,
        });
        log.info(`复制完成 | ${path} → ${newPath}`);
        layers.value[i].config.image = newPath;
        const blob = new Blob([new Uint8Array(bytes)]);
        layers.value[i].url = URL.createObjectURL(blob);
        layers.value[i].loadFailed = false;
      } catch (e: any) {
        log.error(`跨层复制失败 | ${path} | 错误:`, e?.message || e);
        layers.value[i].config.image = path;
        refreshLayerUrl(i);
      } finally {
        uploading.value = null;
      }
    } else {
      log.info(`同层引用 | L${i} ← ${path}`);
      layers.value[i].config.image = path;
      refreshLayerUrl(i);
    }
    showPicker.value = false;
    pickerPreview.value = "";
  }

  function closePicker() {
    showPicker.value = false;
    pickerPreview.value = "";
  }

  // ── 保存 ──
  function save() {
    const cfg = JSON.parse(
      JSON.stringify(
        layers.value.map((l) => ({
          enabled: l.config.enabled,
          image: l.config.image,
          sensitivity: l.config.sensitivity,
          shadow: l.config.shadow,
          brightness: l.config.brightness,
          contrast: l.config.contrast,
          saturate: l.config.saturate,
          scale: l.config.scale ?? 1,
          offsetX: l.config.offsetX,
          offsetY: l.config.offsetY,
          locked: l.config.locked,
        }))
      )
    );
    userConfig.parallaxLayers = cfg;
    localStorage.removeItem("deskpet_parallax_layers");
    localStorage.removeItem("deskpet_parallax_offset_v2");
    localStorage.setItem("deskpet_parallax_dirty", "1");
    saved.value = true;
    setTimeout(() => {
      saved.value = false;
    }, 2000);
  }

  function closeWindow() {
    win.close().catch(() => {});
  }

  // ── 生命周期 ──
  onMounted(async () => {
    await initFromStorage();
    try {
      await win.setTitle(
        `🎨 图层编辑器 - ${profile.value?.meta.name || "糖糖桌宠"}`
      );
    } catch {}
    if (canvasWrap.value) {
      resizeObs = new ResizeObserver(() => updateCanvasSize());
      resizeObs.observe(canvasWrap.value);
      updateCanvasSize();
    }
  });

  onUnmounted(() => {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
  });

  return {
    // state
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
    // computed
    selectedLayer,
    isL2,
    // events
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    // actions
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
    // callbacks
    onImgLoad,
    onImgError,
    // init (for manual call if needed)
    initFromStorage,
    // utilities used in template
    layerDepth,
    userConfig,
  };
}
