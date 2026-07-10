<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import {
  aiConfig, windowMonitorConfig, aiLockConfig,
  memoryConfig, personalityConfig, modeConfig,
  replyConfig, safetyConfig,
} from "@/services/config";
import {
  listPersonalities, getActiveCard,
  saveUserCard, initCards, getActivePersonalityId,
} from "@/services/personality";
import { getPoolSnapshot, formatPoolForPrompt } from "@/services/personality";
import { getCachedStages } from "@/services/personality";
import type { PersonalityCard } from "@/services/personality";
import type { EmotionMapping } from "@/services/personality";
import type { StageMap, StagePrompts } from "@/services/personality";
import { createLogger } from "@/services/logger";

const log = createLogger("Settings");

// ── API ──
const aiEndpoint = ref(aiConfig.endpoint);
const aiApiKey = ref(aiConfig.apiKey);
const aiModel = ref(aiConfig.model);
const aiContextMaxTokens = ref(aiConfig.contextMaxTokens);
const showApiKey = ref(false);
const aiRequireApiKey = ref(aiConfig.requireApiKey);

// ── 思考 & 流式 ──
const aiThinkingEffort = ref(aiConfig.thinkingEffort);           // Phase1
const aiPhase2ThinkingEffort = ref(replyConfig.phase2ThinkingEffort); // Phase2
const aiStreamEnabled = ref(replyConfig.streamEnabled);

// ── 安全 ──
const safetyMode = ref(safetyConfig.mode as string);
const sessionTrustEnabled = ref(safetyConfig.sessionTrustEnabled);

// ── 窗口监控 ──
const wmEnabled = ref(windowMonitorConfig.enabled);
const wmStaySeconds = ref(windowMonitorConfig.staySeconds);
const wmSettleMs = ref(windowMonitorConfig.settleMs);
const wmCooldownSec = ref(windowMonitorConfig.cooldownSeconds);
const wmSamePageCool = ref(windowMonitorConfig.samePageCooldownSeconds);

// ── 并发锁 ──
const lockTimeout = ref(aiLockConfig.safetyTimeoutMs);

// ── 记忆 ──
const memMax = ref(memoryConfig.maxEntries);
const candyInstructions = ref("");
const memStatus = ref<{
  count: number;
  lastConsolidation: string;
  mode: string;
  sessionTurns?: number;
  sessionId?: string;
  projectCount?: number;
}>({
  count: 0,
  lastConsolidation: "从未",
  mode: modeConfig.assistant ? "助手(LLM)" : "轻量(去重)",
});

// ═══════════════════════════════════
// 🎭 Card 系统
// ═══════════════════════════════════

const personalityEnabled = ref(personalityConfig.enabled);
const personalityActive = ref(personalityConfig.active);
const cardList = ref<PersonalityCard[]>([]);
const expandedCardId = ref<string | null>(null);

// ── 事务式切换 ──
const pendingCardId = ref<string | null>(null);
const switchingCard = ref(false);
const switchError = ref("");
const switchSuccess = ref("");

// ── Card 面板折叠 ──
const showVarPool = ref(false);
const showStages = ref(false);
const showEmotion = ref(false);

// ── 变量池 ──
const poolRefreshTick = ref(0);
const poolSnapshot = computed(() => { poolRefreshTick.value; return getPoolSnapshot(); });
const poolPromptText = computed(() => { poolRefreshTick.value; return formatPoolForPrompt(); });

// ── 阶段文案 ──
const stagesData = ref<StagePrompts | null>(null);
const editingStages = ref(false);
const stageEditJson = ref("");
const stagesFileExists = ref(false);

// ── 情绪表达 ──
const emotionMappings = computed<EmotionMapping[]>(() => {
  const card = cardList.value.find(c => c.id === personalityActive.value);
  return card?.sections.emotionMappings ?? [];
});

// ── 辅助 ──
const currentCard = computed(() =>
  cardList.value.find(c => c.id === personalityActive.value) ?? null,
);

async function checkStagesExists(cardId: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const files = await invoke<string[]>("personality_file_list", {
      dirPath: "personality/stages",
    });
    return files.some(f => f === `${cardId}.json`);
  } catch {
    return false;
  }
}

async function toggleCardExpand(id: string) {
  expandedCardId.value = expandedCardId.value === id ? null : id;
  if (expandedCardId.value) await hydrateRuntimePreview(id);
}

