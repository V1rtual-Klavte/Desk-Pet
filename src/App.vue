<script setup lang="ts">
import "./styles/fonts.css";
import "./styles/global.css";
import { ref, onMounted, onUnmounted, provide } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import TitleBar from "./components/TitleBar.vue";
import StreamView from "./components/StreamView.vue";
import ChatPanel from "./components/ChatPanel.vue";
import SessionTabs from "./components/SessionTabs.vue";
import WinSim from "./components/winsim/WinSim.vue";
import { initWindowListener } from "./services/window";
import { switchToSession, createNewSession, closeSession, openSession, deleteSession, getSessions, getActiveSessionId, initWelcome } from "@/services/agent";
import type { PiSessionSummary } from "@/services/session";
import { initApp } from "@/services/init";
import { desktopConfig, generalConfig, shortcutConfig, userConfig, reloadConfig } from "@/services/config";
import { isMacOS } from "@/services/env";
import { getUiUrl } from "@/services/profile";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";
import { playEventSound } from "@/services/audio/registry";
import { emit, listen } from "@tauri-apps/api/event";
import { stopMemoryConsolidationTimer } from "@/services/agent/memory/consolidate"

const log = createLogger("App");

/** 新建会话后补一条问候语 —— 一律走当前激活 Card，不在调用点写死文案。 */
async function greetNewSession(): Promise<void> {
  const { pickActiveGreeting } = await import("@/services/personality");
  const greeting = pickActiveGreeting();
  if (greeting) await initWelcome(greeting);
}

const isWinSim = (() => {
  try { return getCurrentWebviewWindow().label === "windows-sim"; }
  catch { return false; }
})();

const showChat = ref(true);
const winSize = ref({ w: 0, h: 0 });
const cursorInWindow = ref<{ x: number; y: number } | null>(null);
const globalCursor = ref<{ x: number; y: number } | null>(null);
/** onMoved 追踪的最后已知窗口位置 */
const lastMovedPos = ref<{ x: number; y: number } | null>(null);
const isRetracted = ref(false);
const isAnimating = ref(false);

// ── Provide 给子组件（StreamView 灵动图层）──
provide("globalCursor", globalCursor);
provide("windowPos", lastMovedPos);
provide("windowSize", winSize);
provide("isRetracted", isRetracted);
const chatRef = ref<InstanceType<typeof ChatPanel> | null>(null);

// ── 可拖动分割线 ──
const DEFAULT_CHAT_WIDTH = 220;
const MIN_CHAT_WIDTH = 120;
const MAX_CHAT_RATIO = 0.55;

function loadDividerPos(): number {
  const value = userConfig.chatWidth
  return Number.isFinite(value) && value >= MIN_CHAT_WIDTH ? value : DEFAULT_CHAT_WIDTH
}

const chatWidth = ref(loadDividerPos());
const isDraggingDivider = ref(false);

