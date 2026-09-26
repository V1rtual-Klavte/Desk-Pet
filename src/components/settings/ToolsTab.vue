<script setup lang="ts">
import { ref, onMounted } from "vue";
import { toolsConfig, loopConfig, MIN_PARALLEL_TOOLS, MAX_PARALLEL_TOOLS } from "@/services/config";
import { createLogger } from "@/services/logger";
import { errorCode, formatError } from "@/services/error";
// 纯文本工具函数，同步使用；其余 MCP 生命周期 API 仍按需动态 import
import { parseEnvText, formatEnvText } from "@/services/tool/mcp";

const log = createLogger("Settings");

// ── Bash ──
const bashWhitelist = ref(toolsConfig.bashWhitelist.join("\n"));

// ── 工具执行并发 ──
// 共享读上限：范围校验在 SettingsPanel.doSave 里按 parallelToolsError 拒绝越界值，
// 这里只做初值读取与控件提示。
const maxParallelTools = ref(loopConfig.maxParallelTools);

// ── MCP ──
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
/**
 * 逐项开关的显示面：只投影设置页要用的四个字段，不把技能正文带进本窗口的响应式状态。
 * 清单口径是 store 里 Pi 实际收录的技能（含被关闭者），不是 Rust 指纹回执的 count
 * —— 后者是扫描到的候选条目数（含未收录的）。
 */
interface SkillRow {
  /** 开关与删除的坐标（域内相对路径）；Pi 只会从技能目录取文件，null 是防御分支。 */
  relativePath: string | null;
  name: string;
  description: string;
  enabled: boolean;
}
const skillList = ref<SkillRow[]>([]);
/** 索引核对失败的原因：空列表本身区分不出「核对失败」与「真的没有 Skill」 */
const skillIndexError = ref<string>("");
/** 上传/删除/开关的失败原因：一律如实展示，不静默吞掉 */
const skillActionError = ref<string>("");
/** 有写操作在飞：同一时刻只写一个条目，避免连点并发写同一个文件 */
const skillWriting = ref(false);

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
  const { syncSkillCatalog, listSkills, getSkillCatalogError } = await import("@/services/skill");
  await syncSkillCatalog();
  // 核对失败时 store 保留上一份清单、把原因记在 getSkillCatalogError()：
  // 设置页要把「索引不可用」与「真的没有 Skill」分开显示，并说明列表是最近一次成功读取的结果。
  const reason = getSkillCatalogError();
  skillIndexError.value = reason ? `Skill 索引不可用：${reason}（列表为最近一次成功读取的结果）` : "";
  skillList.value = listSkills().map((s) => ({
    relativePath: s.relativePath,
    name: s.name,
    description: s.description,
    enabled: s.enabled,
  }));
}

/** 写操作前置：坐标可用且当前没有别的写入在飞。返回可写坐标，否则就地给出原因并返回 null。 */
function beginSkillWrite(skill: SkillRow): string | null {
  if (!skill.relativePath) {
    skillActionError.value = `${skill.name}：条目在技能目录里没有可用坐标，无法开关或删除`;
    return null;
  }
  if (skillWriting.value) return null;
  skillWriting.value = true;
  skillActionError.value = "";
  return skill.relativePath;
}

/** 逐项开关：写文件后立刻核对清单，本窗口马上看到新状态；主窗口由每回合的指纹核对跟上。 */
async function toggleSkill(skill: SkillRow) {
  const relativePath = beginSkillWrite(skill);
  if (!relativePath) return;
  try {
    const { setSkillEnabled } = await import("@/services/skill");
    if (!(await setSkillEnabled(relativePath, !skill.enabled))) {
      skillActionError.value = `${skill.name} 的开关未写入：SKILL.md 里没有可用的 frontmatter 块`;
      log.warn("Skill 开关未写入:", skill.name);
    }
  } catch (error) {
    skillActionError.value = `${skill.name} 的开关写入失败：${formatError(error)}`;
    log.error("Skill 开关写入失败:", skill.name, formatError(error));
  }
  skillWriting.value = false;
  await loadSkillConfig();
}