async function selectCard(id: string) {
  pendingCardId.value = id;
  expandedCardId.value = id;
  switchError.value = "";
  switchSuccess.value = "";
  await hydrateRuntimePreview(id);
}

async function refreshCards() {
  await initCards();
  cardList.value = listPersonalities();
  for (const c of cardList.value) {
    (c as any)._stagesExist = await checkStagesExists(c.id);
  }
  log.info("Card 列表已刷新:", cardList.value.map(c => c.id).join(", "));
}

function loadStagesForCard(cardId: string) {
  const cached = getCachedStages();
  if (cached && cached.cardId === cardId) {
    stagesData.value = cached;
    stagesFileExists.value = true;
  } else {
    stagesData.value = null;
  }
}

async function hydrateRuntimePreview(cardId: string) {
  const card = cardList.value.find(c => c.id === cardId);
  if (!card) return;

  const { loadStagesFromDisk, loadVariablePool, refreshVariablePool } = await import("@/services/personality");
  const loadedStages = await loadStagesFromDisk(card.id, card.version);
  stagesData.value = loadedStages;
  stagesFileExists.value = Boolean(loadedStages) || await checkStagesExists(card.id);

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<number[]>("personality_file_read", { path: "personality/vars.json" });
    const json = new TextDecoder().decode(new Uint8Array(raw));
    loadVariablePool(json, card.id);
    refreshVariablePool();
  } catch {
    // 设置页只做预览 hydrate，失败时保持当前内存快照。
  }
  poolRefreshTick.value++;
}

// ── 阶段文案编辑 ──
function startEditStages() {
  const data = stagesData.value;
  if (!data) {
    switchError.value = "当前 Card 的阶段文案尚未加载，无法编辑";
    return;
  }
  stageEditJson.value = JSON.stringify(data.stages, null, 2);
  editingStages.value = true;
}

function cancelEditStages() {
  editingStages.value = false;
  stageEditJson.value = "";
}

/** 持久化当前 stages 到磁盘（编辑保存/手动持久化都走这里） */
async function persistCurrentStages() {
  const cardId = personalityActive.value;
  if (!cardId) return;
  try {
    const data = editingStages.value
      ? (() => { const parsed = JSON.parse(stageEditJson.value) as StageMap; return parsed; })()
      : stagesData.value?.stages ?? getCachedStages()?.stages;
    if (!data) return;

    const { invoke } = await import("@tauri-apps/api/core");
    const content = JSON.stringify({
      cardId, cardVersion: currentCard.value?.version ?? 1,
      cardHash: currentCard.value?.hash ?? "",
      generatedAt: Date.now(), isFallback: false,
      stages: data,
    }, null, 2);
    await invoke("personality_file_write", {
      path: `personality/stages/${cardId}.json`,
      content: Array.from(new TextEncoder().encode(content)),
    });
    const { loadStages } = await import("@/services/personality");
    loadStages(JSON.parse(content) as StagePrompts);
    stagesData.value = getCachedStages();
    stagesFileExists.value = true;
    const loadedCard = cardList.value.find(c => c.id === cardId);
    if (loadedCard) (loadedCard as any)._stagesExist = true;
    editingStages.value = false;
    log.info("阶段文案已持久化:", cardId);
  } catch (e) {
    log.error("阶段文案持久化失败:", e);
    switchError.value = "持久化失败: " + (e instanceof Error ? e.message : String(e));
  }
}

async function saveEditStages() {
  await persistCurrentStages();
}


