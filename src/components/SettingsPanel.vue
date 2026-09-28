<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  userConfig, toolsConfig,
  setOverrides, setOverride, getAllOverrides, flushConfig, parallelToolsError,
} from "@/services/config";
import {
  saveSoundAssignments,
} from "@/services/audio/registry";
import { switchPersonality, getActivePersonalityId } from "@/services/personality";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";
import { isMacOS } from "@/services/env";
import { parseEnvText } from "@/services/tool/mcp";
import { contextWindowError } from "@/services/context";
import { emit } from "@tauri-apps/api/event";
import GeneralTab from "@/components/settings/GeneralTab.vue";
import AITab from "@/components/settings/AITab.vue";
import ToolsTab from "@/components/settings/ToolsTab.vue";
import AppearanceTab from "@/components/settings/AppearanceTab.vue";
import AppDialog from "@/components/AppDialog.vue";

const log = createLogger("Settings");
const win = getCurrentWebviewWindow();

// ── Tab 控制 ──
const tabs = [
  { id: "general", label: "🏠 通用", icon: "G" },
  { id: "ai", label: "🤖 AI", icon: "A" },
  { id: "tools", label: "🔧 工具", icon: "T" },
  { id: "appearance", label: "🎨 外观", icon: "P" },
] as const;
const activeTab = ref<"general" | "ai" | "tools" | "appearance">("general");

// ── 子组件引用 ──
const generalTabRef = ref<InstanceType<typeof GeneralTab>>();
const aiTabRef = ref<InstanceType<typeof AITab>>();
const toolsTabRef = ref<InstanceType<typeof ToolsTab>>();
const appearanceTabRef = ref<InstanceType<typeof AppearanceTab>>();

// ═══════════════════════════════════
// 保存/取消
// ═══════════════════════════════════
const saved = ref(false);
const saveError = ref("");

const saving = ref(false);

