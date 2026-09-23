<script setup lang="ts">
import { ref, onMounted } from "vue";
import { toolsConfig, loopConfig, MIN_PARALLEL_TOOLS, MAX_PARALLEL_TOOLS } from "@/services/config";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";
// 纯文本工具函数，同步使用；其余 MCP 生命周期 API 仍按需动态 import
import { parseEnvText, formatEnvText } from "@/services/tool/mcp";

const log = createLogger("Settings");

// Props: 父组件传入的 assistantMode，用于显示扩展能力状态
const props = defineProps<{ assistantMode: boolean }>();

// ── Bash ──
const bashWhitelist = ref(toolsConfig.bashWhitelist.join("\n"));

// ── 文件 ──
const fileWriteEnabled = ref(toolsConfig.fileWriteEnabled);

// ── 工具执行并发 ──
// 共享读上限：范围校验在 SettingsPanel.doSave 里按 parallelToolsError 拒绝越界值，
// 这里只做初值读取与控件提示。
const maxParallelTools = ref(loopConfig.maxParallelTools);

// ── MCP ──
const mcpEnabled = ref(toolsConfig.mcpEnabled);

const mcpServerList = ref<
  { name: string; transport: string; command: string; args: string; url: string; envStr: string; enabled: boolean }[]
>([]);
const editingMcpIdx = ref(-1);
const mcpForm = ref({ name: "", transport: "stdio", command: "", args: "", url: "", envStr: "", enabled: true });
const builtinMcpList = ref<
  { name: string; enabled: boolean; args: string; description: string; envStr: string }[]
>([]);
const editingBuiltinIdx = ref(-1);
const mcpTesting = ref(false);
const mcpTestResult = ref("");

// ── Skill ──
const skillEnabled = ref(toolsConfig.skillEnabled);
const skillList = ref<{ id: string; name: string; description: string }[]>([]);
/** 索引不可用时的状态位（§7 #20）：空列表本身区分不出「失败」与「没有 Skill」 */
const skillIndexError = ref<string>("");

// ── 内置 MCP ──
async function loadBuiltinMcpConfig() {
  const raw = toolsConfig.builtinMcpServers as Record<string, any>;
  if (!raw || typeof raw !== "object") {
    builtinMcpList.value = [];
    return;
  }
  builtinMcpList.value = Object.entries(raw).map(([name, def]: [string, any]) => ({
    name,
    enabled: def.enabled !== false,
    args: Array.isArray(def.args) ? def.args.join(" ") : def.args ? String(def.args) : "",
    description: def.description ?? name,
    envStr: formatEnvText(def.env),
  }));
}

function toggleBuiltinMcp(idx: number) {
  builtinMcpList.value[idx].enabled = !builtinMcpList.value[idx].enabled;
}

function startEditBuiltin(idx: number) {
  editingBuiltinIdx.value = idx;
}

function cancelEditBuiltin() {
  editingBuiltinIdx.value = -1;
}

// ── 自定义 MCP ──
async function loadMcpConfig() {
  const servers = toolsConfig.mcpServers;
  if (Array.isArray(servers) && servers.length > 0) {
    mcpServerList.value = servers.map((s: any) => ({
      name: String(s.name || ""),
      transport: s.transport === "sse" ? "sse" : "stdio",
      command: s.command ? String(s.command) : "",
      args: Array.isArray(s.args) ? s.args.join(" ") : s.args ? String(s.args) : "",
      url: s.url ? String(s.url) : "",
      envStr: formatEnvText(s.env),
      enabled: s.enabled !== false,
    }));
  }
}

function addOrUpdateMcpServer() {
  const s = mcpForm.value;
  if (!s.name.trim()) return;
  if (editingMcpIdx.value >= 0) {
    mcpServerList.value[editingMcpIdx.value] = { ...s };
  } else {
    mcpServerList.value.push({ ...s });
  }
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", envStr: "", enabled: true };
  editingMcpIdx.value = -1;
}

function editMcpServer(idx: number) {
  editingMcpIdx.value = idx;
  mcpForm.value = { ...mcpServerList.value[idx] };
}

function removeMcpServer(idx: number) {
  mcpServerList.value.splice(idx, 1);
  if (editingMcpIdx.value === idx) cancelMcpEdit();
}

