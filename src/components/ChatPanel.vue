<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from "vue";
import { chatHistory, sendMessage, getActiveSessionId, pushAssistantMessage, resumePausedInputs, stopActiveRun } from "@/services/agent";
import { playEventSound } from "@/services/audio/registry";
import { conversationConfig, userConfig } from "@/services/config";
import { getUiUrl } from "@/services/profile";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";
import { listen } from "@tauri-apps/api/event";
import {
  continueInterruptedRun,
  describeInputDelivery,
  discardInterruptedRun,
  getInterruptedRun,
  initSlashCommands,
  listQueuedInputs,
  searchSlashCommands,
  withdrawQueuedInput,
} from "@/services/engine";
import type { HarnessQueuedItem, InterruptedRunInfo, SlashMatch } from "@/services/engine";
import DebugBar from "./DebugBar.vue";
import PlanConfirm from "./PlanConfirm.vue";
import { confirmState, resolvePermissionConfirm } from "@/services/safety";
import { actionCategoryOf } from "@/services/tool";
import { getStagePrompt } from "@/services/personality";

// ★ 同步初始化 Slash 命令注册表（下拉补全用；命令执行只在 ingress，见 preProcess）
initSlashCommands();

const log = createLogger("ChatPanel");

const emit = defineEmits<{ send: [text: string]; "request-popup": [] }>();
const input = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);
const msgContainer = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);

/** 工具执行状态提示（agent-loop 事件驱动） */
const toolStatus = ref<{ text: string; visible: boolean }>({ text: "", visible: false });
let cleanupToolExec: (() => void) | null = null;
let cleanupToolDone: (() => void) | null = null;
const toolCompletedTimer = ref<ReturnType<typeof setTimeout> | null>(null);

/**
 * 流式正文的瞬时展示（H-3）：
 * - 只显示正文增量，RUNTIME_DATA 与 thinking 在运行内核侧已被过滤；
 * - 不写入 chatHistory，回合结束以既有提交路径推送的完整消息为准；
 * - 只属于当前会话，切走/切回后不显示旧会话的半截正文。
 */
const streamingText = ref("");
let cleanupStreamDelta: (() => void) | null = null;
let cleanupStreamEnd: (() => void) | null = null;
let cleanupRunState: (() => void) | null = null;

function handleStreamDelta(payload: { sessionId?: string; delta?: string }) {
  if (!payload.delta || payload.sessionId !== getActiveSessionId()) return;
  streamingText.value += payload.delta;
  nextTick(() => {
    if (isAtBottom.value) scrollToBottom();
    else { hasNewBelow.value = true; updateThumb(); }
  });
}

// ==========================================
// 输入意图与排队状态（PI-1）
// 排队视图与撤回都读 lane 持久 inbox 的只读快照，不在这里另存一份队列状态。
// ==========================================
const DELIVERY_LABELS = { steer: "插话", followUp: "稍后继续" } as const;
// nextRun 一律按「已暂停」呈现：无论是停止归还还是主动排队，它都要等下一次运行才被消费。
const QUEUE_KIND_LABELS = { steer: "插话", followUp: "稍后继续", nextRun: "已暂停" } as const;

/** 单条显式选择的投递意图；初值来自配置，空闲时两种方式都直接开始新回合。 */
const deliveryIntent = ref<"steer" | "followUp">(conversationConfig.defaultDelivery);
const intentOpen = ref(false);

const queuedItems = ref<HarnessQueuedItem[]>([]);
let previousQueuedIds: string[] = [];

/** 暂停项（停止归还的 nextRun）：面板给「继续处理 / 全部丢弃」两个显式动作。 */
const pausedItems = computed(() => queuedItems.value.filter(item => item.kind === "nextRun"));
const resuming = ref(false);

/**
 * 中断运行（崩溃恢复）：内核默认暂停，必须由用户显式选继续或丢弃。
 * 状态只在打开会话槽后才可读（中断态来自会话文件里的未完成操作），
 * 所以这里在挂载与会话切换时查询，不跟着每个运行事件轮询。
 */
const interrupted = ref<InterruptedRunInfo | undefined>(undefined);
const interruptedBusy = ref(false);

async function refreshInterrupted() {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    interrupted.value = undefined;
    return;
  }
  try {
    interrupted.value = await getInterruptedRun(sessionId);
  } catch (error) {
    log.warn("读取中断运行失败:", formatError(error));
    interrupted.value = undefined;
  } finally {
    // getInterruptedRun 会打开运行槽，队列镜像在开槽时才播种：这里补刷一次，
    // 覆盖「onMounted 先刷队列、后打开槽」的顺序缺口（本函数的调用点都不必再各自补刷）。
    refreshQueue();
  }
}

