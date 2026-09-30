<script setup lang="ts">
// ==========================================
// 记忆管理面板
// ==========================================
//
// 数据操作（记住 / 纠正 / 遗忘 / 评审 / 发布 / 维护）都在这里独立提交，
// 不走设置页的「保存」按钮 —— 那条路径写的是 CONFIG，与记忆库是两回事。
// 每次写操作后重新读 revision，界面显示的永远是已提交状态。

import { computed, onMounted, ref } from "vue"
import {
  addMemoryCandidates, applyMemoryChange, backupMemory, cancelMemoryJob, exportMemory, memoryDetail,
  memoryList, memoryStatus, publishMemoryBatch, rebuildMemory, reviewMemoryBatch,
} from "@/services/agent/memory/ipc"
import type { MemoryCandidate, MemoryItem, MemoryScope, MemoryStatusSnapshot } from "@/services/agent/memory/ipc"
import { runDreamingSweep } from "@/services/agent/memory/dreaming"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MemoryTab")

const scope = ref<MemoryScope | "">("")
const status = ref<MemoryStatusSnapshot | null>(null)
const items = ref<MemoryItem[]>([])
const selected = ref<MemoryItem | null>(null)
const candidates = ref<MemoryCandidate[]>([])
const approved = ref<Set<string>>(new Set())
const editingContent = ref("")
const busy = ref(false)
const error = ref("")
const notice = ref("")
const lastJobId = ref("")
const sweeping = ref(false)

const pendingCount = computed(() => status.value?.candidateCount ?? 0)

function clearMessage(): void {
  error.value = ""
  notice.value = ""
}

async function refresh(): Promise<void> {
  busy.value = true
  try {
    status.value = await memoryStatus()
    items.value = await memoryList(scope.value || undefined, undefined, 200)
  } catch (e) {
    error.value = formatError(e)
  } finally {
    busy.value = false
  }
}

async function openItem(item: MemoryItem): Promise<void> {
  clearMessage()
  try {
    selected.value = await memoryDetail(item.id)
    editingContent.value = selected.value?.draft.content ?? ""
  } catch (e) {
    error.value = formatError(e)
  }
}