async function doSave() {
  if (saving.value) return
  saving.value = true
  try {
  const g = generalTabRef.value!;
  const a = aiTabRef.value!;
  const t = toolsTabRef.value!;
  const ap = appearanceTabRef.value!;
  saveError.value = "";
  // 窗口低于支持下限时拒绝保存：这类配置会让压缩找不到可摘要范围，
  // 落盘只会把“静默跑坏”固化进 CONFIG；运行期同样会在模型解析处报错。
  const windowIssue = contextWindowError(a.aiContextMaxTokens);
  if (windowIssue) {
    saveError.value = windowIssue;
    log.error("设置保存失败:", windowIssue);
    return;
  }
  // 共享读上限越界同样拒绝保存：范围外的手写值不会静默夹到边界后落盘，
  // 用户看到的是错误而不是“保存成功但生效值不同”。
  const parallelIssue = parallelToolsError(t.maxParallelTools);
  if (parallelIssue) {
    saveError.value = parallelIssue;
    log.error("设置保存失败:", parallelIssue);
    return;
  }
  const previousPersonalityActive = getActivePersonalityId();

  userConfig.popupMode = g.popupMode;
  userConfig.autoPopupOnMessage = g.autoPopup;
  userConfig.popupSize = { w: g.popupW, h: g.popupH };
  userConfig.shortcutKey = g.recKey;
  if (isMacOS) userConfig.shortcutMacModifiers = g.recMods;
  else userConfig.shortcutWinModifiers = g.recMods;
  userConfig.effectMode = ap.effectMode;
  userConfig.parallaxIntensity = ap.parallaxIntensity;

  // 音效分配持久化
  saveSoundAssignments(ap.assignments);

  setOverrides({
    "ai.endpoint": a.aiEndpoint,
    "ai.apiKey": a.aiApiKey,
    "ai.requireApiKey": a.aiRequireApiKey,
    "ai.model": a.aiModel,
    "ai.contextMaxTokens": a.aiContextMaxTokens,
    "ai.thinking.effort": a.aiThinkingEffort,
    // 对话投递：默认发送方式与队列批量策略（忙碌投递与下一回合的批量行为）
    "ai.conversation.defaultDelivery": a.defaultDelivery,
    "ai.conversation.steeringMode": a.steeringMode,
    "ai.conversation.followUpMode": a.followUpMode,
    "ai.personality.active": a.personalityActive,
    "ai.windowMonitor.enabled": a.wmEnabled,
    "ai.windowMonitor.staySeconds": a.wmStaySeconds,
    "ai.windowMonitor.settleMs": a.wmSettleMs,
    // 配置面统一毫秒，界面面用秒（给人读的），换算就放在这个边界上
    "ai.windowMonitor.cooldownMs": Math.round(a.wmCooldownSec * 1000),
    "ai.windowMonitor.samePageCooldownMs": Math.round(a.wmSamePageCool * 1000),
    "ai.lock.safetyTimeoutMs": a.lockTimeout,
    "ai.memory.maxEntries": a.memMax,
    // Plan 的七个键在 AITab 里都有 UI 和 expose，此前没进这张表 ——
    // 用户在设置页改完保存会被静默丢弃，且 test:types 抓不到
    "ai.plan.enabled": a.planEnabled,
    "ai.plan.complexityThreshold": a.planComplexityThreshold,
    // 与 ai.loop.maxParallelTools 同类：界面能改的值必须能落盘，否则设置页的改动只是看起来生效
    "ai.plan.complexityEval": a.planComplexityEval,
    "ai.plan.maxSteps": a.planMaxSteps,
    "ai.plan.thinkingEffort": a.planThinkingEffort,
    "ai.plan.stepThinkingEffort": a.planStepThinkingEffort,
    "ai.plan.onStepFailure": a.planOnStepFailure,
    "general.desktop.pollingIntervalMs": g.deskPoll,
    "general.desktop.pauseExtraMs": g.deskPause,
    "general.desktop.waitTimeoutMs": g.deskWait,
    "general.logging.level": g.logLevel,
    "general.errors.overlay": g.errOverlay,
    "ai.safety.mode": a.safetyMode,
    "ai.safety.sessionTrustEnabled": a.sessionTrustEnabled,
    // 共享读并行上限：并发所有权在 Rust 许可池，这里只落配置值
    "ai.loop.maxParallelTools": t.maxParallelTools,
    "tools.bash.whitelist": t.bashWhitelist.split("\n").map(s => s.trim()).filter(Boolean),
  });

  // MCP 内置
  const builtinRaw = toolsConfig.builtinMcpServers as Record<string, any>;
  if (builtinRaw && typeof builtinRaw === "object") {
    const updated: Record<string, any> = {};
    for (const b of t.builtinMcpList) {
      const original = builtinRaw[b.name] || {};
      const env: Record<string, string> = {};
      if (b.envStr.trim()) {
        for (const line of b.envStr.trim().split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
      updated[b.name] = {
        enabled: b.enabled,
        command: original.command || "npx",
        args: b.args.trim() ? b.args.trim().split(/\s+/).filter(Boolean) : (original.args || []),
        description: original.description || "",
        ...(Object.keys(env).length > 0 || (original.env && Object.keys(original.env).length > 0) ? { env } : {}),
      };
    }
    setOverride("tools.mcp.builtin", updated);
  }

  const { setMcpServers } = await import("@/services/tool/mcp");
  // 必须 await：setMcpServers 先断开受影响服务器（内部对 registry 的动态 import 在刚打开的
  // 设置窗口是冷的），之后才把列表写进 CONFIG 覆盖层。不等它，后面的 flushConfig 与
  // deskpet-settings-saved 就可能先跑，主窗口重读到的仍是旧列表 —— 新增/删除服务器第一次
  // 保存会表现为「保存成功但没生效」。
  try {
    await setMcpServers(
      t.mcpServerList.map((s) => {
        // 面板用一行一条的文本编辑 env，落盘前还原成对象；
        // 全空时给 undefined，让 manager 的 inheritEnv 决定是否沿用旧值
        const env = parseEnvText(s.envStr);
        return {
          name: s.name,
          transport: s.transport as "stdio" | "sse",
          command: s.command || undefined,
          args: s.args ? s.args.split(/\s+/).filter(Boolean) : undefined,
          url: s.url || undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
          enabled: s.enabled,
        };
      })
    );
  } catch (error) {
    // 与人格切换失败同样中止保存：MCP 列表没写进 CONFIG，就不能继续写盘并广播「已保存」，
    // 否则面板显示成功、主窗口拿到的还是旧列表。失败原因（如服务器正被回合占用）直接摆给用户。
    saveError.value = "MCP 服务器保存失败：" + formatError(error);
    log.error("设置保存失败:", saveError.value);
    return;
  }

  const switchResult = await switchPersonality(a.personalityActive);
  if (!switchResult.ok) {
    saveError.value = switchResult.error || "人格切换失败";
    setOverride("ai.personality.active", previousPersonalityActive);
    log.error("设置保存失败:", saveError.value);
    return;
  }

  if (a.candyInstructions.trim()) {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.updateCandy(a.candyInstructions.trim());
  }

  await flushConfig()

  saved.value = true;
  log.info("设置已保存");
  emit("deskpet-settings-saved").catch((error) => {
    // 面板刚显示「已保存」，但主窗口没收到广播：配置缓存/快捷键/光标追踪/调试状态仍是旧值。
    // Skill 目录不在此列：清单由每回合的指纹核对刷新，与这条广播无关。
    saved.value = false;
    saveError.value = "设置已写入，但主窗口未收到刷新通知；部分改动可能要重启后生效。";
    log.error("deskpet-settings-saved 事件发送失败:", formatError(error));
  });
  setTimeout(() => {
    saved.value = false;
  }, 3000);
  } finally {
    saving.value = false
  }
}

function doCancel() {
  win.close().catch(error => log.warn("关闭设置窗口失败:", formatError(error)));
}

/**
 * 进程级重启。写盘必须先于重启：设置改动先进写盘队列，直接重启会把队列里
 * 还没落盘的配置丢掉，用户以为是"重启后生效"，实际是改动没了。写盘失败就
 * 不重启，把原因摆出来。
 */
async function restartApp() {
  try {
    await flushConfig();
  } catch (error) {
    saveError.value = "配置写盘失败，已取消重启：" + formatError(error);
    log.error("重启前写盘失败:", formatError(error));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("app_restart");
}

// CONFIG 导入导出
async function exportConfigYaml() {
  try {
    const jsYaml = await import("js-yaml");
    const yamlStr = jsYaml.dump(getAllOverrides(), { lineWidth: -1, noRefs: true });
    const blob = new Blob([yamlStr], { type: "application/x-yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "deskpet-config-export.yaml";
    a.click();
  } catch (e) {
    log.error("导出失败", e);
  }
}

async function importConfigYaml() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(await file.text()) as Record<string, any>;
      if (!parsed || typeof parsed !== "object") return;
      const flat: Record<string, any> = {};
      function flatten(obj: any, prefix: string) {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, key);
          else flat[key] = v;
        }
      }
      flatten(parsed, "");
      setOverrides(flat);
      location.reload();
    } catch (e) {
      log.error("导入失败", e);
    }
  };
  input.click();
}

