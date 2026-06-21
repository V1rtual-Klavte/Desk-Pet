<script setup lang="ts">
import "./styles/fonts.css";
import "./styles/global.css";
import { ref, onMounted, onUnmounted } from "vue";
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
import { handleCommand } from "./services/command-handler";
import { initWindowListener } from "./services/window";
import { initChat, chatHistory, startMemoryConsolidationTimer, MemoryService, switchToSession, createNewSession, deleteSession, getSessions, getActiveSessionId, initWelcome } from "@/services/agent";
import { initRegistry } from "@/services/personality";
import { registerDefaultTools, registerAll } from "@/services/tool";
import { desktopConfig, shortcutConfig, userConfig, refreshUserCache, modeConfig } from "@/services/config";
import { isMacOS } from "@/services/env";
import { createLogger } from "@/services/logger";
import { playEventSound } from "@/services/audio/registry";
import { emit, listen } from "@tauri-apps/api/event";
import { initDebug } from "@/services/debug";

const log = createLogger("Shortcut");

const isWinSim = (() => {
  try { return getCurrentWebviewWindow().label === "windows-sim"; }
  catch { return false; }
})();

const showChat = ref(true);
const winSize = ref({ w: 0, h: 0 });
const streamRef = ref<InstanceType<typeof StreamView> | null>(null);
const chatRef = ref<InstanceType<typeof ChatPanel> | null>(null);
const tabsRef = ref<InstanceType<typeof SessionTabs> | null>(null);

// ── 可拖动分割线 ──
const DIVIDER_KEY = "deskpet_divider_pos";
const DEFAULT_CHAT_WIDTH = 220;
const MIN_CHAT_WIDTH = 120;
const MAX_CHAT_RATIO = 0.55; // 聊天面板最大占窗口55%

function loadDividerPos(): number {
  try {
    const v = localStorage.getItem(DIVIDER_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= MIN_CHAT_WIDTH) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_CHAT_WIDTH;
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
    try { localStorage.setItem(DIVIDER_KEY, String(chatWidth.value)); } catch { /* ignore */ }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onChatSend(text: string) {
  handleCommand(text, streamRef.value);
}

/** 切换会话 */
async function onSessionSwitch(session: { id: string; name: string }) {
  await switchToSession(session.id);
}

/** 新建会话 */
async function onSessionNew() {
  await createNewSession();
  initWelcome("Pちゃん！你终于来了！今天也要一直在一起哦～♡");
}

/** 归档/删除会话 */
async function onSessionArchive(sessionId: string) {
  await deleteSession(sessionId);
}

/** 收到新消息时自动弹出（如果已收回） */
function onRequestPopup() {
  if (isRetracted.value && !isAnimating.value) {
    handleShortcutToggle();
  }
}

/** 打开/聚焦设置窗口 */
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
  });
  // 延迟调用，等 Tauri 完成 alwaysOnTop 设置后再覆盖为更高层级
  setTimeout(() => {
    invoke("enhance_settings_window").catch(() => {});
  }, 300);
}

let cleanupListener: (() => void) | null = null;
let cleanupFocus: (() => void) | null = null;
let cleanupMoved: (() => void) | null = null;
let cleanupResized: (() => void) | null = null;
let cleanupPreview: (() => void) | null = null;
let cleanupSettingsSaved: (() => void) | null = null;
let cleanupExpression: (() => void) | null = null;

// ==========================================
// 快捷键召唤/收回
// ==========================================
const isRetracted = ref(false);
const isAnimating = ref(false);
const savedPos = ref<{ x: number; y: number } | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const isDraggingByUser = ref(false);
/** onMoved 追踪的最后已知窗口位置（和 setPosition 同一坐标系，避免 outerPosition 物理/逻辑坐标不一致） */
const lastMovedPos = ref<{ x: number; y: number } | null>(null);
/** 程序化 setSize 的目标值，onResized 回调中用它与实际尺寸对比，防止 DPI 取整反馈循环 */
const expectedSize = ref<{ w: number; h: number } | null>(null);
/** 时间戳：在此之前的所有 resize 事件视为程序化（不保存），防止 DPI 取整反馈循环 */
let ignoreResizeUntil = 0;