function onDividerMousedown(e: MouseEvent) {
  e.preventDefault();
  isDraggingDivider.value = true;
  const startX = e.clientX;
  const startW = chatWidth.value;

  function onMove(ev: MouseEvent) {
    const delta = startX - ev.clientX;
    const newW = Math.max(MIN_CHAT_WIDTH, Math.min(
      Math.round(window.innerWidth * MAX_CHAT_RATIO),
      startW + delta
    ));
    chatWidth.value = newW;
  }

  function onUp() {
    isDraggingDivider.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    userConfig.chatWidth = chatWidth.value
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

async function onSessionSwitch(session: { id: string; name: string }) {
  log.info("切换到会话:", session.id, session.name)
  try {
    await switchToSession(session.id);
    log.info("会话已切换完成:", session.id)
  } catch (e) {
    log.error("切换会话失败:", session.id, e)
  }
}

async function onSessionNew() {
  try {
    await createNewSession();
  } catch (e) {
    log.error("新建会话失败:", formatError(e))
    return
  }
  await greetNewSession();
}

async function onSessionClose(sessionId: string) {
  closeSession(sessionId)
  const remaining = getSessions()
  if (remaining.length === 0) {
    await createNewSession()
    await greetNewSession()
  } else if (getActiveSessionId() === sessionId || getActiveSessionId() === "") {
    await switchToSession(remaining[0].id)
  }
}

async function onDeleteSession(sessionId: string) {
  log.info("onDeleteSession:", sessionId)
  try {
    const wasActive = getActiveSessionId() === sessionId
    await deleteSession(sessionId)
    if (getSessions().length === 0) {
      await createNewSession()
      await greetNewSession()
    } else if (wasActive || getActiveSessionId() === "") {
      await switchToSession(getSessions()[0].id)
    }
    log.info("onDeleteSession 完成:", sessionId)
  } catch (e) {
    log.error("删除会话失败:", sessionId, formatError(e))
  }
}

async function onRestoreSession(item: PiSessionSummary) {
  log.info("onRestoreSession:", item.id, item.name)
  try {
    openSession({
      id: item.id,
      name: item.name || "新会话",
      createdAt: item.createdAt,
      path: item.path,
    })
    await switchToSession(item.id)
    log.info("onRestoreSession 完成:", item.id)
  } catch (e) {
    log.error("恢复会话失败:", item.id, formatError(e))
  }
}

function onRequestPopup() {
  if (isRetracted.value && !isAnimating.value) {
    handleShortcutToggle();
  }
}

async function openSettings() {
  try {
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await existing.setFocus();
      return;
    }
  } catch { /* ignore */ }

  new WebviewWindow("settings", {
    url: "settings.html",
    title: "设置 - 糖糖桌宠",
    width: 440,
    height: 560,
    resizable: true,
    decorations: true,
    alwaysOnTop: true,
    transparent: true,
  });
  void enhanceWindowWhenReady("settings", "enhance_settings_window");
}

/**
 * 提层命令要在窗口真正建好之后才生效：窗口未就绪时 getByLabel 拿不到、命令会静默空转。
 * 轮询等待目标出现（上限 2s）再调用，超时留日志 —— 创建时的 alwaysOnTop 仍作兜底，
 * 但不能靠它掩盖静默失效。
 */
async function enhanceWindowWhenReady(
  label: string,
  command: string,
  beforeEnhance?: (win: WebviewWindow) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const win = await WebviewWindow.getByLabel(label).catch(() => null);
    if (win) {
      if (beforeEnhance) await beforeEnhance(win).catch(() => {});
      await invoke(command).catch(error => log.warn(`${command} 调用失败:`, formatError(error)));
      return;
    }
    if (Date.now() >= deadline) {
      log.warn(`${command} 跳过：窗口 ${label} 未在 2s 内就绪`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function openLayerEditor() {
  try {
    const existing = await WebviewWindow.getByLabel("layer-editor");
    if (existing) { await existing.setFocus(); return; }
  } catch { /* ignore */ }
  new WebviewWindow("layer-editor", {
    url: "layer-editor.html",
    title: "图层编辑器 - 糖糖桌宠",
    width: 820,
    height: 580,
    resizable: true,
    decorations: true,
    alwaysOnTop: true,
  });
  void enhanceWindowWhenReady("layer-editor", "enhance_layer_editor_window", async win => {
    await win.setAlwaysOnTop(true);
    await win.setFocus();
  });
}

let cleanupListener: (() => void) | null = null;
/** 光标追踪的注销句柄：非 null 即当前已注册（只在 effectMode ≠ off 时） */
let cleanupCursorTracker: (() => void) | null = null;
/** 注册态判定的串行队列 + 卸载标记，见 syncCursorTracker() */
let cursorTrackerQueue: Promise<void> = Promise.resolve();
let cursorTrackerDisposed = false;
let cleanupFocus: (() => void) | null = null;
let cleanupMoved: (() => void) | null = null;
let cleanupResized: (() => void) | null = null;
let cleanupPreview: (() => void) | null = null;
let cleanupSettingsSaved: (() => void) | null = null;
let cleanupClick: (() => void) | null = null;

// ==========================================
// 快捷键召唤/收回
// ==========================================
const savedPos = ref<{ x: number; y: number } | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const isDraggingByUser = ref(false);
/** 程序化 setSize 的目标值 */
const expectedSize = ref<{ w: number; h: number } | null>(null);
let ignoreResizeUntil = 0;

function toLogicalSize(p: { width: number; height: number }) {
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(p.width / dpr), h: Math.round(p.height / dpr) };
}
function toLogicalPos(p: { x: number; y: number }) {
  const dpr = window.devicePixelRatio || 1;
  return { x: Math.round(p.x / dpr), y: Math.round(p.y / dpr) };
}

async function setWindowSize(w: number, h: number) {
  expectedSize.value = { w, h };
  ignoreResizeUntil = Date.now() + 3000;
  const win = getCurrentWebviewWindow();
  await win.setSize(new LogicalSize(w, h));
}

async function setWindowPos(x: number, y: number) {
  lastMovedPos.value = { x, y };
  ignoreResizeUntil = Date.now() + 3000;
  const win = getCurrentWebviewWindow();
  await win.setPosition(new LogicalPosition(x, y));
}

function getPopupSize(): { w: number; h: number } {
  const sz = userConfig.popupSize;
  const maxW = Math.round((window.screen.availWidth || 1920) * 0.6);
  const maxH = Math.round((window.screen.availHeight || 1080) * 0.6);
  if (sz.w < 50 || sz.h < 50 || sz.w > maxW || sz.h > maxH) {
    log.warn("弹窗尺寸数据异常，回退默认 730x450 | saved:", sz);
    return { w: 730, h: 450 };
  }
  return sz;
}

async function handleDockPopup() {
  if (isAnimating.value) return;
  isAnimating.value = true;

  try {
    const win = getCurrentWebviewWindow();
    const el = rootRef.value!;
    const sz = getPopupSize();

    expectedSize.value = { w: sz.w, h: sz.h };
    ignoreResizeUntil = Date.now() + 3000;

    const { screen: scr } = window;
    const cx = Math.round((scr.availWidth - sz.w) / 2);
    const cy = Math.round((scr.availHeight - sz.h) / 2);

    el.style.opacity = "0";
    await win.show();
    if (await win.isMinimized()) {
      await win.unminimize();
      await new Promise((r) => setTimeout(r, 150));
    }
    await setWindowSize(sz.w, sz.h);
    await new Promise((r) => setTimeout(r, 40));
    await setWindowPos(cx, cy);
    await new Promise((r) => setTimeout(r, 40));

    await el.animate(
      [{ opacity: "0" }, { opacity: "1" }],
      { duration: 200, easing: "ease-out", fill: "forwards" }
    ).finished;
    el.style.opacity = "";

    isRetracted.value = false;
    setTimeout(() => chatRef.value?.focusInput(), 50);
    playEventSound("popup");
    log.debug("dock弹出 | 中央:", { x: cx, y: cy });
  } catch (e) {
    log.error("dock弹出失败", e);
  } finally {
    setTimeout(() => { isAnimating.value = false; }, 500);
  }
}

async function handleShortcutToggle() {
  if (isAnimating.value) return;
  isAnimating.value = true;

  try {
    const win = getCurrentWebviewWindow();
    const el = rootRef.value!;

    if (!isRetracted.value) {
      try {
        if (lastMovedPos.value) {
          savedPos.value = { ...lastMovedPos.value };
        } else {
          const raw = await win.outerPosition();
          savedPos.value = toLogicalPos({ x: raw.x, y: raw.y });
        }
        log.debug("更新家位置:", savedPos.value);
      } catch { /* ignore */ }

      const cursor = await invoke<{ x: number; y: number; screen_x: number; screen_y: number; screen_w: number; screen_h: number }>("get_cursor_position");
      const curPos = lastMovedPos.value ?? toLogicalPos(await win.outerPosition());
      el.style.transformOrigin = `${cursor.x - curPos.x}px ${cursor.y - curPos.y}px`;

      await el.animate(
        [
          { transform: "scale(1)", opacity: "1" },
          { transform: "scale(0)", opacity: "0" },
        ],
        { duration: 250, easing: "cubic-bezier(0.36, 0, 0.66, -0.56)", fill: "forwards" }
      ).finished;

      await win.hide();
      el.style.transform = "";
      el.style.transformOrigin = "";

      if (savedPos.value) {
        await setWindowPos(savedPos.value.x, savedPos.value.y);
      }

      isRetracted.value = true;
      playEventSound("retract");
      log.debug("已收回");
    } else {
      const sz = getPopupSize();
      expectedSize.value = { w: sz.w, h: sz.h };
      ignoreResizeUntil = Date.now() + 3000;

      const isMinimized = await win.isMinimized();

      el.style.opacity = "0";
      await win.show();
      if (isMinimized) {
        await win.unminimize();
        await new Promise((r) => setTimeout(r, 150));
      }

      const pos = await invoke<{ win_x: number; win_y: number; cursor_x: number; cursor_y: number; scale_x: number; scale_y: number }>("compute_popup_position", { winW: sz.w, winH: sz.h });

      let targetX = pos.win_x, targetY = pos.win_y;
      let cursorX = pos.cursor_x, cursorY = pos.cursor_y;
      if (userConfig.popupMode === "fixed" && userConfig.fixedPosition) {
        targetX = userConfig.fixedPosition.x;
        targetY = userConfig.fixedPosition.y;
        cursorX = targetX + Math.round(sz.w / 2);
        cursorY = targetY + Math.round(sz.h / 2);
      }

      await setWindowSize(sz.w, sz.h);
      await new Promise((r) => setTimeout(r, 40));
      lastMovedPos.value = { x: targetX, y: targetY };
      ignoreResizeUntil = Date.now() + 3000;
      await setWindowPos(targetX, targetY);
      await new Promise((r) => setTimeout(r, 40));

      el.style.transformOrigin = `${cursorX - targetX}px ${cursorY - targetY}px`;

      await el.animate(
        [
          { transform: "scale(0)", opacity: "0" },
          { transform: "scale(1)", opacity: "1" },
        ],
        { duration: 350, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", fill: "forwards" }
      ).finished;

      el.style.transform = "";
      el.style.transformOrigin = "";
      el.style.opacity = "";

      isRetracted.value = false;
      setTimeout(() => chatRef.value?.focusInput(), 50);
      playEventSound("popup");
      log.debug("已弹出 | win:", { x: targetX, y: targetY }, "| cursor:", { x: cursorX, y: cursorY });
    }
  } catch (e) {
    log.error("快捷键切换失败", e);
  } finally {
    setTimeout(() => { isAnimating.value = false; }, 500);
  }
}

// ==========================================
// 快捷键注册/注销
// ==========================================
let currentShortcutStr = "";

function buildShortcutStr(): string {
  const k = userConfig.shortcutKey;
  const mods = isMacOS ? userConfig.shortcutMacModifiers : userConfig.shortcutWinModifiers;
  return [...mods, k].join("+");
}

async function registerShortcut() {
  try {
    currentShortcutStr = buildShortcutStr();
    if (await isRegistered(currentShortcutStr)) {
      await unregister(currentShortcutStr);
    }
    await register(currentShortcutStr, (event) => {
      if (event.state === "Pressed") handleShortcutToggle();
    });
    log.info(`全局快捷键已注册: ${currentShortcutStr}`);
  } catch (e) {
    log.warn("全局快捷键注册失败", e);
  }
}

async function unregisterShortcut() {
  try {
    if (currentShortcutStr) {
      await unregister(currentShortcutStr);
      log.debug("全局快捷键已注销");
    }
  } catch { /* ignore */ }
}

// ==========================================
// 右键菜单
// ==========================================
const ctxMenu = ref<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY, visible: true };
}

function copySelection() {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    navigator.clipboard.writeText(sel.toString()).catch(() => {});
  }
  ctxMenu.value.visible = false;
}

function hideCtxMenu() {
  ctxMenu.value.visible = false;
}

async function openDevTools() {
  ctxMenu.value.visible = false;
  invoke("open_devtools").catch(() => {});
}

// ==========================================
// 光标追踪 — 按 effectMode 条件注册
//
// off 的语义就是「不要这套机构」：不注册监听，Rust 派发的光标事件不进前端，
// globalCursor 这条响应式链也就不存在消费者。parallax / dof 才注册，行为与条件化之前一致。
// effectMode 是 CONFIG 字段、只能从设置页改，主窗口经 deskpet-settings-saved →
// reloadConfig() 拿到新值，所以挂载与每次设置保存后各重判一次注册态。
// ==========================================
type CursorMovePayload = {
  x: number; y: number;
  screen_x: number; screen_y: number; screen_w: number; screen_h: number;
};

let cursorEventCount = 0;
function onCursorMove(event: { payload: CursorMovePayload }): void {
  cursorEventCount++;
  globalCursor.value = { x: event.payload.x, y: event.payload.y };
  if (cursorEventCount % 120 === 0) {
    log.debug(`光标追踪 #${cursorEventCount} | 全局(${event.payload.x},${event.payload.y})`);
  }
}

/** 把注册态收敛到当前 effectMode 要求的形态；已在目标形态时不重复注册。 */
async function applyCursorTracker(): Promise<void> {
  try {
    if (cursorTrackerDisposed) return;
    const wanted = userConfig.effectMode !== "off";
    if (wanted && !cleanupCursorTracker) {
      const unlisten = await listen<CursorMovePayload>("deskpet-cursor-move", onCursorMove);
      // 注册是异步的：await 期间可能已卸载，那就当场注销，不留悬挂监听
      if (cursorTrackerDisposed) { unlisten(); return; }
      cleanupCursorTracker = unlisten;
      log.info("灵动图层光标追踪已就绪");
    } else if (!wanted && cleanupCursorTracker) {
      cleanupCursorTracker();
      cleanupCursorTracker = null;
      // 清掉陈旧坐标：切回 parallax/dof 时从「无光标」居中态起步，不会先跳到旧位置
      globalCursor.value = null;
      log.info("效果模式为 off，光标追踪已注销");
    }
  } catch (e) {
    log.warn("灵动图层光标追踪注册失败", e);
  }
}

/**
 * 触发一次注册态判定。串行执行 —— 两次快速保存不会并发注册出重复监听；
 * applyCursorTracker 自身消化异常，队列尾不会留 rejected promise 卡死后续判定。
 */
function syncCursorTracker(): Promise<void> {
  cursorTrackerQueue = cursorTrackerQueue.then(applyCursorTracker);
  return cursorTrackerQueue;
}

/** 卸载：先标记再注销；仍在 await 中的 listen 解析后会自行注销。 */
function disposeCursorTracker(): void {
  cursorTrackerDisposed = true;
  if (cleanupCursorTracker) {
    cleanupCursorTracker();
    cleanupCursorTracker = null;
  }
}

// ==========================================
// 生命周期
// ==========================================
onMounted(async () => {
  if (isWinSim) return;

  const win = getCurrentWebviewWindow();
  const savedSize = getPopupSize();
  log.info("从配置恢复: size=", savedSize, "mode=", userConfig.popupMode, "fixedPos=", userConfig.fixedPosition);

  expectedSize.value = { w: savedSize.w, h: savedSize.h };
  ignoreResizeUntil = Date.now() + 5000;

  await win.setSize(new LogicalSize(savedSize.w, savedSize.h));
  if (userConfig.popupMode === "fixed" && userConfig.fixedPosition) {
    const fp = userConfig.fixedPosition;
    await win.setPosition(new LogicalPosition(fp.x, fp.y));
    lastMovedPos.value = { x: fp.x, y: fp.y };
  }
  // 灵动图层：确保 lastMovedPos 有值
  if (!lastMovedPos.value) {
    const raw = await win.outerPosition();
    lastMovedPos.value = toLogicalPos({ x: raw.x, y: raw.y });
    log.debug("初始化 lastMovedPos:", lastMovedPos.value);
  }

  await initApp();

  invoke("set_monitor_config", {
    pollingIntervalMs: desktopConfig.pollingIntervalMs,
    pauseExtraMs: desktopConfig.pauseExtraMs,
    waitTimeoutMs: desktopConfig.waitTimeoutMs,
  }).catch(() => {});
  playEventSound("welcome");
  cleanupListener = await initWindowListener(winSize);

  await registerShortcut();

  // 灵动图层：按当前 effectMode 决定是否监听 Rust 光标追踪（off 不注册）
  await syncCursorTracker();

  // Dock 点击
  try {
    cleanupFocus = await getCurrentWebviewWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (focused && isRetracted.value && !isAnimating.value) {
          handleDockPopup();
        }
      }
    );
  } catch (e) {
    log.warn("窗口聚焦监听失败", e);
  }

  // 窗口拖动
  try {
    const win2 = getCurrentWebviewWindow();
    cleanupMoved = await win2.onMoved(({ payload: pos }) => {
      const lp = toLogicalPos({ x: pos.x, y: pos.y });
      if (isDraggingByUser.value || !lastMovedPos.value) {
        lastMovedPos.value = lp;
      }
      if (!isRetracted.value && !isAnimating.value) {
        emit("deskpet-moved", lp).catch(() => {});
      }
    });
  } catch { /* ignore */ }

  // 窗口缩放
  try {
    const win3 = getCurrentWebviewWindow();
    cleanupResized = await win3.onResized(({ payload: size }) => {
      const sz = toLogicalSize(size);
      const exp = expectedSize.value;
      const isProgrammatic = exp
        && Math.abs(sz.w - exp.w) <= 5
        && Math.abs(sz.h - exp.h) <= 5
        && Date.now() < ignoreResizeUntil;
      if (isProgrammatic) {
        emit("deskpet-resized", exp).catch(() => {});
        return;
      }
      if (!isRetracted.value && !isAnimating.value && sz.w <= 4000 && sz.h <= 4000) {
        userConfig.popupSize = sz;
        emit("deskpet-resized", sz).catch(() => {});
        log.debug("窗口缩放已保存:", sz);
      }
    });
  } catch { /* ignore */ }

  // 设置面板预览
  try {
    cleanupPreview = await listen<{ w: number; h: number }>("deskpet-preview-size", (event) => {
      setWindowSize(event.payload.w, event.payload.h);
      log.debug("预览大小:", event.payload);
    });
  } catch { /* ignore */ }

  // 设置面板保存
  try {
    cleanupSettingsSaved = await listen("deskpet-settings-saved", async () => {
      const previousAssistantMode = generalConfig.assistantMode;
      await reloadConfig();
      // 效果模式可能刚被改：紧跟配置刷新重判光标追踪的注册态，不拖到能力收敛之后
      await syncCursorTracker();
      const { initDebug } = await import("@/services/debug");
      await initDebug();
      await unregisterShortcut();
      await registerShortcut();
      // 配置快照变化不能复用旧 catalog；在飞回合仍持有自己的已冻结 prompt。
      const { invalidateSkillCatalog } = await import("@/services/skill");
      invalidateSkillCatalog("config");
      // 进入助手模式仍等下一轮对话预检按需加载；退出请求会等在飞 run settled，
      // 再释放 MCP 连接、助手工具和 Skill 元数据缓存。
      if (previousAssistantMode && !generalConfig.assistantMode) {
        const { requestConversationCapabilityMode } = await import("@/services/init");
        await requestConversationCapabilityMode("pet");
      }
      log.debug("配置缓存已刷新 + Debug状态已更新 + 快捷键已重注册 + 光标追踪已按 effectMode 同步");
    });
  } catch { /* ignore */ }

  document.addEventListener("click", hideCtxMenu);

  const rootEl = rootRef.value!;
  function onDragMouseDown(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.hasAttribute("data-tauri-drag-region") || t.closest("[data-tauri-drag-region]")) {
      isDraggingByUser.value = true;
    }
  }
  async function onDragMouseUp() {
    if (isDraggingByUser.value) {
      isDraggingByUser.value = false;
      if (lastMovedPos.value && !isRetracted.value && !isAnimating.value) {
        userConfig.fixedPosition = { x: lastMovedPos.value.x, y: lastMovedPos.value.y };
        emit("deskpet-moved", { x: lastMovedPos.value.x, y: lastMovedPos.value.y }).catch(() => {});
        log.debug("拖动已保存位置:", lastMovedPos.value);
      }
    }
  }
  rootEl.addEventListener("mousedown", onDragMouseDown);
  document.addEventListener("mouseup", onDragMouseUp);
  cleanupClick = () => {
    rootEl.removeEventListener("mousedown", onDragMouseDown);
    document.removeEventListener("mouseup", onDragMouseUp);
  };
});