async function resolveInterrupted(action: "continue" | "discard") {
  const sessionId = getActiveSessionId();
  if (!sessionId || interruptedBusy.value) return;
  interruptedBusy.value = true;
  try {
    if (action === "continue") {
      const result = await continueInterruptedRun(sessionId);
      if (!result) {
        showDeliveryNote("没有可继续的中断运行");
      } else {
        // 续跑结果不经过 sendMessage 的提交路径：正文由这里补进界面，避免会话文件里有、界面没有。
        if (getActiveSessionId() === sessionId && result.reply) pushAssistantMessage(result.reply, sessionId);
        showDeliveryNote("已继续上次未完成的运行");
      }
    } else {
      const returned = await discardInterruptedRun(sessionId);
      if (!returned) {
        // 没有槽 = 没有可丢弃的中断运行：如实提示，不谎报「已丢弃」。
        showDeliveryNote("没有可丢弃的中断运行");
      } else {
        const paused = returned.steer.length + returned.followUp.length;
        showDeliveryNote(paused > 0 ? `已丢弃中断运行；${paused} 条未处理输入已暂停` : "已丢弃中断运行");
      }
    }
  } catch (error) {
    log.warn("处理中断运行失败:", formatError(error));
    showDeliveryNote("处理失败，请再试一次");
  } finally {
    interruptedBusy.value = false;
    await refreshInterrupted();
    refreshQueue();
  }
}

/** 显式继续：把暂停输入按原顺序投递成一次标准回合（没有暂停项时如实提示）。 */
async function resumePaused() {
  if (resuming.value) return;
  resuming.value = true;
  try {
    const result = await resumePausedInputs(getActiveSessionId());
    if (!result) showDeliveryNote("没有已暂停的输入");
    else if (result.outcome === "failed") showDeliveryNote("继续失败，请再试一次");
  } catch (error) {
    log.warn("继续暂停输入失败:", formatError(error));
    showDeliveryNote("继续失败，请再试一次");
  } finally {
    resuming.value = false;
    refreshQueue();
  }
}

/** 全部丢弃：逐条撤回暂停项；结果如实计数，不把部分成功报成全部成功。 */
async function discardPaused() {
  const sessionId = getActiveSessionId();
  const items = [...pausedItems.value];
  if (!sessionId || items.length === 0) return;
  let cancelled = 0;
  for (const item of items) {
    const kind = await withdrawQueuedInput(sessionId, item.entryId);
    if (kind === "cancelled") {
      cancelled++;
      previousQueuedIds = previousQueuedIds.filter(id => id !== item.entryId);
    }
  }
  refreshQueue();
  showDeliveryNote(cancelled === items.length ? "已丢弃全部暂停消息" : `已丢弃 ${cancelled}/${items.length} 条暂停消息`);
}

/**
 * 运行态与停止入口（PI-1）：running 来自 lane 快照的只读视图，不由事件负载自行维护；
 * deskpet-run-state 事件只是「现在该刷新了」的通知（运行开始/收尾）。
 */
const runRunning = ref(false);
const stopping = ref(false);

async function stopRun() {
  const sessionId = getActiveSessionId();
  if (!sessionId || stopping.value) return;
  stopping.value = true;
  try {
    const stopped = await stopActiveRun(sessionId);
    // 没有在飞运行时如实告知：不假装「正在停止」，也不留下停止中的按钮。
    if (!stopped) {
      stopping.value = false;
      showDeliveryNote("当前没有正在进行的回复");
    }
  } catch (error) {
    stopping.value = false;
    log.warn("停止运行失败:", formatError(error));
    showDeliveryNote("停止失败，请再试一次");
  }
}

/** 单条状态提示（投递回执/撤回结果/已加入本次对话），短暂展示，不落盘。 */
const deliveryNote = ref("");
let deliveryNoteTimer: ReturnType<typeof setTimeout> | null = null;
function showDeliveryNote(text: string) {
  deliveryNote.value = text;
  if (deliveryNoteTimer) clearTimeout(deliveryNoteTimer);
  deliveryNoteTimer = setTimeout(() => {
    if (deliveryNote.value === text) deliveryNote.value = "";
  }, 4000);
}

const DELIVERY_NOTES: Record<"steered" | "followup" | "deferred", string> = {
  steered: "已排队插话：当前响应结束后处理",
  followup: "已排队稍后继续：当前任务结束后继续",
  deferred: "已排队：下一次运行处理",
};

