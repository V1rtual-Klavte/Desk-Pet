<script setup lang="ts">
// ==========================================
// 记忆管理面板
// ==========================================
//
// 数据操作（纠正 / 遗忘 / 维护）都在这里独立提交，
// 不走设置页的「保存」按钮 —— 那条路径写的是 CONFIG，与记忆库是两回事。
// 每次写操作后重新读 revision，界面显示的永远是已提交状态。

import { onMounted, onUnmounted, ref } from "vue"
import {
  applyMemoryChange, backupMemory, exportMemory, memoryDetail,
  memoryHistory, memoryJobList, memoryList, memoryRestorePreview, memorySourceEvidence, memoryStatus, rebuildMemory, restoreMemory,
} from "@/services/agent/memory/ipc"
import type { MemoryHistoryEntry, MemoryItem, MemoryScope, MemoryStatusSnapshot } from "@/services/agent/memory/ipc"
import { runDreamingSweep } from "@/services/agent/memory/dreaming"
import type { DreamingOutcome } from "@/services/agent/memory/dreaming"
import { formatError } from "@/services/error"
import { initMemoryRevisionSync, publishMemoryRevision, subscribeMemoryRevision } from "@/services/agent/memory"

const scope = ref<MemoryScope | "">("")
const status = ref<MemoryStatusSnapshot | null>(null)
const items = ref<MemoryItem[]>([])
const jobs = ref<Awaited<ReturnType<typeof memoryJobList>>>([])
const selected = ref<MemoryItem | null>(null)
const history = ref<MemoryHistoryEntry[]>([])
const sourceEvidence = ref<Record<string, string | null>>({})
const loadingEvidence = ref<Record<string, boolean>>({})
const editingContent = ref("")
const busy = ref(false)
const error = ref("")
const notice = ref("")
const lastJobId = ref("")
const backupPath = ref("")
const previewedBackupPath = ref("")
const restorePreview = ref<Awaited<ReturnType<typeof memoryRestorePreview>> | null>(null)
const sweeping = ref(false)
const lastSweep = ref<DreamingOutcome | null>(null)
let sweepController: AbortController | null = null
let unsubscribeRevision: (() => void) | null = null

function clearMessage(): void {
  error.value = ""
  notice.value = ""
}

async function refresh(): Promise<void> {
  busy.value = true
  try {
    status.value = await memoryStatus()
    const [nextItems, nextJobs] = await Promise.all([
      memoryList(scope.value || undefined, undefined, 200),
      memoryJobList(50, 0),
    ])
    items.value = nextItems
    jobs.value = nextJobs
  } catch (e) {
    error.value = formatError(e)
  } finally {
    busy.value = false
  }
}

async function openItem(item: MemoryItem): Promise<void> {
  clearMessage()
  try {
    const [detail, versions] = await Promise.all([memoryDetail(item.id), memoryHistory(item.id)])
    selected.value = detail
    history.value = versions
    sourceEvidence.value = {}
    editingContent.value = selected.value?.draft.content ?? ""
  } catch (e) {
    error.value = formatError(e)
  }
}