// ── 生命周期 ──
onMounted(() => {
  // 各子组件自行处理其 onMounted 初始化
  // 父组件只负责协调
});

onUnmounted(() => {
  // 各子组件自行处理其 onUnmounted 清理
});
</script>

<template>
  <div id="s-root">
    <div id="s-head">
      <span>⚙ 设置</span>
      <span class="s-hint">修改后点击保存，部分配置需重启生效</span>
      <button class="s-close" @click="doCancel">✕</button>
    </div>

    <div id="s-body-wrap">
      <!-- 侧边导航 -->
      <div id="s-nav">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="s-nav-btn"
          :class="{ active: activeTab === t.id }"
          @click="activeTab = t.id as any"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 内容区 -->
      <div id="s-body">
        <GeneralTab ref="generalTabRef" v-show="activeTab === 'general'" />
        <AITab ref="aiTabRef" v-show="activeTab === 'ai'" />
        <ToolsTab ref="toolsTabRef" v-show="activeTab === 'tools'" />
        <AppearanceTab ref="appearanceTabRef" v-show="activeTab === 'appearance'" />
      </div>
    </div>

    <div id="s-foot">
      <button class="btn-s" @click="importConfigYaml()">📥 导入配置</button>
      <button class="btn-s" @click="exportConfigYaml()">📤 导出配置</button>
      <button class="btn-s btn-d" @click="restartApp()">🔄 重启</button>
      <div v-if="saveError" class="s-error">{{ saveError }}</div>
      <div v-if="saved" class="s-saved">✅ 已保存！</div>
      <button class="btn" @click="doCancel">取消</button>
      <button class="btn btn-primary" @click="doSave">💾 保存</button>
    </div>

    <AppDialog />
  </div>
</template>

<style>
/* ★ 共享样式（非 scoped，供子组件使用） ★ */
* { margin: 0; padding: 0; box-sizing: border-box; }

#s-root {
  width: 100%; height: 100%;
  display: flex; flex-direction: column;
  background: var(--color-settings-bg, #3e1a2e);
  color: #f0e0f0;
  font-family: "zpix", "pixel-mplus", sans-serif;
  font-size: 11px;
  overflow: hidden;
}