function chooseIntent(intent: "steer" | "followUp") {
  deliveryIntent.value = intent;
  intentOpen.value = false;
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/** 读 lane 快照刷新排队视图；离开列表且仍在下一次运行 = 已被消费（已进入对话）。 */
function refreshQueue() {
  const view = listQueuedInputs(getActiveSessionId());
  // 运行态与排队项同源（同一个只读快照）：切会话/事件通知都只走这一条刷新路径。
  runRunning.value = view.running;
  const ids = view.items.map(item => item.entryId);
  if (view.running) {
    // 只看运行中的会话：队列项离开 inbox 说明已被消费成正文（撤回路径已先摘除记录）。
    const consumed = previousQueuedIds.filter(id => !ids.includes(id));
    if (consumed.length > 0) showDeliveryNote("已加入本次对话");
  }
  previousQueuedIds = ids;
  queuedItems.value = view.items;
}

async function withdraw(item: HarnessQueuedItem) {
  const sessionId = getActiveSessionId();
  if (!sessionId) return;
  const kind = await withdrawQueuedInput(sessionId, item.entryId);
  // 撤回不是「被消费」：先摘掉本地记录，避免刷新时误报“已加入本次对话”。
  previousQueuedIds = previousQueuedIds.filter(id => id !== item.entryId);
  refreshQueue();
  if (kind !== "already_consumed") {
    showDeliveryNote(
      kind === "cancelled" ? "已撤回排队消息"
        : kind === "not_found" ? "这条排队消息已不在队列中"
          : "撤回失败：运行槽不可用",
    );
    return;
  }
  // 已被消费：按投递证据说清走到哪一档，不把「已进入请求」说成「已回复」。
  const lookup = item.requestId ? await describeInputDelivery(sessionId, item.requestId) : undefined;
  const stage = lookup?.ok ? lookup.evidence?.stage : undefined;
  showDeliveryNote(
    lookup && !lookup.ok ? "这条消息已被消费，无法撤回（投递状态读取失败，无法确认进度）"
      : stage === "responded" ? "这条消息已进入请求并拿到回复，无法撤回"
        : stage === "request_prepared" ? "这条消息已进入请求，无法撤回"
          : "这条消息已加入对话，无法撤回",
  );
}

function closeIntentMenu() { intentOpen.value = false; }

// ==========================================
// Slash 命令下拉框
// ==========================================
const slashResults = ref<SlashMatch[]>([]);
const slashSelectedIndex = ref(0);
const slashVisible = ref(false);
const slashDropdownRef = ref<HTMLElement | null>(null);
const slashSuppress = ref(false);  // 补全后抑制一次下拉弹出

// ★ 选中项变化时自动逐项滚动到可见区域
watch(slashSelectedIndex, () => {
  nextTick(() => {
    const dropdown = slashDropdownRef.value;
    if (!dropdown) return;
    const activeItem = dropdown.querySelector("li.active") as HTMLElement | null;
    if (!activeItem) return;
    const listTop = dropdown.scrollTop;
    const listBottom = listTop + dropdown.clientHeight;
    const itemTop = activeItem.offsetTop;
    const itemBottom = itemTop + activeItem.offsetHeight;
    if (itemTop < listTop) {
      dropdown.scrollTo({ top: itemTop, behavior: "smooth" });
    } else if (itemBottom > listBottom) {
      dropdown.scrollTo({ top: itemBottom - dropdown.clientHeight, behavior: "smooth" });
    }
  });
});

function updateSlashDropdown() {
  const text = input.value;
  // ★ 补全后抑制重新弹出，让用户能直接回车发送
  if (slashSuppress.value) {
    slashSuppress.value = false;
    return;
  }
  if (text.startsWith("/")) {
    const partial = text.slice(1);
    slashResults.value = searchSlashCommands(partial);
    slashVisible.value = slashResults.value.length > 0;
    slashSelectedIndex.value = 0;
    // ★ 重置滚动位置到顶部（默认选中第一项）
    nextTick(() => {
      const dropdown = slashDropdownRef.value;
      if (dropdown) dropdown.scrollTop = 0;
    });
  } else {
    slashVisible.value = false;
    slashResults.value = [];
  }
}

// ★ watch 监听输入变化（v-model 更新后触发，保证读到最新值）
watch(input, updateSlashDropdown);

/** 自动补全：将当前选中命令填入输入框（不执行，用户可再按 Enter 执行） */
function autofillSlashCommand(match: SlashMatch) {
  slashVisible.value = false;
  slashSuppress.value = true;  // ★ 抑制 watch 重新弹出下拉
  input.value = "/" + match.command.name;
  // 光标移到末尾
  nextTick(() => {
    const el = inputRef.value;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
}

/** 供父组件调用：弹出时聚焦输入框 */
function focusInput() {
  nextTick(() => {
    inputRef.value?.focus();
  });
}
defineExpose({ focusInput });

// 是否在底部、是否有新消息在下方
const isAtBottom = ref(true);
const hasNewBelow = ref(false);

// ==========================================
// 滚动逻辑
// ==========================================
function checkBottom() {
  const el = msgContainer.value;
  if (!el) return;
  isAtBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  if (isAtBottom.value) hasNewBelow.value = false;
  updateThumb();
}

function scrollToBottom() {
  const el = msgContainer.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  isAtBottom.value = true;
  hasNewBelow.value = false;
  nextTick(updateThumb);
}

// 监听 chatHistory 变化 → 新消息来了
watch(
  () => chatHistory.length,
  (newLen, oldLen) => {
    nextTick(() => {
      if (newLen > (oldLen ?? 0) && chatHistory[chatHistory.length - 1]?.role === "assistant") {
        const isFirst = (oldLen ?? 0) === 0;
        if (!isFirst) playEventSound("reply");
        if (!isFirst && userConfig.autoPopupOnMessage) {
          emit("request-popup");
        }
      }
      if (isAtBottom.value) {
        scrollToBottom();
      } else {
        hasNewBelow.value = true;
        updateThumb();
      }
    });
  }
);

// ==========================================
// 自定义滚动条
// ==========================================
const thumbTop = ref(0);
const thumbHeight = ref(20);
const dragging = ref(false);
let dragStartY = 0;
let dragStartScroll = 0;

function updateThumb() {
  const el = msgContainer.value;
  if (!el) return;
  const ratio = el.clientHeight / el.scrollHeight;
  thumbHeight.value = Math.max(ratio * el.clientHeight, 20);
  const maxTop = el.clientHeight - thumbHeight.value;
  const scrollRatio = el.scrollTop / (el.scrollHeight - el.clientHeight || 1);
  thumbTop.value = scrollRatio * maxTop;
}

function onTrackClick(e: MouseEvent) {
  const el = msgContainer.value;
  const track = e.currentTarget as HTMLElement;
  if (!el) return;
  const rect = track.getBoundingClientRect();
  const y = e.clientY - rect.top - thumbHeight.value / 2;
  const ratio = y / (track.clientHeight - thumbHeight.value);
  el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
}

function onThumbDown(e: MouseEvent) {
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartScroll = msgContainer.value?.scrollTop ?? 0;
  document.addEventListener("mousemove", onThumbMove);
  document.addEventListener("mouseup", onThumbUp);
}

function onThumbMove(e: MouseEvent) {
  const el = msgContainer.value;
  const track = thumb.value?.parentElement;
  if (!el || !track) return;
  const deltaY = e.clientY - dragStartY;
  const trackH = track.clientHeight - thumbHeight.value;
  const scrollH = el.scrollHeight - el.clientHeight;
  if (trackH <= 0 || scrollH <= 0) return;
  const ratio = deltaY / trackH;
  el.scrollTop = Math.max(0, Math.min(dragStartScroll + ratio * scrollH, scrollH));
}

function onThumbUp() {
  dragging.value = false;
  document.removeEventListener("mousemove", onThumbMove);
  document.removeEventListener("mouseup", onThumbUp);
}

// ── IME 输入法状态追踪 ──
const composing = ref(false);
function onCompositionStart() { composing.value = true; }
function onCompositionEnd() { composing.value = false; }

// ==========================================
// 发送消息
// ==========================================
async function send() {
  const t = input.value.trim();
  if (!t) return;

  input.value = "";
  slashVisible.value = false;
  intentOpen.value = false;
  emit("send", t);
  playEventSound("send");
  // Slash 命令一律交给 ingress（preProcess）执行，这里不再保留第二条执行路径；
  // 未注册的 / 文本由 ingress 透传 AI。显式意图只作用于普通消息（slash 文本按次轮排队）。
  const result = await sendMessage(t, { delivery: t.startsWith("/") ? undefined : deliveryIntent.value });
  if (result.delivery) showDeliveryNote(DELIVERY_NOTES[result.delivery]);
  refreshQueue();
  scrollToBottom();
}

function key(e: KeyboardEvent) {
  // IME 输入中不触发
  if (composing.value || e.isComposing || e.keyCode === 229) return;

  // ── 下拉框键盘导航 ──
  if (slashVisible.value && slashResults.value.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelectedIndex.value = (slashSelectedIndex.value + 1) % slashResults.value.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelectedIndex.value = (slashSelectedIndex.value - 1 + slashResults.value.length) % slashResults.value.length;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const selected = slashResults.value[slashSelectedIndex.value];
      if (selected) autofillSlashCommand(selected);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      slashVisible.value = false;
      return;
    }
    // Tab 键补全
    if (e.key === "Tab") {
      e.preventDefault();
      const selected = slashResults.value[slashSelectedIndex.value];
      if (selected) autofillSlashCommand(selected);
      return;
    }
  }

  // ── 普通发送 ──
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // 如果下拉框正好打开但无结果，Enter 仍尝试作为 slash 命令执行
    send();
  }
}

onMounted(async () => {
  scrollToBottom();
  checkBottom();
  refreshQueue();
  void refreshInterrupted();

  // ── 工具执行状态监听 ──
  // 注册失败一律 error 级留痕（FIX-04 口径：事件监听注册失败 = 静默行为变化，不是可忽略的降级）。
  listen<{ toolName: string }>("tool-executing", (event) => {
    // 过程提示语来自当前 Card 的阶段文案（按工具类别匹配），界面不写死。
    const hint = getStagePrompt("executing", actionCategoryOf(event.payload.toolName))
    toolStatus.value = { text: hint, visible: true }
  }).then(fn => { cleanupToolExec = fn }).catch(error => log.error("事件监听注册失败，工具状态不再更新:", formatError(error)))
  listen<{ toolName: string; success: boolean }>("tool-completed", (event) => {
    // 成功 → done、失败 → blocked：Card 只为工具结果生成这两族文案（error 是非工具阶段、无类别维度）。
    const category = actionCategoryOf(event.payload.toolName)
    const hint = getStagePrompt(event.payload.success ? "done" : "blocked", category)
    toolStatus.value = { text: hint, visible: true }
    // 工具结束是排队项消费/释放的常见时点，顺带刷新排队视图。
    refreshQueue()
    toolCompletedTimer.value = setTimeout(() => { if (toolStatus.value.text === hint) toolStatus.value.visible = false }, 2500)
  }).then(fn => { cleanupToolDone = fn }).catch(error => log.error("事件监听注册失败，工具完成状态不再更新:", formatError(error)))

  // ── 流式正文（运行内核 message_update → 事件通道）──
  listen<{ sessionId?: string; delta?: string }>("deskpet-assistant-stream", (event) => {
    handleStreamDelta(event.payload)
  }).then(fn => { cleanupStreamDelta = fn }).catch(error => log.error("事件监听注册失败，流式正文不再显示:", formatError(error)))
  listen<{ sessionId?: string }>("deskpet-assistant-stream-end", (event) => {
    // 真实消息由既有提交路径推送；这里只清掉不会再更新的瞬时文本。
    if (event.payload.sessionId === getActiveSessionId()) streamingText.value = ""
    // 消息边界是 lane 消费排队项的时点：刷新后离开列表的项即可报告「已加入本次对话」。
    refreshQueue()
  }).then(fn => { cleanupStreamEnd = fn }).catch(error => log.error("事件监听注册失败，流式结束不清屏:", formatError(error)))

  // ── 运行态（停止按钮）──
  listen<{ sessionId?: string; running?: boolean }>("deskpet-run-state", (event) => {
    if (event.payload.sessionId !== getActiveSessionId()) return
    if (event.payload.running === false) stopping.value = false
    // 运行开始/收尾都按 lane 快照刷新：按钮与排队视图同源，不靠事件负载记账。
    refreshQueue()
  }).then(fn => { cleanupRunState = fn }).catch(error => {
    log.error("事件监听注册失败，运行态与停止按钮不刷新:", formatError(error))
    // 这一条最要紧：没有它用户既看不到「正在生成」，也拿不到停止按钮。复用既有的工具状态提示位
    // 如实说明（决策 §7 #35：不新增常驻降级提示位、不引入轮询）。
    toolStatus.value = { text: "运行状态监听未启动，请重启界面", visible: true }
  })

  // 意图菜单点击外部关闭
  document.addEventListener("click", closeIntentMenu)
});

// 切换会话不显示上一会话的半截流式正文与排队视图。
watch(() => getActiveSessionId(), () => {
  streamingText.value = ""
  previousQueuedIds = []
  deliveryNote.value = ""
  refreshQueue()
  void refreshInterrupted()
});

onUnmounted(() => {
  if (cleanupToolExec) cleanupToolExec()
  if (cleanupToolDone) cleanupToolDone()
  if (cleanupStreamDelta) cleanupStreamDelta()
  if (cleanupStreamEnd) cleanupStreamEnd()
  if (cleanupRunState) cleanupRunState()
  if (toolCompletedTimer.value) clearTimeout(toolCompletedTimer.value)
  if (deliveryNoteTimer) clearTimeout(deliveryNoteTimer)
  document.removeEventListener("click", closeIntentMenu)
});
</script>

<template>
  <div id="chat">
    <img class="cbg" :src="getUiUrl('windows/tinder_match.png')" alt="" draggable="false" />

    <!-- 消息区 + 滚动条容器 -->
    <div id="ch-body">
      <div id="ch-msgs" ref="msgContainer" @scroll="checkBottom">
        <div v-for="m in chatHistory" :key="m.id" class="cm" :class="m.role">
          <span class="cn">{{ m.role === "system" ? "📋" : m.role === "assistant" ? "糖糖" : "你" }}</span>
          <span class="ct">{{ m.text }}</span>
        </div>
        <!-- 流式正文：只做瞬时展示，回合结束后由提交路径推送的完整消息取代 -->
        <div v-if="streamingText" class="cm assistant stream">
          <span class="cn">糖糖</span>
          <span class="ct">{{ streamingText }}<span class="ct-cursor">▍</span></span>
        </div>
      </div>

      <!-- 自定义滚动条 -->
      <div
        v-if="thumbHeight < (msgContainer?.clientHeight ?? 0)"
        id="ch-scrollbar"
        @click="onTrackClick"
      >
        <div
          ref="thumb"
          id="ch-thumb"
          :style="{ top: thumbTop + 'px', height: thumbHeight + 'px' }"
          :class="{ dragging: dragging }"
          @mousedown.prevent="onThumbDown"
        />
      </div>

      <!-- 跳到底部按钮 -->
      <button
        v-if="hasNewBelow"
        id="ch-jump"
        @click="scrollToBottom()"
      >
        ↓ 新消息
      </button>
    </div>

    <!-- 工具执行状态提示 -->
    <Transition name="tool-status-fade">
      <div v-if="toolStatus.visible" id="ch-tool-status">
        🔧 {{ toolStatus.text }}
      </div>
    </Transition>

    <!-- 中断运行（崩溃恢复）：内核默认暂停，继续/丢弃由用户显式决定 -->
    <div v-if="interrupted" id="ch-interrupted">
      <span id="ch-interrupted-text">上次运行中断啦，还有一次没跑完的运行在等你决定～</span>
      <div id="ch-interrupted-actions">
        <button type="button" class="ch-queue-action" :disabled="interruptedBusy" @click="resolveInterrupted('continue')">
          {{ interruptedBusy ? "处理中…" : "继续" }}
        </button>
        <button type="button" class="ch-queue-action" :disabled="interruptedBusy" @click="resolveInterrupted('discard')">丢弃</button>
      </div>
    </div>

    <!-- 排队视图：lane 持久 inbox 的只读快照（含停止归还的 nextRun 项），单项可撤回 -->
    <div v-if="queuedItems.length" id="ch-queue">
      <div id="ch-queue-head">排队中 · {{ queuedItems.length }}</div>
      <div v-for="item in queuedItems" :key="item.entryId" class="ch-queue-row">
        <span class="ch-queue-kind">{{ QUEUE_KIND_LABELS[item.kind] }}</span>
        <span class="ch-queue-text">{{ previewText(item.text) }}</span>
        <button class="ch-queue-withdraw" @click="withdraw(item)">撤回</button>
      </div>
      <!-- 暂停项：用户显式决定继续或丢弃；不假装拦住了「发新消息顺带处理」的内核语义 -->
      <div v-if="pausedItems.length" id="ch-queue-paused">
        <span id="ch-queue-paused-hint">{{ pausedItems.length }} 条已暂停，发新消息会先处理它们</span>
        <div id="ch-queue-paused-actions">
          <button type="button" class="ch-queue-action" :disabled="resuming" @click="resumePaused">
            {{ resuming ? "继续中…" : "继续处理" }}
          </button>
          <button type="button" class="ch-queue-action" @click="discardPaused">全部丢弃</button>
        </div>
      </div>
    </div>

    <!-- 单条状态提示：投递回执、撤回结果、已加入本次对话 -->
    <Transition name="tool-status-fade">
      <div v-if="deliveryNote" id="ch-delivery-note">{{ deliveryNote }}</div>
    </Transition>

    <!-- 计划确认面板 -->
    <PlanConfirm />

    <div id="ch-foot">
      <!-- 输入框容器（相对定位，供下拉框定位） -->
      <div id="ch-input-wrap">
        <textarea
          ref="inputRef"
          v-model="input"
          placeholder="消息... 输入 / 查看命令"
          @keydown="key"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          rows="1"
        />

        <!-- ★ Slash 命令下拉框 -->
        <Transition name="slash-drop">
          <ul v-if="slashVisible" ref="slashDropdownRef" id="slash-dropdown">
            <li
              v-for="(item, idx) in slashResults"
              :key="item.command.name"
              :class="{ active: idx === slashSelectedIndex }"
              @mouseenter="slashSelectedIndex = idx"
              @mousedown.prevent="autofillSlashCommand(item)"
            >
              <span class="slash-name">/{{ item.command.name }}</span>
              <span class="slash-desc">{{ item.command.description }}</span>
            </li>
          </ul>
        </Transition>
      </div>
      <!-- 输入意图选择：忙碌时决定这条消息是插话还是稍后再继续；空闲时都直接开始新回合 -->
      <div id="ch-intent-wrap">
        <button
          id="ch-intent-btn"
          type="button"
          :title="`投递方式：${DELIVERY_LABELS[deliveryIntent]}`"
          @click.stop="intentOpen = !intentOpen"
        >
          {{ DELIVERY_LABELS[deliveryIntent] }} ▾
        </button>
        <Transition name="slash-drop">
          <div v-if="intentOpen" id="ch-intent-menu">
            <button type="button" class="ch-intent-item" :class="{ active: deliveryIntent === 'steer' }" @click.stop="chooseIntent('steer')">
              <span class="ch-intent-name">插话</span>
              <span class="ch-intent-desc">当前响应结束后处理</span>
            </button>
            <button type="button" class="ch-intent-item" :class="{ active: deliveryIntent === 'followUp' }" @click.stop="chooseIntent('followUp')">
              <span class="ch-intent-name">稍后继续</span>
              <span class="ch-intent-desc">当前任务结束后继续</span>
            </button>
            <div class="ch-intent-hint">空闲时两种方式都直接开始新回合</div>
          </div>
        </Transition>
      </div>
      <!-- 停止入口：运行中才出现，取消当前会话的运行并等待工具收尾（不暗示已撤销写入） -->
      <button v-if="runRunning" id="ch-stop" type="button" :disabled="stopping" @click="stopRun">
        {{ stopping ? "停止中…" : "停止" }}
      </button>
      <button @click="send" :disabled="!input.trim()">发送</button>
    </div>

    <!-- 安全确认弹窗 -->
    <Transition name="confirm-fade">
      <div v-if="confirmState.pending" id="ch-confirm-overlay">
        <div id="ch-confirm-box">
          <div id="ch-confirm-msg">{{ confirmState.pending.message }}</div>
          <div v-if="confirmState.pending.parameterSummary" id="ch-confirm-params">{{ confirmState.pending.parameterSummary }}</div>
          <div id="ch-confirm-btns">
            <button class="ch-confirm-btn ch-confirm-deny" @click="resolvePermissionConfirm('deny')">✕ 拒绝</button>
            <button class="ch-confirm-btn" @click="resolvePermissionConfirm('allow_once')">本次允许</button>
            <button class="ch-confirm-btn ch-confirm-ok" @click="resolvePermissionConfirm('allow_session')">会话内允许</button>
          </div>
        </div>
      </div>
    </Transition>

    <DebugBar />
  </div>
</template>

<style scoped>
#chat {
  width: 100%; height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: var(--color-surface-darker);
}
.cbg {
  position: absolute;
  width: 100%; height: 100%;
  object-fit: cover;
  pointer-events: none;
  z-index: 0;
  opacity: 0.15;
}