/** 原话只按已审计 sourceId 按需从 Rust 解引用，遗忘/抑制后的来源由后端返回 null。 */
async function revealSource(sourceId: string): Promise<void> {
  if (loadingEvidence.value[sourceId]) return
  loadingEvidence.value[sourceId] = true
  try {
    const source = await memorySourceEvidence(sourceId)
    sourceEvidence.value[sourceId] = source?.evidence ?? null
  } catch (e) {
    sourceEvidence.value[sourceId] = null
    error.value = formatError(e)
  } finally {
    loadingEvidence.value[sourceId] = false
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
  let committedRevision: number | undefined
  try {
    committedRevision = await applyMemoryChange({
      operationId: `edit-${crypto.randomUUID()}`,
      baseRevision: status.value?.revision ?? 0,
      action: "update",
      itemId: target.id,
      expectedVersion: target.version,
      actor: "user_ui",
      draft: { ...target.draft, content, summary: content.slice(0, 120) },
    })
    await publishMemoryRevision(committedRevision)
    notice.value = `已提交纠正并同步运行记忆（revision ${committedRevision}）`
    await refresh()
    await openItem(target)
  } catch (e) {
    if (committedRevision !== undefined) {
      notice.value = `纠正已提交（revision ${committedRevision}），但同步失败；运行中的旧记忆可能仍在收口：${formatError(e)}`
      await refresh()
      await openItem(target)
    } else error.value = `纠正未提交：${formatError(e)}`
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
  let committedRevision: number | undefined
  try {
    committedRevision = await applyMemoryChange({
      operationId: `forget-${crypto.randomUUID()}`,
      baseRevision: status.value?.revision ?? 0,
      action: "forget",
      actor: "user_ui",
      itemId: target.id,
      expectedVersion: target.version,
    })
    selected.value = null
    await publishMemoryRevision(committedRevision)
    notice.value = `已忘记这条记忆（revision ${committedRevision}）：原始聊天与外部备份不受影响`
    await refresh()
  } catch (e) {
    if (committedRevision !== undefined) {
      notice.value = `已忘记这条记忆（revision ${committedRevision}），但同步失败；运行中的旧记忆可能仍在收口：${formatError(e)}`
      await refresh()
    } else error.value = `遗忘未提交：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

/** 核心画像标记属于用户治理字段，保留完整草稿与来源，只更新 pinned。 */
async function togglePinned(): Promise<void> {
  const target = selected.value
  if (!target) return
  clearMessage()
  busy.value = true
  let committedRevision: number | undefined
  try {
    committedRevision = await applyMemoryChange({
      operationId: `pin-${crypto.randomUUID()}`,
      baseRevision: status.value?.revision ?? 0,
      action: "update",
      itemId: target.id,
      expectedVersion: target.version,
      actor: "user_ui",
      draft: { ...target.draft, pinned: !target.draft.pinned },
    })
    await publishMemoryRevision(committedRevision)
    notice.value = `${target.draft.pinned ? "已从核心画像移除" : "已加入核心画像"}（revision ${committedRevision}）`
    await refresh()
    await openItem(target)
  } catch (e) {
    if (committedRevision !== undefined) {
      notice.value = `核心画像标记已提交（revision ${committedRevision}），但同步失败：${formatError(e)}`
      await refresh()
      await openItem(target)
    } else error.value = `核心画像标记未提交：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

/** 整理：提交结果由 Rust 原子落库，面板只呈现最终结果。 */
async function runSweep(resumeJobId?: string): Promise<void> {
  clearMessage()
  sweeping.value = true
  sweepController = new AbortController()
  try {
    const outcome = await runDreamingSweep({ signal: sweepController.signal, ...(resumeJobId ? { resumeJobId } : {}) })
    lastSweep.value = outcome
    lastJobId.value = outcome.jobId ?? ""
    if (outcome.status === "failed") error.value = `整理失败：${outcome.message ?? "未知原因"}`
    else if (outcome.status === "empty") notice.value = "没有新的可信用户输入需要整理。"
    else if (outcome.status === "cancelled") notice.value = `整理已取消：处理 ${outcome.sourcesProcessed} 条来源；已提交内容不会回滚。`
    else notice.value = `整理并自动提交完成：处理 ${outcome.sourcesProcessed} 条来源，提交 ${outcome.publishedCount} 条记忆`
    if (outcome.publishedCount > 0) {
      try {
        const committedRevision = (await memoryStatus()).revision
        await publishMemoryRevision(committedRevision)
        notice.value += `（revision ${committedRevision}，运行记忆已同步）`
      } catch (e) {
        notice.value = `整理已提交 ${outcome.publishedCount} 条记忆，但同步失败：${formatError(e)}`
      }
    }
    if (outcome.oversized.length > 0) {
      notice.value += `；${outcome.oversized.length} 条来源过大，已整条跳过待你挑选片段`
    }
    await refresh()
    if (selected.value) await openItem(selected.value)
  } catch (e) {
    error.value = formatError(e)
  } finally {
    sweeping.value = false
    sweepController = null
  }
}

function cancelSweep(): void {
  sweepController?.abort()
}

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at)
}

async function runMaintenance(action: "backup" | "export" | "rebuild"): Promise<void> {
  clearMessage()
  busy.value = true
  try {
    if (action === "backup") {
      backupPath.value = await backupMemory()
      restorePreview.value = null
      notice.value = `备份已生成：${backupPath.value}`
    }
    if (action === "export") notice.value = `只读导出已生成：${await exportMemory()}`
    if (action === "rebuild") notice.value = `索引已重建：${await rebuildMemory()} 条`
    await refresh()
  } catch (e) {
    error.value = formatError(e)
  } finally {
    busy.value = false
  }
}

async function previewRestore(): Promise<void> {
  clearMessage()
  restorePreview.value = null
  try {
    previewedBackupPath.value = backupPath.value.trim()
    restorePreview.value = await memoryRestorePreview(previewedBackupPath.value)
  } catch (e) {
    previewedBackupPath.value = ""
    error.value = `无法预览备份：${formatError(e)}`
  }
}

async function applyRestore(): Promise<void> {
  if (!restorePreview.value || !backupPath.value.trim() || backupPath.value.trim() !== previewedBackupPath.value) return
  clearMessage()
  busy.value = true
  let committedRevision: number | undefined
  try {
    committedRevision = await restoreMemory(backupPath.value.trim())
    restorePreview.value = null
    await publishMemoryRevision(committedRevision)
    notice.value = `已恢复备份并同步运行记忆（revision ${committedRevision}）`
    await refresh()
    if (selected.value) await openItem(selected.value)
  } catch (e) {
    if (committedRevision !== undefined) {
      notice.value = `备份恢复已提交（revision ${committedRevision}），但同步失败：${formatError(e)}`
      await refresh()
    } else error.value = `备份未恢复：${formatError(e)}`
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  unsubscribeRevision = subscribeMemoryRevision(async () => {
    await refresh()
    if (selected.value) await openItem(selected.value)
  })
  void initMemoryRevisionSync().then(refresh).catch(e => { error.value = formatError(e) })
})
onUnmounted(() => { unsubscribeRevision?.(); unsubscribeRevision = null })
</script>

<template>
  <div class="memory-tab">
    <div class="s-section">
      <div class="s-label">已记住</div>
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
        库版本 revision {{ status.revision }} · {{ status.itemCount }} 条当前记忆 · {{ status.jobCount }} 个整理作业
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
        重要性：{{ selected.draft.importance }}　置信度：{{ selected.draft.confidence }}<br />
        发生时间：{{ selected.draft.eventAt ? JSON.stringify(selected.draft.eventAt) : "未记录" }}<br />
        提醒时间：{{ selected.draft.dueAt ? JSON.stringify(selected.draft.dueAt) : "未记录" }}<br />
        事项状态：{{ selected.draft.workingState ?? "不适用" }}
      </div>
      <textarea class="inp memory-editor" v-model="editingContent" rows="3"></textarea>
      <div class="memory-toolbar">
        <button class="btn-s" :disabled="busy" @click="saveCorrection">保存纠正</button>
        <button class="btn-s" :disabled="busy" @click="togglePinned">{{ selected.draft.pinned ? "移出核心画像" : "加入核心画像" }}</button>
        <button class="btn-s" :disabled="busy" @click="forgetSelected">忘记这条</button>
      </div>
      <div class="s-hint">
        忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。
      </div>
      <div class="memory-history">
        <div class="s-label">历史版本与来源审计</div>
        <div v-if="history.length === 0" class="s-hint">没有可显示的历史版本。</div>
        <article v-for="entry in history" :key="`${entry.item.id}:${entry.item.version}`" class="memory-history-entry">
          <strong>v{{ entry.item.version }} · {{ entry.item.status }} · {{ formatTime(entry.item.updatedAt) }}</strong>
          <div>{{ entry.item.draft.content }}</div>
          <small v-if="entry.sourceAudits.length === 0">来源审计已不可用。</small>
          <small v-for="source in entry.sourceAudits" :key="source.sourceId" class="memory-evidence">
            {{ source.origin }}/{{ source.taint }} · event {{ source.eventId }} · session {{ source.sessionId }} · entry {{ source.entryId }} · seq {{ source.seq }} · {{ formatTime(source.observedAt) }} · sha256 {{ source.contentHash }}
            <button type="button" class="btn-s" :disabled="loadingEvidence[source.sourceId]" @click="revealSource(source.sourceId)">{{ loadingEvidence[source.sourceId] ? "读取中…" : source.sourceId in sourceEvidence ? "刷新原话" : "查看原话" }}</button>
            <span v-if="source.sourceId in sourceEvidence" class="memory-source-quote">{{ sourceEvidence[source.sourceId] ?? "原话不可用（来源已遗忘、抑制或不再保留）" }}</span>
          </small>
        </article>
      </div>
    </div>

    <div class="s-section">
      <div class="s-label">自动整理</div>
      <div class="memory-toolbar">
        <button class="btn-s" :disabled="sweeping || busy" @click="runSweep()">整理新增对话</button>
        <button v-if="sweeping" class="btn-s" :disabled="busy" @click="cancelSweep">取消整理</button>
      </div>
      <div class="s-hint">整理作业自动提交完成的候选；冲突、失败或取消会显示明确终态。未经用户输入绑定的候选不会发布。</div>
      <div v-if="lastSweep" class="memory-detail">
        状态：{{ lastSweep.status }}<br />
        作业：{{ lastSweep.jobId ?? "无" }}<br />
        处理来源：{{ lastSweep.sourcesProcessed }}　生成候选：{{ lastSweep.candidatesAdded }}　自动提交：{{ lastSweep.publishedCount }}<br />
        <template v-if="lastSweep.budget">预算日：{{ lastSweep.budget.localDate }}　预留：{{ lastSweep.budget.reservedTokens }} tokens　使用：{{ lastSweep.budget.usedTokens }} tokens<br /></template>
        <span v-if="lastSweep.message">详情：{{ lastSweep.message }}</span>
      </div>
      <div v-else class="s-hint">尚未在此打开的面板中执行整理。</div>
      <div v-if="lastJobId" class="s-hint">最后一次作业：{{ lastJobId }}</div>
      <div class="memory-history">
        <div class="s-label">历史作业</div>
        <div v-if="jobs.length === 0" class="s-hint">暂无整理作业。</div>
        <div v-for="job in jobs" :key="job.id" class="memory-history-entry">
          <strong>{{ job.phase }} · {{ job.status }} · {{ formatTime(job.updatedAt) }}</strong>
          <small>作业 {{ job.id }} · revision {{ job.revision }} · 已处理 {{ job.processed }} 条</small>
          <button v-if="job.phase === 'review' && ['paused', 'cancelled', 'failed'].includes(job.status)" type="button" class="btn-s" :disabled="sweeping || busy" @click="runSweep(job.id)">继续此作业</button>
        </div>
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
      <div class="memory-toolbar">
        <input class="inp memory-path" v-model="backupPath" placeholder="备份文件路径（或先生成一致性备份）" />
        <button class="btn-s" :disabled="busy || !backupPath.trim()" @click="previewRestore">预览恢复</button>
      </div>
      <div v-if="restorePreview && backupPath.trim() === previewedBackupPath" class="memory-detail">
        <strong>恢复预览</strong><br />
        Schema {{ restorePreview.schemaVersion }} · revision {{ restorePreview.revision }} · 忘记代 {{ restorePreview.forgetEpoch }}<br />
        {{ restorePreview.itemCount }} 条记忆 · {{ restorePreview.jobCount }} 个作业<br />
        应用恢复会替换当前库内容，当前遗忘决定仍优先。<br />
        <button class="btn-s" :disabled="busy" @click="applyRestore">应用此备份</button>
      </div>
    </div>

    <div v-if="error" class="s-error">{{ error }}</div>
    <div v-if="notice" class="s-saved">{{ notice }}</div>
  </div>
</template>

<style scoped>
.memory-tab { display: flex; flex-direction: column; gap: 4px; }
.memory-toolbar { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.memory-row { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; padding: 5px 6px; margin-top: 3px; border: 1px solid var(--color-divider, rgba(255, 255, 255, .08)); background: var(--color-surface-dark, rgba(0, 0, 0, .12)); color: inherit; cursor: pointer; }
.memory-row:hover { border-color: var(--color-accent, #c4276f); }
.memory-candidate { cursor: default; }
.memory-row-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.memory-row-main strong, .memory-row-main span { overflow: hidden; text-overflow: ellipsis; }
.memory-row-main small, .memory-row-meta { opacity: .65; font-size: 9px; }
.memory-evidence { opacity: .8; white-space: normal; overflow-wrap: anywhere; }
.memory-detail { padding: 6px; line-height: 1.6; background: var(--color-surface-dark, rgba(0, 0, 0, .12)); white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-history { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.memory-history-entry { display: flex; flex-direction: column; gap: 3px; padding: 6px; background: var(--color-surface-dark, rgba(0, 0, 0, .12)); overflow-wrap: anywhere; }
.memory-editor { width: 100%; margin-top: 4px; }
.memory-path { min-width: 220px; flex: 1; }
</style>
