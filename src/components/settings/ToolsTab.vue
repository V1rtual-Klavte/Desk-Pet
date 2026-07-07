<script setup lang="ts">
import { ref, onMounted } from "vue";
import { toolsConfig } from "@/services/config";
import { createLogger } from "@/services/logger";

const log = createLogger("Settings");

// Props: 父组件传入的 assistantMode，用于禁用助手专属功能
const props = defineProps<{ assistantMode: boolean }>();

// ── Bash ──
const bashWhitelist = ref(toolsConfig.bashWhitelist.join("\n"));

// ── 文件 ──
const fileWriteEnabled = ref(toolsConfig.fileWriteEnabled);

// ── MCP ──
const mcpEnabled = ref(toolsConfig.mcpEnabled);
const mcpServerList = ref<
  { name: string; transport: string; command: string; args: string; url: string; enabled: boolean }[]
>([]);
const editingMcpIdx = ref(-1);
const mcpForm = ref({ name: "", transport: "stdio", command: "", args: "", url: "", enabled: true });
const builtinMcpList = ref<
  { name: string; enabled: boolean; args: string; description: string; envStr: string }[]
>([]);
const editingBuiltinIdx = ref(-1);
const mcpTesting = ref(false);
const mcpTestResult = ref("");

// ── Skill ──
const skillEnabled = ref(toolsConfig.skillEnabled);
const skillList = ref<{ id: string; name: string; description: string; keywords: string }[]>([]);

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
    envStr: def.env
      ? Object.entries(def.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
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
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true };
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
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true };
}

async function importMcpJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { importMcpServersFromJson } = await import("@/services/tool/mcp/manager");
    importMcpServersFromJson(text);
    await loadMcpConfig();
  };
  input.click();
}

async function exportMcpJson() {
  const { exportMcpServersToJson } = await import("@/services/tool/mcp/manager");
  const blob = new Blob([exportMcpServersToJson()], { type: "application/json" });
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
  try {
    const { connectMcpServer } = await import("@/services/tool/mcp/manager");
    const r = await connectMcpServer({
      name: s.name.trim(),
      transport: s.transport as "stdio" | "sse",
      command: s.command.trim(),
      args: s.args.trim() ? s.args.trim().split(/\s+/) : [],
      url: s.url.trim() || undefined,
      enabled: s.enabled,
    });
    mcpTestResult.value = r.success
      ? `✅ 连接成功！${r.toolCount} 个工具`
      : `❌ 失败: ${r.error}`;
  } catch (e: any) {
    mcpTestResult.value = `❌ 异常: ${e.message || e}`;
  }
  mcpTesting.value = false;
}

// ── Skill ──
async function loadSkillConfig() {
  const { getLoadedSkills } = await import("@/services/tool/skill/loader");
  skillList.value = getLoadedSkills().map((s) => ({
    id: s.meta.id,
    name: s.meta.name,
    description: s.meta.description,
    keywords: (s.meta.trigger_keywords ?? []).join(", "),
  }));
}

async function removeSkill(skillId: string) {
  const { removeSkill: doRemove } = await import("@/services/tool/skill/loader");
  doRemove(skillId);
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
    const { addSkillFromMarkdown } = await import("@/services/tool/skill/loader");
    addSkillFromMarkdown(text);
    await loadSkillConfig();
  };
  input.click();
}

// ── 生命周期 ──
onMounted(async () => {
  await loadMcpConfig();
  loadBuiltinMcpConfig();
  await loadSkillConfig();
});

defineExpose({
  bashWhitelist,
  fileWriteEnabled,
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
    <div class="s-label">📁 文件</div>
    <label class="chk"><input type="checkbox" v-model="fileWriteEnabled" :disabled="!assistantMode" /><span>允许写文件（仅助手模式）</span></label>
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
      <div class="row-gap">
        <button class="btn-s" @click="addOrUpdateMcpServer()">{{ editingMcpIdx >= 0 ? '更新' : '添加' }}</button>
        <button v-if="editingMcpIdx >= 0" class="btn-s btn-d" @click="cancelMcpEdit()">取消</button>
        <button class="btn-s" @click="testMcpConnection()">{{ mcpTesting ? '⏳' : '🔌' }} 测试</button>
      </div>
      <div v-if="mcpTestResult" class="s-hint">{{ mcpTestResult }}</div>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">📦 Skill <span class="tag-tip">需重启</span></div>
    <label class="chk"><input type="checkbox" v-model="skillEnabled" :disabled="!assistantMode" /><span>启用 Skill（仅助手模式）</span></label>
    <div class="row-gap" style="margin-top:4px">
      <button class="btn-s" @click="uploadSkillMd()">📤 上传 .md</button>
      <button class="btn-s" @click="loadSkillConfig()">🔄 刷新</button>
    </div>
    <div v-if="skillList.length === 0" class="s-hint">暂无</div>
    <div v-for="s in skillList" :key="s.id" class="li-row">
      <span><b>{{ s.name }}</b> {{ s.description }}</span>
      <span><span class="s-hint" style="margin:0 8px">{{ s.keywords }}</span><button class="btn-s btn-d" @click="removeSkill(s.id)">✕</button></span>
    </div>
  </div>
</div>
</template>
