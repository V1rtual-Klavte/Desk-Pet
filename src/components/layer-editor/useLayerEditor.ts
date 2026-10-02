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
  refreshProfileAssets, resolveProfileAssetUrl, type ProfileData, type ProfileDofRegion,
} from "@/services/profile";
import { reloadConfig, userConfig, type EffectMode } from "@/services/config";
import { DEFAULT_LAYERS, LAYER_NAMES, layerDepth, type ParallaxLayerCfg } from "@/composables/useParallax";
import { useDepthOfField, canvasToImage, imageToCanvas, type DofState } from "@/composables/useDepthOfField";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

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

  // ── 景深 ──
  // 与灵动图层互斥，靠 CONFIG 的 effectMode 决定编辑器显示哪套面板。
  const effectMode = ref<EffectMode>(userConfig.effectMode);
  const isDof = computed(() => effectMode.value === "dof");

  const dof = ref<DofState>({
    image: "", url: "",
    blur: 8, scale: 1.0, offsetX: 0, offsetY: 0,
    bgSensitivity: 0.35,
    brightness: 0.95, contrast: 1.0, saturate: 0.9,
    focus: [],
  });

  /**
   * 编辑器里的视差预览用的光标。
   *
   * 正式运行用全局光标，但编辑器是个普通窗口，拿画布自身当坐标系更直观 ——
   * 鼠标在画布上移动就能看到两层错开，不用真去动桌宠。
   */
  const localCursor = ref<{ x: number; y: number } | null>(null);

  /** 默认焦点椭圆：居中、占画布六成宽八成高，灵敏度取 0.9（近景） */
  const DEFAULT_FOCUS: ProfileDofRegion = { x: 50, y: 50, rx: 30, ry: 40, feather: 0.35, sensitivity: 0.9 };

  /**
   * 补一个默认焦点区。
   *
   * 没有焦点区时是「整图统一模糊」，刚选完图就看到一片糊会让人以为出错了；
   * 给个默认椭圆能立刻看到清晰/模糊的对比，不想要再点「清除焦点区」。
   */
  function ensureDefaultFocus(): void {
    if (dof.value.focus.length > 0) return;
    addFocusRegion();
  }

  /**
   * 追加一个默认大小的焦点椭圆，并选中它。
   *
   * 焦点区只由这里和右侧滑块决定大小 —— 不在画布上拖出来，否则手一抖就会
   * 把椭圆拖成指甲盖那么大。后续追加的会横向错开，免得和已有的完全重叠看不出来。
   */
  function addFocusRegion(): void {
    const n = dof.value.focus.length;
    dof.value.focus = [...dof.value.focus, { ...DEFAULT_FOCUS, x: clamp(50 + n * 10, 15, 85) }];
    selectedFocus.value = n;
  }

  /** 删掉当前选中的焦点区 */
  function removeFocusRegion(): void {
    const i = selectedFocus.value;
    if (i < 0) return;
    dof.value.focus = dof.value.focus.filter((_, idx) => idx !== i);
    selectedFocus.value = dof.value.focus.length > 0 ? Math.min(i, dof.value.focus.length - 1) : -1;
  }
  /** 当前选中的焦点区索引；-1 = 没有 */
  const selectedFocus = ref(-1);
  /** 画布拖动的作用：false=平移素材（默认），true=移动焦点区 */
  const dofFocusDrag = ref(false);
  const selectedRegion = computed(() =>
    selectedFocus.value >= 0 ? dof.value.focus[selectedFocus.value] : undefined);

  const saved = ref(false);
  const uploading = ref<number | null>(null);
  const showPicker = ref(false);
  /** 素材选择器的目标：给某一层选，还是给景深选 */
  const pickerTarget = ref<"layer" | "dof">("layer");
  const dofUploading = ref(false);
  const assetList = ref<string[]>([]);
  const assetLoading = ref(false);
  const pickerPreview = ref("");
  const fileInput = ref<HTMLInputElement | null>(null);

  const selectedLayer = computed(() => layers.value[selectedIndex.value]);
  // ── 画布自适应尺寸（维持实际窗口等比例）──
  const canvasWrap = ref<HTMLElement | null>(null);
  const canvasSize = ref({ w: 600, h: 370 });

  // 景深预览：样式与位移都和 StreamView 共用同一套计算，所见即所得。
  const originPos = ref({ x: 0, y: 0 });
  const alwaysVisible = ref(true);
  const { backgroundStyle: dofBgStyle, focusLayers: dofFocusLayers } =
    useDepthOfField(dof, {
      cursor: localCursor,
      windowPos: originPos,
      windowSize: canvasSize,
      isVisible: alwaysVisible,
    });

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
  let unlistenSettingsSaved: UnlistenFn | null = null;

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

      // 景深：模式决定编辑器显示哪套面板，配置从同一个 Profile 的另一组字段读。
      effectMode.value = userConfig.effectMode;
      const d = p.theme.depthOfField;
      dof.value = { ...d, url: d.image ? resolveProfileAssetUrl(p, d.image) : "" };
      selectedFocus.value = d.focus.length > 0 ? 0 : -1;

      ready.value = true;
      log.info(`就绪 | 效果模式: ${effectMode.value}`);
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

  // ── 景深：画布拖拽 ──
  // 默认拖素材取景；勾上「拖动焦点区」才改为操作焦点椭圆。
  // 不靠自动命中判断 —— 那会让「我想挪图」和「我想挪圈」互相抢手势。
  // 两种模式都不改变焦点区大小，大小只由滑块决定。
  let dofDrag = false,
    dofMoved = false;
  let dofSX = 0,
    dofSY = 0;
  let dofMovingIdx = -1;
  let dofStart: ProfileDofRegion | null = null;
  let dofStartOffset = { x: 0, y: 0 };

  /** 指针位置 → 画布百分比坐标。顺带刷新视差预览用的画布内坐标。 */
  function dofPoint(e: PointerEvent): { x: number; y: number } | null {
    const el = canvasEl.value;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    localCursor.value = { x: px, y: py };
    return { x: (px / rect.width) * 100, y: (py / rect.height) * 100 };
  }

  /** 指针离开画布 → 视差归位 */
  function onCanvasPointerLeave() {
    localCursor.value = null;
  }

  /**
   * 命中测试：点落在哪个椭圆内（后画的在上，所以倒序遍历）。
   *
   * 入参是画布坐标，而椭圆存在素材坐标里，先换算再比较 —— 缩放/平移之后
   * 不换算就会「看着在图里点，实际判定在外面」。
   */
  function hitFocus(p: { x: number; y: number }): number {
    const { scale, offsetX, offsetY, focus } = dof.value;
    const ix = canvasToImage(p.x, offsetX, scale);
    const iy = canvasToImage(p.y, offsetY, scale);
    for (let i = focus.length - 1; i >= 0; i--) {
      const r = focus[i];
      const dx = (ix - r.x) / (r.rx || 1);
      const dy = (iy - r.y) / (r.ry || 1);
      if (dx * dx + dy * dy <= 1) return i;
    }
    return -1;
  }

  function onDofPointerDown(e: PointerEvent) {
    const el = canvasEl.value;
    const p = dofPoint(e);
    if (!el || !p) return;
    el.setPointerCapture(e.pointerId);
    dofDrag = true;
    dofMoved = false;
    dofSX = p.x;
    dofSY = p.y;
    dofStartOffset = { x: dof.value.offsetX, y: dof.value.offsetY };

    const hit = dofFocusDrag.value ? hitFocus(p) : -1;
    if (hit >= 0) {
      dofMovingIdx = hit;
      selectedFocus.value = hit;
      dofStart = { ...dof.value.focus[hit] };
      dragHint.value = "移动焦点区";
    } else {
      dofMovingIdx = -1;
      dofStart = null;
      dragHint.value = dofFocusDrag.value ? "在椭圆内按下才能拖动焦点区" : "平移素材取景";
    }
    e.preventDefault();
  }

  function onDofPointerMove(e: PointerEvent) {
    // 先取坐标：即使没在拖动，也要刷新视差预览（鼠标一动，两层就该错开）
    const p = dofPoint(e);
    if (!p || !dofDrag) return;
    if (!dofMoved && Math.abs(p.x - dofSX) < 0.5 && Math.abs(p.y - dofSY) < 0.5) return;
    dofMoved = true;

    const { scale } = dof.value;

    if (dofMovingIdx >= 0 && dofStart) {
      // 画布位移换算回素材坐标：缩放越大，同样的手部位移对应的素材位移越小
      const r = dof.value.focus[dofMovingIdx];
      r.x = clamp(dofStart.x + (p.x - dofSX) / (scale || 1), 0, 100);
      r.y = clamp(dofStart.y + (p.y - dofSY) / (scale || 1), 0, 100);
      return;
    }

    dof.value.offsetX = dofStartOffset.x + (p.x - dofSX);
    dof.value.offsetY = dofStartOffset.y + (p.y - dofSY);
  }

  function onDofPointerUp(e: PointerEvent) {
    if (!dofDrag) return;
    dofDrag = false;
    dofMovingIdx = -1;
    dofStart = null;
    dragHint.value = "";
    const el = canvasEl.value;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  /**
   * 焦点椭圆在画布上的位置。
   *
   * 椭圆存在素材坐标里（这样缩放后它仍贴着主体），画到屏幕上必须换算成画布
   * 坐标 —— 不换算的话，缩放之后看到的圈和实际清晰区会分家。
   */
  const focusRings = computed(() =>
    dof.value.focus.map((r, i) => {
      const cx = imageToCanvas(r.x, dof.value.offsetX, dof.value.scale);
      const cy = imageToCanvas(r.y, dof.value.offsetY, dof.value.scale);
      const rx = r.rx * dof.value.scale;
      const ry = r.ry * dof.value.scale;
      // 圈跟着自己那一层走 —— 各层灵敏度不同，用同一个位移就会错开
      const travel = dofFocusLayers.value[i]?.travel ?? { x: 0, y: 0 };
      return {
        left: `${(cx - rx).toFixed(2)}%`,
        top: `${(cy - ry).toFixed(2)}%`,
        width: `${(rx * 2).toFixed(2)}%`,
        height: `${(ry * 2).toFixed(2)}%`,
        opacity: 0.25 + (1 - r.feather) * 0.55,
        transform: `translate(${travel.x.toFixed(1)}px, ${travel.y.toFixed(1)}px)`,
      };
    }));

  function clearFocus() {
    dof.value.focus = [];
    selectedFocus.value = -1;
  }

  /** 取景复位：缩放回 1、平移归零。焦点区不受影响。 */
  function resetFraming() {
    dof.value.scale = 1;
    dof.value.offsetX = 0;
    dof.value.offsetY = 0;
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
  /** 同一个 file input 兼作景深上传，用这个开关分辨本次是给谁的 */
  let _uploadDof = false;
  /**
   * 打开系统文件对话框。
   *
   * 编辑器窗口被抬到 1500 才能盖住设置窗和主窗口，而原生对话框在普通层级，
   * 会被整个盖住。所以取文件期间把三个窗口临时降级，对话框关闭后再恢复
   * （取消时 WebView 同样会重新获得焦点）。
   */
  function openFileDialog(): void {
    invoke("set_picker_window_level", { picking: true })
      .catch(error => log.warn("编辑器窗口降级失败：原生文件对话框可能被设置窗/主窗口遮挡", formatError(error)));
    const restore = () => {
      window.removeEventListener("focus", restore);
      invoke("set_picker_window_level", { picking: false })
        .catch(error => log.warn("窗口层级恢复失败：三个窗口可能停在降级层级，需重启编辑器窗口", formatError(error)));
    };
    window.addEventListener("focus", restore);
    fileInput.value?.click();
  }

  function uploadImage() {
    _uploadDof = false;
    _uploadTargetLayer = selectedIndex.value;
    openFileDialog();
  }

  /** 景深素材上传：写进 materials/ 根，不与任何层绑定 */
  function uploadDofImage() {
    _uploadDof = true;
    openFileDialog();
  }

  async function uploadDofToProfile(file: File) {
    const p = profile.value!;
    dofUploading.value = true;
    const ext = file.name.split(".").pop() || "png";
    const relativePath = `materials/dof_${Date.now()}.${ext}`;
    dof.value.image = relativePath;
    dof.value.url = URL.createObjectURL(file);
    ensureDefaultFocus();
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await invoke("profile_file_write", { profileId: p.id, relativePath, content: bytes });
      await refreshProfileAssets(p.id);
      dof.value.url = resolveProfileAssetUrl(p, relativePath);
      log.info(`景深素材已上传: ${relativePath}`);
    } catch (e: any) {
      log.error(`景深素材写入失败 | ${relativePath} |`, e?.message || e);
    } finally {
      dofUploading.value = false;
    }
  }

  function onFileSelected(e: Event) {
    // 双保险：取完文件立刻恢复窗口层级。取消时 change 可能不触发，那条路由 focus 兜底。
    invoke("set_picker_window_level", { picking: false })
      .catch(error => log.warn("窗口层级恢复失败：三个窗口可能停在降级层级，需重启编辑器窗口", formatError(error)));
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (_uploadDof) {
      _uploadDof = false;
      input.value = "";
      void uploadDofToProfile(file);
      return;
    }
    const i = _uploadTargetLayer;
    if (i < 0) return;
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
    pickerTarget.value = "layer";
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
      // 保留 warn（不升 error）：对话框回退到默认素材列表、用户可继续操作，
      // 失败原因已随这条日志可查 [保留已登记 §4.2]
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

  /**
   * 景深素材选择器。
   *
   * 列整个 materials/ 目录（含子目录）—— 景深只用一张图，不该被限制在某个 L{n} 里。
   */
  async function openDofPicker() {
    pickerTarget.value = "dof";
    log.info("打开素材选择器 | 景深素材 | 查询目录: materials/");
    showPicker.value = true;
    assetList.value = [];
    assetLoading.value = true;
    try {
      const files: string[] = await invoke("list_profile_files", {
        profileId: profile.value!.id,
        subdir: "materials",
      });
      assetList.value = [...new Set(files)];
      log.info(`素材列表 | materials/ → ${files.length} 个文件`);
    } catch (e: any) {
      // 保留 warn（不升 error）：对话框留空但仍可用，失败原因已随这条日志可查
      // [保留已登记 §4.2]
      log.warn("景深素材列表加载失败:", e?.message || e);
      assetList.value = [];
    } finally {
      assetLoading.value = false;
    }
  }

  function previewAsset(path: string) {
    pickerPreview.value = resolveProfileAssetUrl(profile.value!, path);
  }

  async function selectAsset(path: string) {
    // 景深只有一张素材，直接引用，不需要跨层复制那一套。
    if (pickerTarget.value === "dof") {
      dof.value.image = path;
      dof.value.url = resolveProfileAssetUrl(profile.value!, path);
      ensureDefaultFocus();
      log.info(`景深素材已选择 | ${path}`);
      showPicker.value = false;
      pickerPreview.value = "";
      return;
    }

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

  /** 把两种效果各自的配置写回当前 Profile 的 profile.yaml */
  async function persistProfile() {
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

    const d = dof.value;
    profileYaml.theme.depthOfField = {
      image: d.image,
      blur: d.blur,
      scale: d.scale,
      offsetX: d.offsetX,
      offsetY: d.offsetY,
      bgSensitivity: d.bgSensitivity,
      brightness: d.brightness,
      contrast: d.contrast,
      saturate: d.saturate,
      focus: d.focus.map((r) => ({
        x: r.x, y: r.y, rx: r.rx, ry: r.ry, feather: r.feather, sensitivity: r.sensitivity,
      })),
    };

    await invoke("profile_file_write", {
      profileId: p.id,
      relativePath: "profile.yaml",
      content: Array.from(new TextEncoder().encode(yaml.dump(profileYaml, { lineWidth: -1, noRefs: true }))),
    });
  }

  // ── 保存 ──
  async function save() {
    try {
      await persistProfile();
      await emit("deskpet-profile-updated", { profileId: profile.value?.id });
      saved.value = true;
      setTimeout(() => {
        saved.value = false;
      }, 2000);
    } catch (e: any) {
      // 保留 warn（不升 error）：下一行 window.alert 已把失败原因当场告知用户，
      // warn 足够 [保留已登记 §4.2]
      log.warn(`保存图层失败: ${e?.message || e}`);
      window.alert(e?.message || "保存图层失败");
    }
  }

  function closeWindow() {
    win.close().catch(error => log.warn("关闭图层编辑器窗口失败:", formatError(error)));
  }

  // ── 生命周期 ──
  onMounted(async () => {
    await initFromStorage();
    unlistenProfileUpdated = await listen<{ profileId?: string }>("deskpet-profile-updated", async ({ payload }) => {
      await reloadConfig();
      await initFromStorage(payload?.profileId);
    });
    // 效果模式是 CONFIG 字段：设置页切换后要立刻换面板，否则编辑器会停在旧模式的界面上。
    unlistenSettingsSaved = await listen("deskpet-settings-saved", async () => {
      await reloadConfig();
      await initFromStorage();
    });
    try {
      await win.setTitle(
        `🎨 图层编辑器 - ${profile.value?.meta.name || "糖糖桌宠"}`
      );
    } catch {
      // 标题写入失败仅影响窗口标题文案（主题名异常/非 Tauri 宿主），不影响编辑与保存；
      // 窗口层级降级已有留痕（:479/:483/:525）[保留已登记 §4.2]
    }
    if (canvasWrap.value) {
      resizeObs = new ResizeObserver(() => updateCanvasSize());
      resizeObs.observe(canvasWrap.value);
      updateCanvasSize();
    }
  });

  onUnmounted(() => {
    unlistenProfileUpdated?.();
    unlistenSettingsSaved?.();
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
    // 景深
    effectMode,
    isDof,
    dof,
    dofBgStyle,
    dofFocusLayers,
    dofUploading,
    selectedFocus,
    selectedRegion,
    onDofPointerDown,
    onDofPointerMove,
    onDofPointerUp,
    onCanvasPointerLeave,
    dofFocusDrag,
    focusRings,
    addFocusRegion,
    removeFocusRegion,
    clearFocus,
    resetFraming,
    openDofPicker,
    uploadDofImage,
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