/** 纠正：同一 id 写新版本，旧版本转 superseded，历史仍可查。 */
async function saveCorrection(): Promise<void> {
  const target = selected.value
  if (!target) return
  const content = editingContent.value.trim()
  if (!content || content === target.draft.content) return
  clearMessage()
  busy.value = true
  try {
    const revision = await applyMemoryChange({
      operationId: `edit-${crypto.randomUUID()}`,
      baseRevision: status.value?.revision ?? 0,
      action: "update",
      itemId: target.id,
      expectedVersion: target.version,
      draft: { ...target.draft, content, summary: content.slice(0, 120) },
    })
    notice.value = `已提交纠正（revision ${revision}）`
    await refresh()
    await openItem(target)
  } catch (e) {
    error.value = `纠正未提交：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

/**
 * 忘记：只清应用管理的记忆与它的回灌资格。
 * 原始聊天、已导出的文件、外部备份不在这一步里删除，界面必须说清楚。
 */
async function forgetSelected(): Promise<void> {
  const target = selected.value
  if (!target) return
  clearMessage()
  busy.value = true
  try {
    const revision = await applyMemoryChange({
      operationId: `forget-${crypto.randomUUID()}`,
      baseRevision: status.value?.revision ?? 0,
      action: "forget",
      itemId: target.id,
    })
    notice.value = `已忘记这条记忆（revision ${revision}）：原始聊天与外部备份不受影响`
    selected.value = null
    await refresh()
  } catch (e) {
    error.value = `遗忘未提交：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

/** 整理：Light + Review 只产出待审候选，绝不自动写入。 */
async function runSweep(): Promise<void> {
  clearMessage()
  sweeping.value = true
  try {
    const outcome = await runDreamingSweep()
    lastJobId.value = outcome.jobId ?? ""
    if (outcome.status === "failed") error.value = `整理失败：${outcome.message ?? "未知原因"}`
    else if (outcome.status === "empty") notice.value = "没有新的可信用户输入需要整理。"
    else notice.value = `整理完成：处理 ${outcome.sourcesProcessed} 条来源，新增 ${outcome.candidatesAdded} 条待审候选`
    if (outcome.oversized.length > 0) {
      notice.value += `；${outcome.oversized.length} 条来源过大，已整条跳过待你挑选片段`
    }
    await refresh()
    await loadCandidates()
  } catch (e) {
    error.value = formatError(e)
  } finally {
    sweeping.value = false
  }
}

async function loadCandidates(): Promise<void> {
  if (!lastJobId.value) return
  try {
    candidates.value = await reviewMemoryBatch(lastJobId.value)
    // 评审默认不批准任何候选：用户必须逐条看过正文、范围和来源后再勾选。
    approved.value = new Set()
  } catch (e) {
    error.value = formatError(e)
  }
}

function toggleApproved(id: string): void {
  const next = new Set(approved.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  approved.value = next
}

/** 发布：只提交用户勾选且审核过的候选；基准过期由 Rust 拒绝，不静默覆盖。 */
async function publishApproved(): Promise<void> {
  clearMessage()
  const ids = [...approved.value]
  if (ids.length === 0 || !lastJobId.value) return
  busy.value = true
  try {
    const revision = await publishMemoryBatch(lastJobId.value, ids, status.value?.revision ?? 0)
    notice.value = `已发布 ${ids.length} 条记忆（revision ${revision}）`
    await refresh()
    await loadCandidates()
  } catch (e) {
    error.value = `发布未提交（基准可能已过期）：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

async function runMaintenance(action: "backup" | "export" | "rebuild"): Promise<void> {
  clearMessage()
  busy.value = true
  try {
    if (action === "backup") notice.value = `备份已生成：${await backupMemory()}`
    if (action === "export") notice.value = `只读导出已生成：${await exportMemory()}`
    if (action === "rebuild") notice.value = `索引已重建：${await rebuildMemory()} 条`
    await refresh()
  } catch (e) {
    error.value = formatError(e)
  } finally {
    busy.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <div class="memory-tab">
    <div class="s-section">
      <div class="s-label">🧠 已记住</div>
      <div class="memory-toolbar">
        <select class="inp" v-model="scope" @change="refresh">
          <option value="">全部范围</option>
          <option value="user">用户</option>
          <option value="card">Card</option>
          <option value="session">会话</option>
        </select>
        <button class="btn-s" :disabled="busy" @click="refresh">↻ 刷新</button>
      </div>
      <div v-if="status" class="s-hint">
        库版本 revision {{ status.revision }} · {{ status.itemCount }} 条已记住 · {{ pendingCount }} 条待审 · {{ status.jobCount }} 个作业
      </div>
      <div v-if="items.length === 0" class="s-hint">当前范围没有已记住的内容。</div>
      <button v-for="item in items" :key="`${item.id}:${item.version}`" class="memory-row" @click="openItem(item)">
        <span class="memory-row-main">
          <strong>{{ item.draft.summary || item.draft.content }}</strong>
          <small>{{ item.draft.kind }} · {{ item.draft.scope }}{{ item.draft.scopeId ? `/${item.draft.scopeId}` : "" }} · v{{ item.version }}</small>
        </span>
        <span class="memory-row-meta">{{ item.draft.pinned ? "核心画像" : "" }}</span>
      </button>
    </div>

    <div v-if="selected" class="s-section">
      <div class="s-label">条目详情与纠正</div>
      <div class="memory-detail">
        类型：{{ selected.draft.kind }}　范围：{{ selected.draft.scope }}　状态：{{ selected.status }}　版本：{{ selected.version }}<br />
        来源：{{ selected.draft.sourceIds.join(", ") || "无" }}<br />
        重要性：{{ selected.draft.importance }}　置信度：{{ selected.draft.confidence }}
      </div>
      <textarea class="inp memory-editor" v-model="editingContent" rows="3"></textarea>
      <div class="memory-toolbar">
        <button class="btn-s" :disabled="busy" @click="saveCorrection">保存纠正</button>
        <button class="btn-s" :disabled="busy" @click="forgetSelected">忘记这条</button>
      </div>
      <div class="s-hint">
        忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。
      </div>
    </div>

    <div class="s-section">
      <div class="s-label">整理与待评审</div>
      <div class="memory-toolbar">
        <button class="btn-s" :disabled="sweeping || busy" @click="runSweep">整理新增对话</button>
        <button class="btn-s" :disabled="busy || !lastJobId || pendingCount === 0" @click="loadCandidates">载入待审</button>
        <button class="btn-s" :disabled="busy || approved.size === 0" @click="publishApproved">发布勾选（{{ approved.size }}）</button>
      </div>
      <div class="s-hint">整理只产出待审候选，不会自动写入；发布时才要求库版本没有变过。</div>
      <div v-if="candidates.length === 0" class="s-hint">没有待审候选。</div>
      <div v-for="candidate in candidates" :key="candidate.id" class="memory-row memory-candidate">
        <label class="memory-row-main">
          <span><input type="checkbox" :checked="approved.has(candidate.id)" @change="toggleApproved(candidate.id)" /> {{ candidate.draft.content }}</span>
          <small>{{ candidate.draft.kind }} · {{ candidate.draft.scope }} · 来源 {{ candidate.draft.sourceIds.join(", ") }}</small>
          <small v-if="candidate.reason">理由：{{ candidate.reason }}</small>
        </label>
      </div>
    </div>

    <div class="s-section">
      <div class="s-label">导出与维护</div>
      <div class="memory-toolbar">
        <button class="btn-s" :disabled="busy" @click="runMaintenance('backup')">一致性备份</button>
        <button class="btn-s" :disabled="busy" @click="runMaintenance('export')">导出只读视图</button>
        <button class="btn-s" :disabled="busy" @click="runMaintenance('rebuild')">重建索引</button>
      </div>
      <div class="s-hint">索引可随时重建；重建不会让已遗忘的内容回来。</div>
    </div>

    <div v-if="error" class="s-error">{{ error }}</div>
    <div v-if="notice" class="s-saved">{{ notice }}</div>
  </div>
</template>

<style scoped>
.memory-tab { display: flex; flex-direction: column; gap: 4px; }
.memory-toolbar { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.memory-row { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; padding: 5px 6px; margin-top: 3px; border: 1px solid rgba(255, 255, 255, .08); background: rgba(0, 0, 0, .12); color: inherit; cursor: pointer; }
.memory-row:hover { border-color: var(--color-accent, #c4276f); }
.memory-candidate { cursor: default; }
.memory-row-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.memory-row-main strong, .memory-row-main span { overflow: hidden; text-overflow: ellipsis; }
.memory-row-main small, .memory-row-meta { opacity: .65; font-size: 9px; }
.memory-detail { padding: 6px; line-height: 1.6; background: rgba(0, 0, 0, .12); white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-editor { width: 100%; margin-top: 4px; }
</style>