/* --- 消息区 + 滚动条 --- */
#ch-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  overflow: hidden;
}

#ch-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  user-select: text;
  -webkit-user-select: text;
}
#ch-msgs::-webkit-scrollbar { display: none; }
#ch-msgs { scrollbar-width: none; }

#ch-scrollbar {
  width: 6px;
  flex-shrink: 0;
  background: var(--color-scrollbar-track);
  position: relative;
  cursor: pointer;
}
#ch-thumb {
  position: absolute;
  width: 100%;
  border-radius: 3px;
  background: var(--color-scrollbar-thumb);
  transition: background 0.15s;
}
#ch-thumb:hover { background: var(--color-scrollbar-thumb-hover); }
#ch-thumb.dragging { background: var(--color-scrollbar-thumb-drag); }

#ch-jump {
  position: absolute;
  bottom: 4px;
  right: 10px;
  z-index: 2;
  padding: 3px 10px;
  font-size: 10px;
  font-family: inherit;
  color: var(--color-tab-active-text);
  background: var(--color-accent);
  border: none;
  border-radius: 12px;
  cursor: pointer;
  opacity: 0.9;
  animation: pulse-jump 1.5s ease infinite;
}
#ch-jump:hover { background: var(--color-accent-hover); }

@keyframes pulse-jump {
  0%, 100% { box-shadow: 0 0 0 0 var(--color-accent-light); }
  50% { box-shadow: 0 0 6px 4px var(--color-accent-shadow); }
}