function cancelMcpEdit() {
  editingMcpIdx.value = -1;
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", envStr: "", enabled: true };
}

async function importMcpJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { importMcpServersFromJson } = await import("@/services/tool/mcp");
    // 必须 await：写回 CONFIG 是异步的，不等它就会读到还没更新的旧列表
    const result = await importMcpServersFromJson(text);
    if (!result.success) {
      const { showFailure } = await import("@/services/dialog");
      await showFailure(result.error ?? "导入失败", { title: "MCP 导入失败" });
      return;
    }
    await loadMcpConfig();
  };
  input.click();
}

async function exportMcpJson() {
  const { exportMcpServersToJson } = await import("@/services/tool/mcp");
  const json = exportMcpServersToJson();
  // env 是明文写进文件的：导出后文件可以随手转发，必须让用户知道里面有什么
  if (json.includes('"env"')) {
    const { confirmDialog } = await import("@/services/dialog");
    const accepted = await confirmDialog(
      "导出的文件包含明文 API Key 等凭据，请勿随意外发。",
      { title: "确认导出", detail: `共 ${mcpServerList.value.length} 个服务器`, okLabel: "仍然导出" },
    );
    if (!accepted) return;
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mcp-servers.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function testMcpConnection() {
  const s = mcpForm.value;
  if (!s.name.trim() || !s.command.trim()) {
    mcpTestResult.value = "❌ 请先填写名称和命令";
    return;
  }
  mcpTesting.value = true;
  mcpTestResult.value = "⏳ 连接中...";
  const name = s.name.trim();
  try {
    const { connectMcpServer, disconnectMcpServer, isMcpServerConnected } = await import("@/services/tool/mcp");
    // 本来就没连的服务器，测完立刻回收：否则子进程与已注册的工具会一直留着。
    // 正在被回合持有的连接会拒绝重连，避免测试按钮终止运行中的 MCP 工具。
    const wasConnected = isMcpServerConnected(name);
    const r = await connectMcpServer({
      name,
      transport: s.transport as "stdio" | "sse",
      command: s.command.trim(),
      args: s.args.trim() ? s.args.trim().split(/\s+/) : [],
      url: s.url.trim() || undefined,
      // env 必须带上：不传的话带 API Key 的服务器永远测不出真实结果
      env: parseEnvText(s.envStr),
      enabled: s.enabled,
    });
    if (!wasConnected && r.success) await disconnectMcpServer(name);
    mcpTestResult.value = r.success
      ? `✅ 连接成功！${r.toolCount} 个工具`
      : `❌ 失败: ${r.error}`;
  } catch (e) {
    mcpTestResult.value = `❌ 异常: ${formatError(e)}`;
  }
  mcpTesting.value = false;
}

// ── Skill ──
async function loadSkillConfig() {
  const { ensureSkillCatalog, listSkills, getSkillCatalogFingerprint } = await import("@/services/skill");
  await ensureSkillCatalog();
  // 索引读取失败时 loader 会把指纹置为失败哨兵（loader.ts 的 "unavailable"）并返回空列表：
  // 设置页要把「索引不可用」和「真的没有 Skill」分开显示，不能只留一个「暂无」。
  skillIndexError.value = getSkillCatalogFingerprint() === "unavailable"
    ? "Skill 索引不可用：本地元数据读取失败（原因见日志），当前不会注入任何 Skill"
    : "";
  skillList.value = listSkills().map((s) => ({
    id: s.name,
    name: s.name,
    description: s.description,
  }));
}

async function removeSkill(skillId: string) {
  const { deleteSkill } = await import("@/services/skill");
  await deleteSkill(skillId);
  await loadSkillConfig();
}

async function uploadSkillMd() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { upsertSkill } = await import("@/services/skill");
    await upsertSkill(text);
    await loadSkillConfig();
  };
  input.click();
}

// ── 工具策略（只读声明） ──
interface ToolPolicyRow {
  id: string;
  name: string;
  audience: string;
  summary: string;
}
const toolPolicyRows = ref<ToolPolicyRow[]>([]);
/** 读取失败时保留原因并替代「读取中…」，避免永久停在加载态 */
const toolPolicyError = ref<string>("");