// ── 事务式切换 ──
async function applySwitch() {
  const targetId = pendingCardId.value;
  if (!targetId || targetId === personalityActive.value) return;

  const targetCard = cardList.value.find(c => c.id === targetId);
  if (!targetCard) return;

  switchingCard.value = true;
  switchError.value = "";
  switchSuccess.value = "";
  const oldCardId = personalityActive.value;

  try {
    // 1. 事务式切换：stages 生成/加载 + 变量池初始化/持久化 任一失败都会回滚
    const { switchPersonality } = await import("@/services/personality");
    const result = await switchPersonality(targetId);
    if (!result.ok) throw new Error(result.error || "人格切换失败");

    // 2. 更新 UI
    personalityActive.value = targetId;
    pendingCardId.value = targetId;
    poolRefreshTick.value++;
    stagesData.value = getCachedStages();
    stagesFileExists.value = await checkStagesExists(targetId);
    (targetCard as any)._stagesExist = stagesFileExists.value;
    switchSuccess.value = `已切换到 ${targetCard.name}`;
    log.info("Card 切换成功:", targetId);

    // 3. 发送激活问候
    const { pickGreeting } = await import("@/services/personality");
    const greeting = pickGreeting(targetCard.sections.mustRules.greetings);
    if (greeting) {
      const { pushAssistantMessage } = await import("@/services/session/messages");
      pushAssistantMessage(greeting);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    switchError.value = msg;
    log.error("Card 切换失败:", msg);
    pendingCardId.value = oldCardId;
    personalityActive.value = oldCardId;
    poolRefreshTick.value++;
    const cached = getCachedStages();
    stagesData.value = cached && cached.cardId === oldCardId ? cached : null;
    stagesFileExists.value = oldCardId ? await checkStagesExists(oldCardId) : false;
    (targetCard as any)._stagesExist = await checkStagesExists(targetId);
  } finally {
    switchingCard.value = false;
  }
}

// ── 重新生成阶段文案 ──
const regenerating = ref(false);

/** 为指定 Card 生成阶段文案（不从当前切换） */
async function generateStagesForSelected(card: PersonalityCard) {
  regenerating.value = true;
  switchError.value = "";
  try {
    const { generateStagesForCard, getCachedStages } = await import("@/services/personality");
    const result = await generateStagesForCard(
      card.id, card.sections.roleSetting,
      card.sections.languageStyle, card.version, card.hash,
    );
    if (result) {
      stagesData.value = result;
      stagesFileExists.value = true;
      (card as any)._stagesExist = true;
      log.info("阶段文案已生成:", card.id);
    } else {
      stagesData.value = null;
      stagesFileExists.value = false;
      (card as any)._stagesExist = false;
      switchError.value = "阶段文案生成失败，请检查 API 连接";
    }
  } catch (e) {
    log.error("阶段文案生成异常:", e);
    switchError.value = "阶段文案生成异常";
  } finally {
    regenerating.value = false;
  }
}

async function regenerateStages() {
  const card = currentCard.value;
  if (!card) return;
  regenerating.value = true;
  try {
    const { generateStagesForCard, getCachedStages } = await import("@/services/personality");
    const result = await generateStagesForCard(
      card.id, card.sections.roleSetting,
      card.sections.languageStyle, card.version, card.hash,
    );
    if (result) {
      stagesData.value = result;
      stagesFileExists.value = true;
      log.info("阶段文案已重新生成:", card.id);
    } else {
      stagesData.value = null;
      stagesFileExists.value = false;
      (card as any)._stagesExist = false;
      switchError.value = "阶段文案生成失败";
    }
  } catch (e) {
    log.error("阶段文案生成异常:", e);
    switchError.value = "阶段文案生成异常";
  } finally {
    regenerating.value = false;
  }
}

// ── 导入用户 Card ──
async function importCard() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const card = await saveUserCard(raw);
      await initCards();
      cardList.value = listPersonalities();
      const loaded = cardList.value.find(c => c.id === card.id);
      if (loaded) (loaded as any)._stagesExist = await checkStagesExists(loaded.id);
      pendingCardId.value = card.id;
      expandedCardId.value = card.id;
      log.info("Card 已导入并持久化:", card.id);
    } catch (e) {
      log.error("Card 导入失败:", e);
      switchError.value = "Card 导入失败: " + (e instanceof Error ? e.message : String(e));
    }
  };
  input.click();
}

// ── 阶段文案表格行 ──
interface StageRow {
  stage: string;
  category: string;
  text: string;
}

const stageRows = computed<StageRow[]>(() => {
  const stages = stagesData.value?.stages;
  const rows: StageRow[] = [];
  if (!stages) return rows;

  for (const stage of ["executing", "done", "blocked"] as const) {
    const map = stages[stage] as Record<string, string>;
    if (map) {
      for (const [cat, text] of Object.entries(map)) {
        rows.push({ stage, category: cat, text });
      }
    }
  }

  for (const stage of ["thinking", "planning", "idle", "error", "timeout", "retry"] as const) {
    const val = stages[stage];
    if (val !== null && val !== undefined) {
      rows.push({ stage, category: "—", text: val as string });
    }
  }

  return rows;
});