/* --- 消息条目 --- */
.cm { display: flex; flex-direction: column; gap: 1px; font-size: clamp(9px, 2.5vw, 15px); line-height: 1.4; }
.cm.user { align-items: flex-end; }
.cm.assistant { align-items: flex-start; }
.cn { font-size: clamp(8px, 2.2vw, 12px); color: var(--color-text-pink); }
.cm.user .cn { color: #90d0ff; }
.ct { color: var(--color-text-bright); word-break: break-word; padding: 4px 8px; border-radius: 12px; max-width: 95%; font-size: clamp(9px, 2.5vw, 15px); }
.cm.user .ct { background: var(--color-border-light); }
.cm.assistant .ct { background: var(--color-surface-dark); }

/* 流式正文：半透明 + 光标，区别未提交内容 */
.cm.stream .ct { background: var(--color-surface-dark); opacity: 0.75; }
.ct-cursor { margin-left: 1px; animation: stream-cursor 1s steps(2, start) infinite; }
@keyframes stream-cursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

/* ── 系统消息（斜杠命令输出）── */
.cm.system { align-items: stretch; }
.cm.system .cn { color: #9080a0; font-size: clamp(10px, 2.5vw, 14px); }
.cm.system .ct {
  background: var(--color-system-msg-bg);
  border: 1px solid var(--color-system-msg-border);
  font-family: var(--font-mono);
  font-size: clamp(8px, 2vw, 12px);
  white-space: pre-wrap;
  line-height: 1.5;
  max-width: 100%;
}

/* --- 输入区 --- */
#ch-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  background: var(--color-surface-dark);
  border-top: 1px solid var(--color-border-light);
  flex-shrink: 0;
}

#ch-input-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}

#ch-foot textarea {
  width: 100%;
  min-width: 0;
  background: var(--color-surface-darker);
  border: 1px solid var(--color-border-input);
  border-radius: 12px;
  padding: 5px 10px;
  color: var(--color-text-bright);
  font-size: clamp(9px, 2.2vw, 13px);
  font-family: inherit;
  outline: none;
  resize: none;
  box-sizing: border-box;
}
#ch-foot textarea:focus { border-color: var(--color-accent); }
#ch-foot textarea::placeholder { color: var(--color-text-muted); }
#ch-foot button {
  padding: 5px 12px;
  background: var(--color-accent);
  color: var(--color-tab-active-text);
  border: none;
  border-radius: 16px;
  cursor: pointer;
  font-size: clamp(9px, 2.2vw, 13px);
  font-family: inherit;
  flex-shrink: 0;
  white-space: nowrap;
}
#ch-foot button:hover { background: var(--color-accent-hover); }
#ch-foot button:disabled { background: var(--color-border-light); color: var(--color-text-muted); cursor: default; }
/* 停止是打断而不是危险操作：不借用强调色，避免和「发送」争视觉重心 */
#ch-foot #ch-stop { background: var(--color-surface-darker); color: var(--color-text-pink); border: 1px solid var(--color-border-input); }
#ch-foot #ch-stop:hover { background: var(--color-surface-dark); }

