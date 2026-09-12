// ==========================================
// useLayerEditor — WYSIWYG 五层编辑器状态 & 逻辑
// LayerEditor composable
// ==========================================

import { ref, computed, onMounted, onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  activateProfile, ensureProfileLoaded, initProfiles, getActiveProfile, invalidateProfileCache,
  refreshProfileAssets, resolveProfileAssetUrl, type ProfileData,
} from "@/services/profile";
import { reloadConfig, userConfig } from "@/services/config";
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
  let unlistenProfileUpdated: UnlistenFn | null = null;

  // ── 初始化 ──
  async function initFromStorage(profileId?: string) {
    try {
      log.info("开始初始化...");
      await initProfiles();
      if (profileId) {
        invalidateProfileCache(profileId);
        const requested = await ensureProfileLoaded(profileId);
        if (!requested || !activateProfile(profileId)) {
          log.warn(`无法加载切换后的 Profile: ${profileId}`);
          return;
        }
      }
      const p = getActiveProfile();
      profile.value = p;
      if (!p) {
        log.error("getActiveProfile() 返回 null！");
        return;
      }
      log.info(`Profile: ${p.id} basePath=${p.basePath}`);

      for (let i = 0; i < 5; i++) {
        const pLayer = p.theme.parallax.layers?.[i];
        const base = pLayer
          ? { ...DEFAULT_LAYERS[i], ...pLayer }
          : { ...DEFAULT_LAYERS[i] };
        layers.value[i].config = { ...base };
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
      layers.value[i].url = resolveProfileAssetUrl(p, layers.value[i].config.image);
    } else {
      layers.value[i].url = null;
    }
    layers.value[i].loadFailed = false;
  }

  // ── 素材回调 ──
  function onImgLoad(_i: number) {}
  function onImgError(i: number, e: Event) {
    const img = e.target as HTMLImageElement;
    img.style.display = "none";
    log.warn(`L${i} 加载失败: ${img.src}`);
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
    // 拖动同样会随 save() 持久化，且移动过程无日志，这里在收尾时留一条
    const l = layers.value[dragLayerIdx];
    log.debug(
      `拖动结束 ${l.name} → (${l.config.offsetX.toFixed(2)}%, ${l.config.offsetY.toFixed(2)}%)`,
    );
    const el = canvasEl.value;
    if (el && el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  }

  // ── 滚轮调整选中层大小 ──
  // 事件绑定在 #le-canvas 上且已 .prevent，所以只有指针在画布上滚动才会触发。
  function onWheel(e: WheelEvent) {
    const l = layers.value[selectedIndex.value];
    const s = (l.config.scale ?? 1) - e.deltaY * 0.001;
    const next = Math.max(0.2, Math.min(3, Math.round(s * 100) / 100));
    if (next === l.config.scale) return;
    l.config.scale = next;
    // 缩放会随 save() 直接持久化进 CONFIG，留痕便于回溯「这层怎么被放大了」
    log.debug(`滚轮缩放 ${l.name} → ${next}`);
  }

  // ── 锁定/启用 ──
  function toggleLock() {
    layers.value[selectedIndex.value].config.locked = !selectedLayer.value.config.locked;
  }
  function toggleEnabled() {
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
      // 不拼路径：base 目录由 Rust 的 profile_file_write 持有，这里只知道域内相对路径
      log.info(`写入目标: profile=${p.id} L${i} | 文件: ${relativePath}`);
      await invoke("profile_file_write", {
        profileId: p.id,
        relativePath,
        content: bytes,
      });
      await refreshProfileAssets(p.id)
      refreshLayerUrl(i)
      log.info(`写入完成: ${relativePath}`);
    } catch (e: any) {
      log.error(`后台写入失败 | profile=${p.id} L${i} | ${relativePath} |`, e?.message || e);
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
      const configured = profile.value!.theme.parallax.layers
        .map(layer => layer.image)
        .filter(path => path?.startsWith(`${subdir}/`))
      assetList.value = [...new Set([...files, ...configured])];
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
    pickerPreview.value = resolveProfileAssetUrl(profile.value!, path);
  }

  async function selectAsset(path: string) {
    const i = selectedIndex.value;
    const prefix = `materials/L${i}/`;
    if (!path.startsWith(prefix)) {
      uploading.value = i;
      log.info(`跨层复制 | 源: ${path} → 目标层: L${i}/${prefix}`);
      try {
        const response = await fetch(resolveProfileAssetUrl(profile.value!, path))
        if (!response.ok) throw new Error(`读取源素材失败: ${response.status}`)
        const bytes = Array.from(new Uint8Array(await response.arrayBuffer()))
        log.info(`读取源文件 | ${path} | ${bytes.length} bytes`);
        const ext = path.split(".").pop() || "png";
        const newPath = `${prefix}layer_${i}_${Date.now()}.${ext}`;
        await invoke("profile_file_write", {
          profileId: profile.value!.id,
          relativePath: newPath,
          content: bytes,
        });
        await refreshProfileAssets(profile.value!.id)
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

  async function persistLayers() {
    const p = profile.value;
    if (!p) throw new Error("没有激活的 Profile")
    const raw = await invoke<number[]>("profile_file_read", {
      profileId: p.id,
      relativePath: "profile.yaml",
    });
    const yaml = await import("js-yaml");
    const profileYaml = yaml.load(new TextDecoder().decode(new Uint8Array(raw))) as Record<string, any>;
    profileYaml.theme = profileYaml.theme || {};
    profileYaml.theme.parallax = profileYaml.theme.parallax || {};
    profileYaml.theme.parallax.layers = layers.value.map((layer) => ({
      enabled: layer.config.enabled,
      image: layer.config.image,
      sensitivity: layer.config.sensitivity,
      shadow: layer.config.shadow,
      brightness: layer.config.brightness,
      contrast: layer.config.contrast,
      saturate: layer.config.saturate,
      scale: layer.config.scale ?? 1,
      offsetX: layer.config.offsetX,
      offsetY: layer.config.offsetY,
      locked: layer.config.locked,
    }));
    await invoke("profile_file_write", {
      profileId: p.id,
      relativePath: "profile.yaml",
      content: Array.from(new TextEncoder().encode(yaml.dump(profileYaml, { lineWidth: -1, noRefs: true }))),
    });
  }

  // ── 保存 ──
  async function save() {
    try {
      await persistLayers();
      await emit("deskpet-profile-updated", { profileId: profile.value?.id });
      saved.value = true;
      setTimeout(() => {
        saved.value = false;
      }, 2000);
    } catch (e: any) {
      log.warn(`保存图层失败: ${e?.message || e}`);
      window.alert(e?.message || "保存图层失败");
    }
  }

  function closeWindow() {
    win.close().catch(() => {});
  }

  // ── 生命周期 ──
  onMounted(async () => {
    await initFromStorage();
    unlistenProfileUpdated = await listen<{ profileId?: string }>("deskpet-profile-updated", async ({ payload }) => {
      await reloadConfig();
      await initFromStorage(payload?.profileId);
    });
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
    unlistenProfileUpdated?.();
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