async function removeSkill(skill: SkillRow) {
  const relativePath = beginSkillWrite(skill);
  if (!relativePath) return;
  try {
    const { deleteSkill } = await import("@/services/skill");
    await deleteSkill(relativePath);
  } catch (error) {
    // 经根外符号链接可达的条目「列得出、删不掉」：skill_delete 按路径边界拒绝（PATH_ESCAPE）。
    // 这条错误必须让用户看见，否则条目一直列着而用户只看到什么都没发生。
    const reason = formatError(error);
    skillActionError.value = errorCode(error) === "PATH_ESCAPE"
      ? `${skill.name} 删除被拒绝：条目解析后落在技能目录之外（通常是根外符号链接），要删除请直接在磁盘上处理（${reason}）`
      : `${skill.name} 删除失败：${reason}`;
    log.error("Skill 删除失败:", skill.name, reason);
  }
  skillWriting.value = false;
  await loadSkillConfig();
}

async function uploadSkillMd() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file || skillWriting.value) return;
    skillWriting.value = true;
    skillActionError.value = "";
    try {
      const text = await file.text();
      const { upsertSkill } = await import("@/services/skill");
      // upsertSkill 返回 null 就是没收下（校验未过 / 写入后仍未被收录）：不谎报上传成功。
      if (!(await upsertSkill(text))) {
        skillActionError.value = `${file.name} 未被收录：frontmatter 不合要求或没通过校验（原因见日志）`;
      }
    } catch (error) {
      skillActionError.value = `${file.name} 上传失败：${formatError(error)}`;
      log.error("Skill 上传失败:", file.name, formatError(error));
    }
    skillWriting.value = false;
    await loadSkillConfig();
  };
  input.click();
}

// ── 工具策略（只读声明） ──
interface ToolPolicyRow {
  id: string;
  name: string;
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
    // 该实例从不释放，registerDefaultTools 的幂等位保证重复进入本页不重复注册。
    const { registerDefaultTools, listAll } = await import("@/services/tool/registry");
    await registerDefaultTools();
    toolPolicyRows.value = listAll()
      .map(tool => ({
        id: tool.id,
        name: tool.name,
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
  maxParallelTools,
  mcpServerList,
  builtinMcpList,
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
      <span><b class="mono">{{ row.name }}</b></span>
      <span class="s-muted">{{ row.summary }}</span>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">🔌 MCP</div>
    <div class="s-hint">
      按每服务器开关控制，全部关闭即不使用 MCP；启用的服务器在运行开始时借用、结束即释放。
      内置 {{ builtinMcpList.length }} + 自定义 {{ mcpServerList.length }} 个
    </div>
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
    <div class="s-hint">
      技能 {{ skillList.length }} 个（含已关闭；关闭只是停用，删除才会从磁盘移除）。
      开关直接写入该技能 SKILL.md 的 enabled 字段，下一个回合生效，无需重启；关闭的技能既不披露给模型，也不能用 /skill 调用。
      请求里只注入名称、说明和位置，正文由模型按需读取；Skill 不会额外授予工具权限。
    </div>
    <div class="row-gap" style="margin-top:4px">
      <button class="btn-s" @click="uploadSkillMd()">📤 上传 .md</button>
      <button class="btn-s" @click="loadSkillConfig()">🔄 刷新</button>
    </div>
    <div v-if="skillIndexError" class="s-error">{{ skillIndexError }}</div>
    <div v-if="skillActionError" class="s-error">{{ skillActionError }}</div>
    <div v-if="skillList.length === 0" class="s-hint">暂无</div>
    <div v-for="s in skillList" :key="s.relativePath ?? s.name" class="li-row">
      <span><b>{{ s.name }}</b> {{ s.description }}</span>
      <span>
        <button class="btn-s" :disabled="skillWriting" title="点击切换启用状态" @click="toggleSkill(s)">{{ s.enabled ? '✅ 已启用' : '❌ 已关闭' }}</button>
        <button class="btn-s btn-d" :disabled="skillWriting" title="从磁盘删除这个技能" @click="removeSkill(s)">✕</button>
      </span>
    </div>
  </div>
</div>
</template>