/** Tauri onResized/onMoved/outerPosition 返回物理像素，需转逻辑坐标 */
function toLogicalSize(p: { width: number; height: number }) {
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(p.width / dpr), h: Math.round(p.height / dpr) };
}
function toLogicalPos(p: { x: number; y: number }) {
  const dpr = window.devicePixelRatio || 1;
  return { x: Math.round(p.x / dpr), y: Math.round(p.y / dpr) };
}

/** 程序化设置窗口大小（记录目标值，1秒内 resize 事件全部忽略） */
async function setWindowSize(w: number, h: number) {
  expectedSize.value = { w, h };
  ignoreResizeUntil = Date.now() + 3000;
  const win = getCurrentWebviewWindow();
  await win.setSize(new LogicalSize(w, h));
}

/** 程序化设置窗口位置（显式记录 lastMovedPos，避免依赖异步 onMoved 事件时序） */
async function setWindowPos(x: number, y: number) {
  lastMovedPos.value = { x, y };
  const win = getCurrentWebviewWindow();
  await win.setPosition(new LogicalPosition(x, y));
}

/** 获取弹窗尺寸（用户设置优先，带合法性校验防止 DPI 污染数据扩散） */
function getPopupSize(): { w: number; h: number } {
  const sz = userConfig.popupSize;
  // 校验：超过屏幕 2 倍或小于最小值视为污染数据，回退默认
  const maxW = (window.screen.availWidth || 1920) * 2;
  const maxH = (window.screen.availHeight || 1080) * 2;
  if (sz.w < 50 || sz.h < 50 || sz.w > maxW || sz.h > maxH) {
    log.warn("弹窗尺寸数据异常，回退默认 448x272 | saved:", sz);
    return { w: 448, h: 272 };
  }
  return sz;
}

/** dock 点击或外部激活时：在光标所在屏幕中央弹出 */
async function handleDockPopup() {
  if (isAnimating.value) return;
  isAnimating.value = true;

  try {
    const win = getCurrentWebviewWindow();
    const el = rootRef.value!;
    const sz = getPopupSize();

    // 提前设 expectedSize + 时间窗口，保护 win.show() 触发的 resize 事件
    expectedSize.value = { w: sz.w, h: sz.h };
    ignoreResizeUntil = Date.now() + 3000;

    // 覆盖为屏幕中央
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
    // 延迟清除锁，等 setSize 触发的 resize 事件消化完（防止 DPI 尺寸漂移）
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
      // ── 收回（窗口可见 → 隐藏）──
      try {
        // 用 onMoved 追踪的位置（和 setPosition 同一坐标系，避免 outerPosition 的物理/逻辑坐标不一致）
        if (lastMovedPos.value) {
          savedPos.value = { ...lastMovedPos.value };
        } else {
          const raw = await win.outerPosition();
          savedPos.value = toLogicalPos({ x: raw.x, y: raw.y });
        }
        log.debug("更新家位置:", savedPos.value);
      } catch { /* ignore */ }

      const cursor = await invoke<{ x: number; y: number; screen_x: number; screen_y: number; screen_w: number; screen_h: number }>("get_cursor_position");
      // 用 onMoved 追踪的位置，和 cursor 同一坐标系
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
      // ── 弹出（窗口隐藏 → 可见）──
      const sz = getPopupSize();
      // 提前设 expectedSize + 时间窗口，保护 win.show() 触发的 resize 事件
      expectedSize.value = { w: sz.w, h: sz.h };
      ignoreResizeUntil = Date.now() + 3000;

      const isMinimized = await win.isMinimized();

      el.style.opacity = "0";
      await win.show();
      if (isMinimized) {
        await win.unminimize();
        await new Promise((r) => setTimeout(r, 150));
      }

      const pos = await invoke<{ win_x: number; win_y: number; cursor_x: number; cursor_y: number }>("compute_popup_position", { winW: sz.w, winH: sz.h });

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
    // 延迟清除锁，等 setSize 触发的 resize 事件消化完（防止 DPI 尺寸漂移）
    setTimeout(() => { isAnimating.value = false; }, 500);
  }
}

// ==========================================
// 快捷键注册/注销（支持录制时暂时禁用）
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
// 右键菜单（仅复制）
// ==========================================
const ctxMenu = ref<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });

function onContextMenu(e: MouseEvent) {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    e.preventDefault();
    ctxMenu.value = { x: e.clientX, y: e.clientY, visible: true };
  } else {
    e.preventDefault();
  }
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