/* ── 工具执行状态提示 ── */
#ch-tool-status {
  position: relative;
  z-index: 2;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--color-text-pink);
  background: var(--color-tool-status-bg);
  border-top: 1px solid var(--color-tool-status-border);
  text-align: center;
  flex-shrink: 0;
}
.tool-status-fade-enter-active { transition: opacity 0.2s ease; }
.tool-status-fade-leave-active { transition: opacity 0.5s ease; }
.tool-status-fade-enter-from, .tool-status-fade-leave-to { opacity: 0; }

/* ── 排队视图 ── */
#ch-queue {
  position: relative;
  z-index: 2;
  padding: 4px 8px 5px;
  background: var(--color-tool-status-bg);
  border-top: 1px solid var(--color-tool-status-border);
  flex-shrink: 0;
  max-height: 92px;
  overflow-y: auto;
}
#ch-queue-head {
  font-size: 10px;
  color: var(--color-text-pink);
  margin-bottom: 3px;
}
.ch-queue-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.5;
}
.ch-queue-kind {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--color-border-light);
  color: var(--color-text-bright);
}
.ch-queue-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}
.ch-queue-withdraw {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 10px;
  font-family: inherit;
  color: var(--color-text-bright);
  background: var(--color-surface-darker);
  border: 1px solid var(--color-border-input);
  border-radius: 10px;
  cursor: pointer;
}
.ch-queue-withdraw:hover { background: var(--color-border-light); }