onUnmounted(() => {
  stopMemoryConsolidationTimer()
  void import("@/services/tool/mcp").then(({ disconnectAllMcpServers }) => disconnectAllMcpServers())
  if (cleanupListener) cleanupListener();
  disposeCursorTracker();
  if (cleanupFocus) cleanupFocus();
  if (cleanupMoved) cleanupMoved();
  if (cleanupResized) cleanupResized();
  if (cleanupPreview) cleanupPreview();
  if (cleanupSettingsSaved) cleanupSettingsSaved();
  if (cleanupClick) cleanupClick();
  document.removeEventListener("click", hideCtxMenu);
  unregisterShortcut();
});
</script>

<template>
  <WinSim v-if="isWinSim" />
  <div v-else id="root" ref="rootRef" @contextmenu="onContextMenu">
    <TitleBar :height="30" title="配信中" @toggle-chat="showChat = !showChat" @toggle-settings="openSettings" @toggle-layer-editor="openLayerEditor" />
    <div id="body">
      <div id="stream-col">
        <img id="bg" :src="getUiUrl('windows/operation_base.png')" alt="" />
        <StreamView />
      </div>
      <div
        id="divider"
        :class="{ dragging: isDraggingDivider }"
        @mousedown="onDividerMousedown"
      ></div>
      <div id="chat-slot" :class="{ closed: !showChat, dragging: isDraggingDivider }" :style="showChat ? { width: chatWidth + 'px' } : {}">
        <SessionTabs
          v-show="showChat"
          @switch="onSessionSwitch"
          @new="onSessionNew"
          @close-tab="onSessionClose"
          @delete-session="onDeleteSession"
          @restore-session="onRestoreSession"
        />
        <ChatPanel v-show="showChat" ref="chatRef" @request-popup="onRequestPopup" />
      </div>
    </div>

    <Transition name="ctx-fade">
      <div
        v-if="ctxMenu.visible"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="copySelection">📋 复制</button>
        <button class="ctx-item" @click="openDevTools">🔧 控制台</button>
      </div>
    </Transition>

    <!-- services/dialog 的宿主：不挂它的话，主窗口里任何 showDialog/confirmDialog
         都会永远挂起（Promise 没有人 resolve）。SettingsPanel 那边另挂一份。 -->
    <AppDialog />
  </div>
</template>

<style>
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--color-contextmenu-bg);
  border: 1px solid var(--color-contextmenu-border);
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
  padding: 4px;
  min-width: 80px;
}
.ctx-item {
  display: block;
  width: 100%;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  color: var(--color-contextmenu-text);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--color-contextmenu-hover-bg);
  color: var(--color-contextmenu-hover-text);
}
.ctx-fade-enter-active, .ctx-fade-leave-active {
  transition: opacity 0.1s ease;
}
.ctx-fade-enter-from, .ctx-fade-leave-to {
  opacity: 0;
}
</style>