// ── 生命周期 ──
onMounted(async () => {
  await initCards();
  cardList.value = listPersonalities();
  personalityActive.value = getActivePersonalityId() ?? personalityActive.value;
  pendingCardId.value = personalityActive.value;

  // 检查每个 card 的 stages 文件状态
  for (const c of cardList.value) {
    (c as any)._stagesExist = await checkStagesExists(c.id);
  }
  stagesFileExists.value = personalityActive.value
    ? await checkStagesExists(personalityActive.value)
    : false;

  try {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.init();
    const sm = MemoryService.session;
    memStatus.value = {
      count: MemoryService.count,
      projectCount: MemoryService.projectCount,
      lastConsolidation: sm?.compactionSummary ? "已压缩" : "运行中",
      mode: modeConfig.assistant ? "助手(LLM)" : "轻量(去重)",
      sessionTurns: sm?.turns.length ?? 0,
      sessionId: sm?.sessionId ?? "",
    };
    const candy = MemoryService.getCandyInstructionsSync();
    if (candy)
      candyInstructions.value = candy
        .replace(/^[\s\S]*?指令\]\n/, "")
        .trim();
  } catch {}

  if (personalityActive.value) {
    await hydrateRuntimePreview(personalityActive.value);
  }
  poolRefreshTick.value++;
});

defineExpose({
  aiEndpoint,
  aiApiKey,
  aiModel,
  aiContextMaxTokens,
  aiThinkingEffort,
  aiPhase2ThinkingEffort,
  aiStreamEnabled,
  aiRequireApiKey,
  safetyMode,
  sessionTrustEnabled,
  wmEnabled,
  wmStaySeconds,
  wmSettleMs,
  wmCooldownSec,
  wmSamePageCool,
  lockTimeout,
  memMax,
  personalityEnabled,
  personalityActive,
  candyInstructions,
});
</script>