#s-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: var(--color-settings-card, #2a1020);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  color: var(--color-accent, #c4276f);
  font-size: 13px; flex-shrink: 0; user-select: none;
}
#s-head .s-hint { flex: 1; font-size: 9px; opacity: 0.5; }
.s-close {
  background: none; border: none;
  color: var(--color-accent, #c4276f);
  cursor: pointer; font-size: 14px; padding: 2px 6px;
}
.s-close:hover { color: #fff; }

#s-body-wrap { flex: 1; display: flex; overflow: hidden; }

#s-nav {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 4px;
  background: var(--color-settings-card, #2a1020);
  border-right: 1px solid rgba(255,255,255,0.06);
  min-width: 80px; flex-shrink: 0;
}
.s-nav-btn {
  background: none; border: none;
  color: rgba(255,255,255,0.5);
  font-size: 10px; font-family: inherit;
  padding: 8px 6px; text-align: center;
  cursor: pointer; border-radius: 4px; transition: all .15s;
}
.s-nav-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
.s-nav-btn.active { background: var(--color-accent, #c4276f); color: #fff; }

#s-body {
  flex: 1; overflow-y: auto; padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
}

/* ── 共享表单样式（子组件复用）── */
.s-section {
  background: var(--color-settings-card, #2a1020);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 6px; padding: 8px;
}
.s-label {
  color: var(--color-accent, #c4276f);
  font-size: 12px; margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.s-subtitle { color: rgba(255,255,255,0.6); font-size: 10px; margin: 4px 0 2px; }
.s-hint { font-size: 9px; opacity: 0.5; margin-top: 2px; }
.s-muted { font-size: 10px; opacity: 0.4; }
.tag-tip {
  font-size: 8px; background: rgba(255,255,255,0.1);
  padding: 1px 5px; border-radius: 6px; white-space: nowrap;
}
.fld { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.fld-col { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.fn { font-size: 10px; opacity: 0.5; min-width: 50px; flex-shrink: 0; }
.row-gap { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.radio-row { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.chk {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; cursor: pointer; color: rgba(255,255,255,0.8);
}
.chk input { accent-color: var(--color-accent, #c4276f); }
.inp {
  flex: 1; min-width: 0;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 4px; color: #f0e0f0;
  padding: 2px 6px; font-size: 11px; font-family: inherit;
}
.inp:focus { border-color: var(--color-accent, #c4276f); outline: none; }
.inp-num {
  width: 64px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 4px; color: #f0e0f0;
  padding: 2px 6px; font-size: 11px;
  font-family: inherit; text-align: center;
}
.inp-num:focus { border-color: var(--color-accent, #c4276f); outline: none; }
.txa { resize: vertical; min-height: 36px; }
.mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 10px; }
select.inp { cursor: pointer; }
.btn-s {
  padding: 2px 8px; font-size: 10px;
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.7);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px; cursor: pointer;
  font-family: inherit; white-space: nowrap; flex-shrink: 0;
}
.btn-s:hover { background: rgba(255,255,255,0.15); }
.btn-s:disabled { opacity: 0.3; cursor: default; }
.btn-d { opacity: 0.5; }
.btn-d:hover { opacity: 1; }

.shortcut-display {
  padding: 3px 10px;
  background: rgba(0,0,0,0.3); border-radius: 4px;
  border: 1px solid rgba(255,255,255,0.1);
  font-family: monospace; font-size: 12px;
}

.li-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 6px; padding: 2px 4px; font-size: 10px;
}
.li-row code { font-size: 9px; opacity: 0.4; }

.edit-box {
  padding: 6px; margin: 2px 0;
  background: rgba(0,0,0,0.2); border-radius: 4px;
  display: flex; flex-direction: column; gap: 4px;
}

/* ── Footer ── */
#s-foot {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 8px 12px;
  background: var(--color-settings-card, #2a1020);
  border-top: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.s-saved { flex: 1; color: #a0f0c0; font-size: 10px; }
.s-error { flex: 1; color: #ff9a9a; font-size: 10px; }
.btn {
  padding: 4px 14px; font-size: 11px;
  background: rgba(255,255,255,0.06); color: #f0e0f0;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px; cursor: pointer; font-family: inherit;
}
.btn:hover { background: rgba(255,255,255,0.12); }
.btn-primary {
  background: var(--color-accent, #c4276f);
  border-color: var(--color-accent, #c4276f);
}
.btn-primary:hover { opacity: 0.85; }
</style>