const PERMISSION_LABELS: Record<string, string> = { allow: "允许", ask: "询问", deny: "拒绝", passthrough: "交给策略" };
const ISOLATION_LABELS: Record<string, string> = { shared_read: "只读并行", exclusive_effect: "效果互斥", delegate: "编排串行" };

async function loadToolPolicies() {
  try {
    toolPolicyError.value = "";
    // 设置窗口有独立的注册表实例：注册内置工具只为读取静态声明，不借用许可、不连接 MCP。
    const { registerDefaultTools, registerAssistantTools, listAll } = await import("@/services/tool/registry");
    await registerDefaultTools();
    await registerAssistantTools();
    toolPolicyRows.value = listAll()
      .map(tool => ({
        id: tool.id,
        name: tool.name,
        audience: tool.mode === "pet" ? "两模式" : "仅助手",
        summary: [
          PERMISSION_LABELS[tool.policy.permission.defaultDecision] ?? tool.policy.permission.defaultDecision,
          ISOLATION_LABELS[tool.policy.execution.isolation] ?? tool.policy.execution.isolation,
          tool.policy.context.resultProjection === "preserve" ? "结果原样" : "结果可引用",
          tool.policy.context.historyCompaction === "retain" ? "历史保留原文" : "历史随轮摘要",
        ].join(" · "),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    toolPolicyError.value = `读取工具策略声明失败：${formatError(error)}`
    log.error("读取工具策略声明失败:", formatError(error));
  }
}

// ── 生命周期 ──
onMounted(async () => {
  await loadMcpConfig();
  loadBuiltinMcpConfig();
  await loadSkillConfig();
  void loadToolPolicies();
});

defineExpose({
  bashWhitelist,
  fileWriteEnabled,
  maxParallelTools,
  mcpEnabled,
  mcpServerList,
  builtinMcpList,
  skillEnabled,
  loadMcpConfig,
  loadSkillConfig,
});
</script>

<template>
  <div>
  <div class="s-section">
    <div class="s-label">💻 Bash 白名单</div>
    <textarea class="inp txa mono" v-model="bashWhitelist" rows="4" placeholder="ls&#10;cat&#10;grep..."></textarea>
    <div class="s-hint">{{ bashWhitelist.split('\n').filter(l => l.trim()).length }} 个命令</div>
  </div>

  <div class="s-section">
    <div class="s-label">📁 文件工作流</div>
    <label class="chk"><input type="checkbox" v-model="fileWriteEnabled" /><span>允许写入/编辑文件（两个模式均可用，执行时按策略确认）</span></label>
  </div>

  <div class="s-section">
    <div class="s-label">🔀 工具执行</div>
    <div class="fld">
      <span class="fn">只读并行</span>
      <input class="inp-num" type="number" :min="MIN_PARALLEL_TOOLS" :max="MAX_PARALLEL_TOOLS" v-model.number="maxParallelTools" />
      <span class="s-muted">同时执行的只读工具数（{{ MIN_PARALLEL_TOOLS }}-{{ MAX_PARALLEL_TOOLS }}）</span>
    </div>
    <div class="s-hint">效果类工具仍与其它执行互斥；保存后从下一次运行开始生效。</div>
  </div>

  <div class="s-section">
    <div class="s-label">🧾 工具策略（声明）</div>
    <div class="s-hint">工具在代码里声明的默认策略，不代表本次运行的有效授权；实际执行仍按本次参数与权限终裁。</div>
    <div v-if="toolPolicyError" class="s-error">{{ toolPolicyError }}</div>
    <div v-else-if="toolPolicyRows.length === 0" class="s-hint">读取中…</div>
    <div v-for="row in toolPolicyRows" :key="row.id" class="li-row">
      <span><b class="mono">{{ row.name }}</b> <span class="s-muted">{{ row.audience }}</span></span>
      <span class="s-muted">{{ row.summary }}</span>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">🔌 MCP <span class="tag-tip">需重启</span></div>
    <label class="chk"><input type="checkbox" v-model="mcpEnabled" :disabled="!assistantMode" /><span>启用 MCP（仅助手模式）</span></label>
    <div class="s-hint">内置 {{ builtinMcpList.length }} + 自定义 {{ mcpServerList.length }} 个</div>
    <!-- 内置 MCP -->
    <div class="s-subtitle">📦 内置</div>
    <div v-for="(b, i) in builtinMcpList" :key="b.name" class="li-row">
      <span>{{ b.description || b.name }} <code>{{ b.name }}</code></span>
      <span>
        <button class="btn-s" :class="{ 'btn-d': !b.enabled }" @click="toggleBuiltinMcp(i)">{{ b.enabled ? '✅' : '❌' }}</button>
        <button class="btn-s" @click="startEditBuiltin(i)">✏</button>
      </span>
    </div>
    <div v-if="editingBuiltinIdx >= 0" class="edit-box">
      <div class="fld"><span class="fn">{{ builtinMcpList[editingBuiltinIdx]?.name }}</span></div>
      <div class="fld"><label>参数</label><input class="inp" v-model="builtinMcpList[editingBuiltinIdx].args" /></div>
      <div class="fld-col"><label>环境变量</label><textarea class="inp txa mono" v-model="builtinMcpList[editingBuiltinIdx].envStr" rows="2" placeholder="KEY=VALUE"></textarea></div>
      <button class="btn-s btn-d" @click="cancelEditBuiltin()">取消</button>
    </div>
    <!-- 自定义 MCP -->
    <div class="s-subtitle" style="margin-top:6px">🔧 自定义</div>
    <div class="row-gap"><button class="btn-s" @click="importMcpJson()">📥 导入</button><button class="btn-s" @click="exportMcpJson()">📤 导出</button></div>
    <div v-if="mcpServerList.length === 0" class="s-hint">暂无</div>
    <div v-for="(s, i) in mcpServerList" :key="i" class="li-row">
      <span><b>{{ s.name }}</b> [{{ s.transport }}] {{ s.command }}</span>
      <span><button class="btn-s" @click="editMcpServer(i)">✏</button><button class="btn-s btn-d" @click="removeMcpServer(i)">✕</button></span>
    </div>
    <div class="edit-box" style="margin-top:4px">
      <div class="fld"><label>名称</label><input class="inp" v-model="mcpForm.name" style="width:90px" /></div>
      <div class="fld"><label>传输</label><select class="inp" v-model="mcpForm.transport" style="width:70px"><option value="stdio">stdio</option><option value="sse">sse</option></select></div>
      <div class="fld" v-if="mcpForm.transport === 'stdio'"><label>命令</label><input class="inp" v-model="mcpForm.command" style="width:100px" /><label>参数</label><input class="inp" v-model="mcpForm.args" style="width:140px" /></div>
      <div class="fld" v-if="mcpForm.transport === 'sse'"><label>URL</label><input class="inp" v-model="mcpForm.url" style="width:220px" /></div>
      <div class="fld-col"><label>环境变量</label><textarea class="inp txa mono" v-model="mcpForm.envStr" rows="2" placeholder="KEY=VALUE"></textarea></div>
      <div class="row-gap">
        <button class="btn-s" @click="addOrUpdateMcpServer()">{{ editingMcpIdx >= 0 ? '更新' : '添加' }}</button>
        <button v-if="editingMcpIdx >= 0" class="btn-s btn-d" @click="cancelMcpEdit()">取消</button>
        <button class="btn-s" @click="testMcpConnection()">{{ mcpTesting ? '⏳' : '🔌' }} 测试</button>
      </div>
      <div v-if="mcpTestResult" class="s-hint">{{ mcpTestResult }}</div>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">📦 Skill</div>
    <label class="chk"><input type="checkbox" v-model="skillEnabled" /><span>启用 Skill（按声明支持轻量或助手模式）</span></label>
    <div class="s-hint">首回合只列名称、说明和位置；正文由模型按需读取。Skill 不会额外授予工具权限。</div>
    <div class="row-gap" style="margin-top:4px">
      <button class="btn-s" @click="uploadSkillMd()">📤 上传 .md</button>
      <button class="btn-s" @click="loadSkillConfig()">🔄 刷新</button>
    </div>
    <div v-if="skillIndexError" class="s-error">{{ skillIndexError }}</div>
    <div v-else-if="skillList.length === 0" class="s-hint">暂无</div>
    <div v-for="s in skillList" :key="s.id" class="li-row">
      <span><b>{{ s.name }}</b> {{ s.description }}</span>
      <span>
        <button class="btn-s btn-d" @click="removeSkill(s.id)">✕</button>
      </span>
    </div>
  </div>
</div>
</template>