// ==========================================
// 生命周期
// ==========================================
onMounted(async () => {
  if (isWinSim) return;

  // ── 从持久化配置恢复窗口尺寸和位置 ──
  const win = getCurrentWebviewWindow();
  const savedSize = getPopupSize();
  log.info("从配置恢复: size=", savedSize, "mode=", userConfig.popupMode, "fixedPos=", userConfig.fixedPosition);

  // 5秒保护窗口：启动期间所有 resize 事件都视为程序化，不保存到 popupSize
  expectedSize.value = { w: savedSize.w, h: savedSize.h };
  ignoreResizeUntil = Date.now() + 5000;

  await win.setSize(new LogicalSize(savedSize.w, savedSize.h));
  if (userConfig.popupMode === "fixed" && userConfig.fixedPosition) {
    const fp = userConfig.fixedPosition;
    await win.setPosition(new LogicalPosition(fp.x, fp.y));
    lastMovedPos.value = { x: fp.x, y: fp.y };
  }

  // 初始化人格模块
  initRegistry();

  // 注册轻量模式工具（file/read/list/search, bash(白名单), system.info, http.get）
  await registerDefaultTools();

  // 加载 Skill + MCP Mock 工具
  const { getSkillTools } = await import("@/services/tool/skill/loader")
  const { initSkillRegistry } = await import("@/services/tool/skill/registry")
  const { createMockMcpTools } = await import("@/services/tool/mcp/manager")
  initSkillRegistry()
  registerAll(getSkillTools())
  registerAll(createMockMcpTools())
  log.info("工具已就绪, 模式:", modeConfig.assistant ? "助手" : "轻量", "| 共", await import("@/services/tool/registry").then(m => m.toolCount()), "个")

  // 初始化 debug 状态 + 刷新工具统计
  await initDebug()

  // 开发模式加载测试套件

  // 开发模式加载测试套件
  if (import.meta.env.DEV) {
    import("@/services/test").then(() => {
      log.info("🧪 测试套件已就绪 — 输入 __test.all() 运行所有测试")
    })
  }

  invoke("set_monitor_config", {
    pollingIntervalMs: desktopConfig.pollingIntervalMs,
    pauseExtraMs: desktopConfig.pauseExtraMs,
    waitTimeoutMs: desktopConfig.waitTimeoutMs,
  }).catch(() => {});
  await MemoryService.init();
  await initChat("Pちゃん！你终于来了！今天也要一直在一起哦～♡");
  startMemoryConsolidationTimer();
  playEventSound("welcome");
  cleanupListener = await initWindowListener(streamRef, winSize);

  // 全局快捷键（使用用户配置）
  await registerShortcut();

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

  // 窗口拖动 → 只在用户拖拽时更新 lastMovedPos（程序化移动由 setWindowPos 显式设置）
  try {
    const win = getCurrentWebviewWindow();
    cleanupMoved = await win.onMoved(({ payload: pos }) => {
      const lp = toLogicalPos({ x: pos.x, y: pos.y });
      // 首次初始化 or 用户手动拖拽时更新
      if (isDraggingByUser.value || !lastMovedPos.value) {
        lastMovedPos.value = lp;
      }
      if (!isRetracted.value && !isAnimating.value) {
        emit("deskpet-moved", lp).catch(() => {});
      }
    });
  } catch { /* ignore */ }

  // 窗口缩放 → 用 expectedSize + 时间窗口双重判断程序化/用户缩放
  try {
    const win = getCurrentWebviewWindow();
    cleanupResized = await win.onResized(({ payload: size }) => {
      const sz = toLogicalSize(size);
      const exp = expectedSize.value;
      // 程序化: 实际值与目标值接近（±5px）且仍在时间窗口内 → 忽略不保存
      const isProgrammatic = exp
        && Math.abs(sz.w - exp.w) <= 5
        && Math.abs(sz.h - exp.h) <= 5
        && Date.now() < ignoreResizeUntil;
      if (isProgrammatic) {
        emit("deskpet-resized", exp).catch(() => {});
        return;
      }
      // 用户手动拖边缩放：保存（但有上限安全校验）
      if (!isRetracted.value && !isAnimating.value && sz.w <= 4000 && sz.h <= 4000) {
        userConfig.popupSize = sz;
        emit("deskpet-resized", sz).catch(() => {});
        log.debug("窗口缩放已保存:", sz);
      }
    });
  } catch { /* ignore */ }

  // 设置面板预览 → 接收目标尺寸并设置窗口（防止 DPI 反馈循环）
  try {
    cleanupPreview = await listen<{ w: number; h: number }>("deskpet-preview-size", (event) => {
      setWindowSize(event.payload.w, event.payload.h);
      log.debug("预览大小:", event.payload);
    });
  } catch { /* ignore */ }

  // 设置面板保存 → 清除主窗口的配置缓存（跨窗口同步）
  try {
    cleanupSettingsSaved = await listen("deskpet-settings-saved", async () => {
      refreshUserCache();
      const { initDebug } = await import("@/services/debug");
      await initDebug();
      await unregisterShortcut();
      await registerShortcut();
      log.debug("配置缓存已刷新 + Debug状态已更新 + 快捷键已重注册");
    });
  } catch { /* ignore */ }

  // ── 人格效果事件：expression → StreamView 表情（实时，贯穿 AgentLoop）──
  try {
    cleanupExpression = await listen<{ expression: string }>("deskpet-expression", (event) => {
      streamRef.value?.setExpression(event.payload.expression)
    })
  } catch { /* ignore */ }

  // 点击任意位置关闭右键菜单
  document.addEventListener("click", hideCtxMenu);

  // ── 用户手动拖动检测：只有手动拖动才保存位置 ──
  const rootEl = rootRef.value!;
  rootEl.addEventListener("mousedown", (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.hasAttribute("data-tauri-drag-region") || t.closest("[data-tauri-drag-region]")) {
      isDraggingByUser.value = true;
    }
  });
  document.addEventListener("mouseup", async () => {
    if (isDraggingByUser.value) {
      isDraggingByUser.value = false;
      if (lastMovedPos.value && !isRetracted.value && !isAnimating.value) {
        userConfig.fixedPosition = { x: lastMovedPos.value.x, y: lastMovedPos.value.y };
        emit("deskpet-moved", { x: lastMovedPos.value.x, y: lastMovedPos.value.y }).catch(() => {});
        log.debug("拖动已保存位置:", lastMovedPos.value);
      }
    }
  });
});