/* ── 中断运行决策条（崩溃恢复的继续 / 丢弃）── */
#ch-interrupted {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-top: 1px solid var(--color-border-light);
  background: var(--color-surface-dark);
}
#ch-interrupted-text { font-size: 10px; color: var(--color-text-pink); }
#ch-interrupted-actions { display: flex; gap: 4px; flex: 0 0 auto; }

/* ── 暂停项的操作条（继续 / 全部丢弃）── */
#ch-queue-paused {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 5px;
  border-top: 1px dashed var(--color-border-light);
}
#ch-queue-paused-hint { font-size: 10px; color: var(--color-text-muted); }
#ch-queue-paused-actions { display: flex; gap: 4px; flex: 0 0 auto; }
.ch-queue-action {
  padding: 2px 8px;
  background: var(--color-surface-darker);
  color: var(--color-text-bright);
  border: 1px solid var(--color-border-input);
  border-radius: 10px;
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
}
.ch-queue-action:hover { background: var(--color-surface-dark); }
.ch-queue-action:disabled { color: var(--color-text-muted); cursor: default; }

/* ── 单条状态提示 ── */
#ch-delivery-note {
  position: relative;
  z-index: 2;
  padding: 3px 10px;
  font-size: 10px;
  color: var(--color-text-muted);
  background: var(--color-surface-dark);
  border-top: 1px solid var(--color-border-light);
  text-align: center;
  flex-shrink: 0;
}