<template>
  <div>
  <!-- ═══ 🤖 API ═══ -->
  <div class="s-section">
    <div class="s-label">🤖 API</div>
    <div class="fld"><span class="fn">端点</span><input class="inp" v-model="aiEndpoint" /></div>
    <div class="fld"><span class="fn">密钥</span><input class="inp" :type="showApiKey ? 'text' : 'password'" v-model="aiApiKey" /><button class="btn-s" @click="showApiKey = !showApiKey">{{ showApiKey ? '🙈' : '👁' }}</button></div>
    <div class="fld"><span class="fn">模型</span><input class="inp" v-model="aiModel" /></div>
    <div class="fld"><span class="fn">上下文</span><input class="inp-num" type="number" v-model.number="aiContextMaxTokens" style="width:80px" /><span class="s-muted">tokens</span></div>
    <label class="chk" style="margin-top:4px"><input type="checkbox" v-model="aiRequireApiKey" /><span>需要 API Key</span></label>
  </div>

  <!-- ═══ 🧠 思考强度 ═══ -->
  <div class="s-section">
    <div class="s-label">🧠 思考强度</div>

    <div class="s-subtitle">Phase1（能力层）</div>
    <div class="radio-row">
      <label v-for="lv in ['auto','low','medium','high']" :key="'p1'+lv" class="chk"><input type="radio" v-model="aiThinkingEffort" :value="lv" /><span>{{ lv }}</span></label>
    </div>

    <div class="s-subtitle" style="margin-top:6px">Phase2（风格层）</div>
    <div class="radio-row">
      <label v-for="lv in ['auto','low','medium','high']" :key="'p2'+lv" class="chk"><input type="radio" v-model="aiPhase2ThinkingEffort" :value="lv" /><span>{{ lv }}</span></label>
    </div>
    <label class="chk" style="margin-top:6px"><input type="checkbox" v-model="aiStreamEnabled" /><span>流式输出 (Phase2)</span></label>
  </div>

  <!-- ═══ 🎭 角色选择 ═══ -->
  <div class="s-section">
    <div class="s-label">
      🎭 角色选择
      <span style="flex:1"></span>
      <button class="btn-s" @click="importCard()" title="导入 .md Card">📥 导入</button>
      <button class="btn-s" @click="refreshCards()" title="刷新列表">🔄</button>
    </div>

    <label class="chk" style="margin-bottom:6px"><input type="checkbox" v-model="personalityEnabled" /><span>启用人格系统</span></label>

    <div v-if="!personalityEnabled" class="s-hint">已关闭 → 零身份模式，不注入任何角色 Prompt</div>

    <div v-else class="card-grid">
      <div
        v-for="card in cardList"
        :key="card.id"
        class="card-item"
        :class="{ active: personalityActive === card.id, selected: pendingCardId === card.id && pendingCardId !== personalityActive }"
      >
        <!-- Card 头部 -->
        <div class="card-header" @click="toggleCardExpand(card.id)">
          <div class="card-select" @click.stop="selectCard(card.id)">
            <span class="card-radio-dot">{{ pendingCardId === card.id ? '◉' : '○' }}</span>
            <span class="card-name">{{ card.name }}</span>
          </div>
          <span class="card-meta">
            <span v-if="(card as any)._stagesExist === false" class="tag-tip tag-warn">无stages</span>
            <span v-else-if="(card as any)._stagesExist" class="tag-tip tag-ok">stages</span>
            <span v-if="personalityActive === card.id" class="tag-tip" style="background:var(--color-accent, #c4276f);color:#fff">当前</span>
            <span class="tag-tip" :class="card.source">{{ card.source }}</span>
            <span class="card-arrow">{{ expandedCardId === card.id ? '▾' : '▸' }}</span>
          </span>
        </div>

        <!-- Card 详情（展开时） -->
        <div v-if="expandedCardId === card.id" class="card-detail">
          <div class="s-hint" style="margin-bottom:4px">{{ card.description }}</div>

          <div class="card-section-preview">
            <div class="fn">角色设定</div>
            <div class="card-text">{{ card.sections.roleSetting.slice(0, 120) }}{{ card.sections.roleSetting.length > 120 ? '…' : '' }}</div>
          </div>

          <div class="card-section-preview">
            <div class="fn">语言风格</div>
            <div class="card-text">{{ card.sections.languageStyle.slice(0, 80) }}{{ card.sections.languageStyle.length > 80 ? '…' : '' }}</div>
          </div>

          <div class="card-stats">
            <span>{{ card.sections.whenRules.length }} 条行为规则</span>
            <span>{{ Object.keys(card.sections.initialVars).length }} 个变量</span>
            <span>{{ card.sections.emotionMappings.length }} 个情绪</span>
            <span>v{{ card.version }}</span>
          </div>

          <!-- stages 状态 + 生成按钮（展开时显示） -->
          <div v-if="(card as any)._stagesExist === false" class="stages-warn">
            ⚠️ 此角色尚未生成阶段文案（stages），需先生成才能正常使用
            <button
              class="btn-s" style="margin-top:4px;background:var(--color-accent,#c4276f);color:#fff"
              :disabled="regenerating"
              @click.stop="generateStagesForSelected(card)"
            >
              {{ regenerating ? '⏳ 生成中…' : '🔄 生成阶段文案' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="cardList.length === 0" class="s-hint">暂无可用的 Card，导入 .md 文件或检查 cards/ 目录</div>
    </div>

    <!-- 切换按钮（选中非当前 Card 时显示） -->
    <div v-if="pendingCardId && pendingCardId !== personalityActive" class="switch-bar">
      <button
        class="btn-s"
        style="background:var(--color-accent,#c4276f);color:#fff;padding:4px 16px"
        @click="applySwitch()"
        :disabled="switchingCard"
      >
        {{ switchingCard ? '⏳ 切换中…' : `✅ 切换到 ${cardList.find(c => c.id === pendingCardId)?.name ?? pendingCardId}` }}
      </button>
      <button class="btn-s" @click="pendingCardId = personalityActive" :disabled="switchingCard">取消</button>
    </div>

    <div v-if="switchError" class="s-hint" style="color:#f88;margin-top:4px">{{ switchError }}</div>
    <div v-if="switchSuccess" class="s-hint" style="color:#8f8;margin-top:4px">{{ switchSuccess }}</div>
  </div>

  <!-- ═══ 📊 变量池 ═══ -->
  <div class="s-section">
    <div class="s-label" style="cursor:pointer" @click="showVarPool = !showVarPool">
      📊 变量池 <span style="flex:1"></span><span class="card-arrow">{{ showVarPool ? '▾' : '▸' }}</span>
    </div>

    <div v-if="showVarPool">
      <div v-if="!personalityActive" class="s-hint">未选择 Card，变量池为空</div>
      <pre v-else class="pool-preview">{{ poolPromptText }}</pre>
      <div class="s-hint">系统变量只读，角色变量由 LLM 自主管理</div>
    </div>
  </div>

  <!-- ═══ ✏️ 阶段文案 ═══ -->
  <div class="s-section">
    <div class="s-label" style="cursor:pointer" @click="showStages = !showStages">
      ✏️ 阶段文案 <span style="flex:1"></span><span class="card-arrow">{{ showStages ? '▾' : '▸' }}</span>
      <span v-if="!stagesData" class="tag-tip" style="margin-right:4px">未生成</span>
    </div>

    <div v-if="showStages">
      <div v-if="!personalityActive" class="s-hint">未选择 Card</div>
      <div v-else-if="editingStages">
        <textarea class="inp txa mono" v-model="stageEditJson" rows="12"></textarea>
        <div class="row-gap" style="margin-top:4px">
          <button class="btn-s" @click="cancelEditStages()">取消</button>
          <button class="btn-s" style="background:var(--color-accent,#c4276f);color:#fff" @click="saveEditStages()">💾 保存</button>
        </div>
      </div>
      <div v-else>
        <div v-if="!stagesData && !stagesFileExists" class="s-hint" style="color:#fa0;margin-bottom:4px">⚠️ 当前 Card 的阶段文案尚未生成，点击下方按钮生成</div>
        <div class="stage-table">
          <div class="stage-th"><span>阶段</span><span>类别</span><span>文案</span></div>
          <div v-for="row in stageRows" :key="`${row.stage}-${row.category}`" class="stage-tr">
            <span class="tag-tip">{{ row.stage }}</span>
            <span class="s-muted">{{ row.category }}</span>
            <span class="stage-text">{{ row.text }}</span>
          </div>
        </div>
        <div class="row-gap" style="margin-top:6px">
          <button class="btn-s" @click="startEditStages()" v-if="stagesData">✏️ 编辑</button>
          <button class="btn-s" @click="regenerateStages()" :disabled="regenerating">{{ regenerating ? '⏳ 生成中…' : '🔄 重新生成' }}</button>
          <button v-if="stagesData && !stagesFileExists" class="btn-s" style="background:var(--color-accent,#c4276f);color:#fff" @click="persistCurrentStages()">💾 持久化到磁盘</button>
          <span class="s-hint">⚠ 重新生成会覆盖手动编辑</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ 😊 情绪表达 ═══ -->
  <div class="s-section">
    <div class="s-label" style="cursor:pointer" @click="showEmotion = !showEmotion">
      😊 情绪表达 <span style="flex:1"></span><span class="card-arrow">{{ showEmotion ? '▾' : '▸' }}</span>
    </div>

    <div v-if="showEmotion">
      <div v-if="emotionMappings.length === 0" class="s-hint">无情绪映射</div>
      <div v-else class="emotion-grid">
        <div v-for="em in emotionMappings" :key="em.key" class="emotion-row">
          <span class="tag-tip">{{ em.key }}</span>
          <span class="s-muted">→</span>
          <span>{{ em.expression }}</span>
          <span class="s-muted">{{ em.sound ? `🔊 ${em.sound}` : '🔇' }}</span>
        </div>
      </div>
      <div class="s-hint">Phase2 回复开头 [emo:key] 驱动，系统自动剥离</div>
    </div>
  </div>

  <!-- ═══ 👁 窗口监控 ═══ -->
  <div class="s-section">
    <div class="s-label">👁 窗口监控</div>
    <label class="chk"><input type="checkbox" v-model="wmEnabled" /><span>启用主动搭话</span></label>
    <div class="row-gap" style="margin-top:4px">
      <label>停留 <input class="inp-num" type="number" v-model.number="wmStaySeconds" />s</label>
      <label>防抖 <input class="inp-num" type="number" v-model.number="wmSettleMs" />ms</label>
    </div>
    <div class="row-gap">
      <label>全局冷却 <input class="inp-num" type="number" v-model.number="wmCooldownSec" />s</label>
      <label>同页冷却 <input class="inp-num" type="number" v-model.number="wmSamePageCool" />s</label>
    </div>
  </div>

  <!-- ═══ 🛡 安全 & 并发 ═══ -->
  <div class="s-section">
    <div class="s-label">🛡 安全 & 并发</div>
    <div class="radio-row">
      <span class="fn">策略</span>
      <label v-for="m in [{v:'just_do_it',l:'全放行'},{v:'tell_me',l:'告知确认'},{v:'let_me_tk',l:'全部确认'}]" :key="m.v" class="chk"><input type="radio" v-model="safetyMode" :value="m.v" /><span>{{ m.l }}</span></label>
    </div>
    <label class="chk"><input type="checkbox" v-model="sessionTrustEnabled" /><span>会话信任 NORMAL 工具</span></label>
    <div class="fld" style="margin-top:4px"><span class="fn">锁超时</span><input class="inp-num" type="number" v-model.number="lockTimeout" /> ms</div>
  </div>

  <!-- ═══ 🧠 记忆 ═══ -->
  <div class="s-section">
    <div class="s-label">🧠 记忆</div>
    <div class="fld"><span class="fn">上限</span><input class="inp-num" type="number" v-model.number="memMax" min="10" max="1000" /> 条</div>
    <div class="s-hint">{{ memStatus.count }} 条记忆 | 归档 {{ memStatus.projectCount ?? 0 }} | 会话 {{ memStatus.sessionTurns ?? 0 }} 轮 | {{ memStatus.lastConsolidation }}</div>
    <div class="fld-col" style="margin-top:4px"><span class="fn">CANDY.md 指令</span><textarea class="inp txa mono" v-model="candyInstructions" rows="2" placeholder="例如：叫我小明、用日语回复..."></textarea></div>
  </div>
</div>
</template>

<style scoped>
/* ── Card 网格 ── */
.card-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-item {
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 5px;
  overflow: hidden;
  transition: border-color .15s;
}
.card-item.active {
  border-color: var(--color-accent, #c4276f);
}
.card-item.selected {
  border-color: rgba(196,39,111,0.5);
  background: rgba(196,39,111,0.05);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  cursor: pointer;
  background: rgba(255,255,255,0.02);
}
.card-header:hover { background: rgba(255,255,255,0.04); }

.card-select { font-size: 11px; flex: 1; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.card-radio-dot { font-size: 13px; opacity: 0.5; min-width: 16px; }
.card-select:hover .card-radio-dot { opacity: 0.8; }

.card-radio { font-size: 11px; flex: 1; }
.card-name { font-weight: bold; }
.card-meta { display: flex; align-items: center; gap: 4px; }
.card-arrow { font-size: 9px; opacity: 0.5; min-width: 12px; text-align: center; }

.tag-tip.builtin { background: rgba(100,149,237,0.25); }
.tag-tip.user { background: rgba(144,238,144,0.25); }
.tag-tip.tag-warn { background: rgba(255,170,0,0.25); color: #fa0; }
.tag-tip.tag-ok { background: rgba(0,255,100,0.15); color: #0f8; }

/* ── 切换栏 ── */
.switch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 6px;
  background: rgba(255,255,255,0.03);
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.06);
}

/* ── Card 详情 ── */
.card-detail {
  padding: 4px 8px 6px;
  border-top: 1px solid rgba(255,255,255,0.04);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-section-preview {
  font-size: 9px;
}
.card-section-preview .fn {
  opacity: 0.5;
  font-size: 8px;
  margin-bottom: 1px;
}
.card-text {
  color: rgba(255,255,255,0.6);
  line-height: 1.3;
  padding-left: 4px;
  border-left: 1px solid rgba(255,255,255,0.1);
}

.card-stats {
  display: flex;
  gap: 8px;
  font-size: 9px;
  opacity: 0.4;
  margin-top: 2px;
}

/* ── stages 缺失提示 ── */
.stages-warn {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(255,170,0,0.1);
  border: 1px solid rgba(255,170,0,0.25);
  border-radius: 4px;
  font-size: 10px;
  color: #fa0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

/* ── 变量池 ── */
.pool-preview {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 10px;
  color: rgba(255,255,255,0.7);
  white-space: pre-wrap;
  line-height: 1.4;
  max-height: 160px;
  overflow-y: auto;
  margin: 4px 0;
}

/* ── 阶段文案表 ── */
.stage-table {
  font-size: 10px;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 4px;
  overflow: hidden;
}

.stage-th, .stage-tr {
  display: grid;
  grid-template-columns: 60px 70px 1fr;
  gap: 4px;
  padding: 2px 6px;
}

.stage-th {
  background: rgba(255,255,255,0.04);
  font-size: 9px;
  opacity: 0.5;
}

.stage-tr {
  border-top: 1px solid rgba(255,255,255,0.03);
}

.stage-text {
  color: rgba(255,255,255,0.7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 情绪映射 ── */
.emotion-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.emotion-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
}
.emotion-row:hover { background: rgba(255,255,255,0.03); }
</style>