onUnmounted(() => {
  if (cleanupListener) cleanupListener();
  if (cleanupFocus) cleanupFocus();
  if (cleanupMoved) cleanupMoved();
  if (cleanupResized) cleanupResized();
  if (cleanupPreview) cleanupPreview();
  if (cleanupSettingsSaved) cleanupSettingsSaved();
  if (cleanupExpression) cleanupExpression();
  document.removeEventListener("click", hideCtxMenu);
  unregisterShortcut();
});
</script>

<template>
  <WinSim v-if="isWinSim" />
  <div v-else id="root" ref="rootRef" @contextmenu="onContextMenu">
    <TitleBar :height="30" title="配信中" @toggle-chat="showChat = !showChat" @toggle-settings="openSettings" />
    <div id="body">
      <div id="stream-col">
        <img id="bg" src="/assets/windows/operation_base.png" alt="" />
        <StreamView ref="streamRef" />
      </div>
      <!-- 可拖动分割线 -->
      <div
        id="divider"
        :class="{ dragging: isDraggingDivider }"
        @mousedown="onDividerMousedown"
      ></div>
      <div id="chat-slot" :class="{ closed: !showChat }" :style="showChat ? { width: chatWidth + 'px' } : {}">
        <SessionTabs
          v-show="showChat"
          ref="tabsRef"
          @switch="onSessionSwitch"
          @new="onSessionNew"
          @archive="onSessionArchive"
        />
        <ChatPanel v-show="showChat" ref="chatRef" @send="onChatSend" @request-popup="onRequestPopup" />
      </div>
    </div>

    <!-- 自定义右键菜单（仅复制） -->
    <Transition name="ctx-fade">
      <div
        v-if="ctxMenu.visible"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="copySelection">📋 复制</button>
      </div>
    </Transition>
  </div>
</template>

<style>
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: #3e1a2e;
  border: 1px solid #a01a5a;
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
  color: #f0e0f0;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.ctx-item:hover {
  background: #c4276f;
  color: #fff;
}
.ctx-fade-enter-active, .ctx-fade-leave-active {
  transition: opacity 0.1s ease;
}
.ctx-fade-enter-from, .ctx-fade-leave-to {
  opacity: 0;
}
</style>