/* ── 输入意图选择 ── */
#ch-intent-wrap { position: relative; flex-shrink: 0; }
#ch-intent-btn {
  padding: 5px 8px;
  background: var(--color-surface-darker);
  color: var(--color-text-bright);
  border: 1px solid var(--color-border-input);
  border-radius: 16px;
  cursor: pointer;
  font-size: clamp(9px, 2.2vw, 13px);
  font-family: inherit;
  white-space: nowrap;
}
#ch-intent-btn:hover { background: var(--color-border-light); }
#ch-intent-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  z-index: 10;
  min-width: 168px;
  padding: 4px;
  background: var(--color-dropdown-bg);
  border: 1px solid var(--color-dropdown-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px var(--color-dropdown-shadow);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ch-intent-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-bright);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.ch-intent-item:hover, .ch-intent-item.active { background: var(--color-dropdown-hover-bg); }
.ch-intent-name { font-size: clamp(10px, 2.3vw, 13px); }
.ch-intent-item.active .ch-intent-name { color: var(--color-text-pink); }
.ch-intent-desc { font-size: 9px; color: var(--color-dropdown-desc); }
.ch-intent-hint {
  padding: 3px 8px 1px;
  font-size: 9px;
  color: var(--color-dropdown-desc);
  border-top: 1px solid var(--color-border-light);
}

/* ── Slash 命令下拉框 ── */
#slash-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 10;
  max-height: 160px;
  overflow-y: auto;
  background: var(--color-dropdown-bg);
  border: 1px solid var(--color-dropdown-border);
  border-radius: 8px;
  padding: 4px 0;
  margin: 0;
  list-style: none;
  box-shadow: 0 4px 12px var(--color-dropdown-shadow);
  scroll-behavior: smooth;
}

#slash-dropdown li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.1s;
}

#slash-dropdown li.active,
#slash-dropdown li:hover {
  background: var(--color-dropdown-hover-bg);
}

.slash-name {
  font-size: clamp(9px, 2.2vw, 13px);
  color: var(--color-text-pink);
  font-weight: bold;
  white-space: nowrap;
  flex-shrink: 0;
}

.slash-desc {
  font-size: clamp(8px, 2vw, 11px);
  color: var(--color-dropdown-desc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 下拉框过渡动画 */
.slash-drop-enter-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.slash-drop-leave-active { transition: opacity 0.1s ease; }
.slash-drop-enter-from { opacity: 0; transform: translateY(4px); }
.slash-drop-leave-to { opacity: 0; }

/* ── 安全确认弹窗 ── */
#ch-confirm-overlay {
  position: absolute;
  inset: 0; z-index: 20;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 12px;
  background: var(--color-overlay-bg);
  backdrop-filter: blur(2px);
}
#ch-confirm-box {
  background: var(--color-confirm-bg);
  border: 1px solid var(--color-confirm-border);
  border-radius: 8px;
  padding: 10px 14px;
  max-width: 90%;
}
#ch-confirm-msg {
  color: var(--color-confirm-text);
  font-size: 11px;
  margin-bottom: 8px;
  text-align: center;
}
#ch-confirm-params {
  color: var(--color-text-muted); font-size: 10px; line-height: 1.4;
  margin: -2px 0 8px; max-height: 56px; overflow: auto; word-break: break-all;
}
#ch-confirm-btns {
  display: flex; gap: 8px; justify-content: center;
}
.ch-confirm-btn {
  padding: 4px 16px; font-size: 11px;
  border-radius: 12px; border: 1px solid var(--color-border-input);
  background: var(--color-surface-darker); color: var(--color-text-bright);
  cursor: pointer; font-family: inherit;
}
.ch-confirm-btn:hover { background: var(--color-border-light); }
.ch-confirm-btn.ch-confirm-ok {
  background: var(--color-accent); border-color: var(--color-accent); color: var(--color-tab-active-text);
}
.ch-confirm-btn.ch-confirm-ok:hover { background: var(--color-accent-hover); }

.confirm-fade-enter-active { transition: opacity 0.15s ease; }
.confirm-fade-leave-active { transition: opacity 0.1s ease; }
.confirm-fade-enter-from, .confirm-fade-leave-to { opacity: 0; }
</style>
