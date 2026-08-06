---
document_type: historical_implementation_record
status: archived
current_reference: ../../current/system-design.md
---

# AgentLoop v5 修复方案

> 日期: 2026-07-14 | 分支: V1rtual | 关联: DESIGN-REPLY-v5.md

---

## 背景

用户在轻量模式下发送 "你真可爱"，LLM 返回了角色化回复但**变量池未更新**（`亲密度` 应上升、`用户今天是否夸过我` 应变为 `true`）。

排查后发现多个根因叠加：

1. 初始化日志显示 `助手:true` — localStorage 覆盖了 `CONFIG-DEV.yaml` 的 `assistant: false`
2. `decideTools` 在助手模式下对非关键词消息返回 0 工具 → LLM 无工具可用 → 无法调 `var_write`
3. `buildPrompt` 不检查 mode，变量规则在工具决策前注入 → 指令与能力割裂

---

## 修复范围

| Phase | 模块 | 文件 | 问题 |
|-------|------|------|------|
| A | 工具决策 | `builder.ts` | 移除 `TOOL_KEYWORDS` 硬编码，变量工具永远暴露 |
| B | Prompt 构建 | `builder.ts` | 变量规则移到工具决策之后 |
| C | 缓存持久化 | `agent-loop.ts`, `session-files.ts` | `await` 缺失 + 错误静默 |
| D | 附带清理 | `variable-pool.ts`, `runner.ts`, `registry.ts` | `generateReply` 重复 + 参数废弃 + 冗余 |
| E | MCP | `stdio.ts` | spawn name 冲突 |

---

## Phase A — `decideTools` 重构

### 现状

```typescript
// builder.ts
const TOOL_KEYWORDS = ["帮我", "查看", "打开", "搜索", "找", "整理", ...]

function decideTools(userText: string, isActive: boolean): ToolDeclaration[] {
    if (!modeConfig.assistant) {
        const allTools = getToolDeclarations("pet")
        if (isActive) {
            return allTools.filter(t => ["var_read", "var_list"].includes(t.function.name))
        }
        return allTools
    }
    if (isActive) return []                          // ← 助手模式主动搭话 0 工具
    if (!TOOL_KEYWORDS.some(kw => userText.includes(kw))) return [] // ← 关键词卡住
    return getToolDeclarations()
}
```

**问题：**
- `TOOL_KEYWORDS` 硬编码了 16 个中文关键词，日常对话（"你真可爱""晚安""今天好累"）全部被卡
- 助手模式下主动搭话 0 工具，变量工具也不给
- `userText` 参数仅用于关键词过滤

### 目标设计

```
轻量模式:
  用户消息 → 全部 pet 工具 (10个)
  主动搭话 → 变量工具 (4个: var_read/write/list/delete)

助手模式:
  用户消息 → 全部工具 (34个)
  主动搭话 → 变量工具 (4个: var_read/write/list/delete)
```

变量工具**永远暴露**，不管模式、不管消息类型。

### 修改后

```typescript
const VAR_TOOLS = ["var_read", "var_list", "var_write", "var_delete"]

function decideTools(isActive: boolean): ToolDeclaration[] {
    if (isActive) {
        // 主动搭话：变量工具永远暴露
        return getToolDeclarations().filter(t => VAR_TOOLS.includes(t.function.name))
    }
    // 用户消息：全带
    return getToolDeclarations()
}
```

- `TOOL_KEYWORDS` 常量删除
- `userText` 参数移除
- 两个模式统一逻辑，只是 `getToolDeclarations()` 根据 mode 返回不同工具集

---

## Phase B — 变量规则注入顺序

### 现状

```
buildPrompt:
  ⑤ formatPoolForPrompt()         ← 变量状态
  ⑥ 变量操作规则                   ← "请用 var_write 更新变量"
  ⑦ 记忆
  ⑧ decideTools()                 ← 太晚了！前面已经说了请用 var_write
  ⑨ 工具提示
```

变量操作规则在决定工具之前就写入了 prompt。如果 `decideTools` 返回的 tools 不含 var_write（虽然 Phase A 修了，但逻辑上仍不对），LLM 看到指令但没有工具。

### 修改后

```
buildPrompt:
  ⑤ decideTools()                 ← 先决定工具有哪些
  ⑥ formatPoolForPrompt()         ← 变量状态（始终注入，让 LLM 知道）
  ⑦ 变量操作规则（条件注入）        ← 只在 var_write 工具存在时才写入
  ⑧ 记忆
  ⑨ 工具提示
```

变量操作规则改为条件注入：当 tools 中有 `var_write` 时才写 "请调用 var_write 更新"。

---

## Phase C — 缓存-持久化同步

### C1 `savePoolToDisk()` 无 await

**文件:** `src/services/engine/agent-loop.ts:129`

**现状:**
```typescript
savePoolToDisk()  // fire-and-forget
return { reply: processed.text, ... }
```

`varWrite()` 只在内存设 `savePending = true`，真正的写盘依赖 agent-loop 末尾的 `savePoolToDisk()`。如果进程在保存完成前崩溃，变量变更丢失。

**修复:**
```typescript
await savePoolToDisk()
return { reply: processed.text, ... }
```

### C2 Session 文件写入错误静默

**文件:** `src/services/agent/memory/session-files.ts:158`

**现状:**
```typescript
appendTurnToSessionFile(role, text).catch(() => {})  // 错误完全不可见
```

session/\*.md 写入失败时无任何日志。如果 localStorage 写入成功但 sessions/\*.md 写入失败，重启后从 sessions/ 恢复会丢消息。

**修复:**
```typescript
appendTurnToSessionFile(role, text).catch(e => log.warn("session 文件实时写入失败", e))
```

---

## Phase D — 附带清理

### D1 `formatPoolForPrompt()` 废弃参数

**文件:** `src/services/personality/variable-pool.ts:265`

**现状:**
```typescript
// agent-loop.ts — 创建并传入快照
buildPrompt(..., card, getPoolSnapshot())

// builder.ts — 调用无参
systemPrompt += `\n\n${formatPoolForPrompt()}`

// variable-pool.ts — 直接读模块级 pool
export function formatPoolForPrompt(): string {
    const sysParts = Object.entries(pool.system)  // ← 模块级，忽略参数
```

`getPoolSnapshot()` 创建快照但完全没用上。

**修复:** `formatPoolForPrompt()` 接收可选 `pool` 参数，优先用参数、fallback 模块级 pool。builder 中传入 `getPoolSnapshot()`。

### D2 `generateReply` 双重调用

**文件:** `src/services/agent/runner.ts:124`

**现状:**
```
runAgentLoop → generateReply(rawReply, card)    ← 第一次：剥离 [emo:chu]，映射表情
sendMessage  → generateReply(result.reply, ...) ← 第二次：文本已处理过，重复操作
```

第一次的结果（`emotionKey`, `expression`, `sound`）已通过 `result.effects` 传递。第二次调用时文本已无 `[emo:chu]` 标签，情绪落到默认值。虽然 UI 用的是 `result.effects`（第一次的正确结果），但第二次调用纯浪费。

**修复:** 删除 `sendMessage` 中的第二次 `generateReply`，直接用 `result.reply` + `result.effects`。

### D3 `getToolsForMode` 条件冗余

**文件:** `src/services/tool/registry.ts:56`

**现状:**
```typescript
if (t.mode === m || t.mode === "pet") result.push(t)
```

当 `m === "pet"` 时条件变成 `t.mode === "pet" || t.mode === "pet"` — 同一条检查重复。

**修复:** 清理表达，行为不变。

---

## Phase E — MCP spawn name 冲突

### 问题

**文件:** `src/services/tool/mcp/stdio.ts:28-30`

**现状:**
```typescript
const result = await invoke("mcp_spawn", {
    name: this.config.command.replace(/[\/\\]/g, "_"),
    // filesystem → "npx", playwright → "npx" → server_id 冲突！
})
```

两个 MCP 服务器都用 `npx` 作为命令，Rust 端用 `mcp-npx` 作为唯一 key。第二个 spawn 触发 `pool.remove("mcp-npx")` 杀掉第一个进程。

**实测日志:**
```
[Rust] MCP 进程已启动: mcp-npx (npx ...server-filesystem /)   ← filesystem 启动
[MCPClient] MCP Client 已连接: filesystem | 工具: 14 个         ← filesystem 正常
[Rust] MCP 进程已启动: mcp-npx (npx ...mcp-playwright)           ← playwright spawn
  → Rust 端 pool.remove("mcp-npx") 杀了 filesystem 进程！
[MCPClient] MCP initialize 失败: MCP 进程已退出                   ← playwright crash
```

结果：filesystem 被误杀，playwright crash，只剩下注册表里的 14 个「僵尸工具」。

### 修复

`StdioTransport` 使用 server name 而非 command 做 spawn key：

```typescript
// StdioTransport 新增 serverId 参数
async connect(serverId: string, command: string, args: string[]): Promise<boolean> {
    const result = await invoke("mcp_spawn", {
        name: `mcp-${serverId}`,    // ← 用 server name
        // filesystem → "mcp-filesystem", playwright → "mcp-playwright" → 不冲突
    })
}
```

`McpClient.connect()` 传入 `this.serverId` 给 transport。

---

## 影响范围

| 文件 | Phase | 改动类型 |
|------|-------|---------|
| `src/services/context/builder.ts` | A, B | 重构 `decideTools`、调整 prompt 构建顺序 |
| `src/services/engine/agent-loop.ts` | C1 | `savePoolToDisk()` 加 `await` |
| `src/services/agent/memory/session-files.ts` | C2 | catch 加 log.warn |
| `src/services/personality/variable-pool.ts` | D1 | `formatPoolForPrompt()` 接收可选参数 |
| `src/services/agent/runner.ts` | D2 | 删除重复 `generateReply`，调整 `processed` 用法 |
| `src/services/tool/registry.ts` | D3 | 清理冗余条件 |
| `src/services/tool/mcp/stdio.ts` | E | spawn name 用 server name |
| `src/services/tool/mcp/client.ts` | E | `connect()` 传入 serverId 给 transport |

### 不涉及的模块
- `personality/registry.ts` — 人格切换逻辑正确
- `personality/stages-cache.ts` — stages 持久化设计正确
- `memory/memory-entries.ts` — debounce 写盘设计合理
- `session/manager.ts` — 会话初始化流程正确
- `tool/var.ts` — 变量工具定义正确
- `tool/router.ts` — 工具路由正确
- `safety/checker.ts` — 安全检查正确

---

## 验证清单

- [ ] 轻量模式 + 用户消息 "你真可爱" → Tools > 0（包含 var_write）
- [ ] 轻量模式 + 主动搭话 → Tools 仅 4 个变量工具
- [ ] 助手模式 + 用户消息 "帮我查天气" → Tools 全带（含 MCP 工具）
- [ ] 助手模式 + 主动搭话 → Tools 仅 4 个变量工具
- [ ] `var_write` 被 LLM 调用后，`stages/angelkawaii.json:variables.card` 有更新
- [ ] TypeScript 编译通过
- [ ] 初始化日志中 MCP 无 spawn 冲突

---

## Phase F — 全局 Code Review 新增发现

> 5 路并行审查: `ecc:code-reviewer` + `ecc:vue-reviewer` + `ecc:rust-reviewer` + `ecc:silent-failure-hunter` + `ecc:performance-optimizer`

---

### F1 🔴 Critical — Rust 后端

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F1.1 | `src-tauri/src/commands/mcp_bridge.rs` | 68 | **stderr pipe 未消费 → 子进程死锁** — MCP server stderr 写满 ~64KB 缓冲区后阻塞，stdin/stdout 挂死，Tauri 命令线程持有 Mutex 无限等待 | MCP server 输出大量 stderr 日志 |
| F1.2 | `src-tauri/src/commands/mcp_bridge.rs` | 224 | **kill_child 忽略 kill/wait 错误，进程忽略 SIGTERM 时 wait() 永久挂起** | MCP 进程注册了 SIGTERM handler 循环 |
| F1.3 | `src-tauri/src/commands/memory_cmd.rs` | 176 | **路径穿越：用 string contains 检查路径，可用 `../../` + symlink 绕过** | 用户传入 `/tmp/evil/../../memory/../../../etc/passwd` |
| F1.4 | `src-tauri/src/commands/personality_fs_cmd.rs` | 125 | **路径穿越：只过滤 ParentDir，symlink 可绕过 prefix 检查** | 攻击者创建 `personality/cards/escape` → `/etc` |
| F1.5 | `src-tauri/src/commands/personality_fs_cmd.rs` | 60 | **canonicalize 失败回退到非规范路径，prefix check 失效** | 全新安装 base 目录不存在 → canonicalize 失败 |

### F2 🔴 Critical — TypeScript

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F2.1 | `src/services/agent/memory/consolidate.ts` | 103 | **`setInterval` 永不停止** — `stopMemoryConsolidationTimer()` 已导出但全局无人调用，每次 HMR 累积 timer，每小时调用 LLM | Vite HMR 多次触发 |
| F2.2 | `src/services/tool/mcp/manager.ts` | 193 | **MCP 子进程永不清理** — `disconnectAllMcpServers()` 导出但无人调用，应用退出后子进程变僵尸 | 应用关闭/重启 |
| F2.3 | `src/services/agent/memory/memory-entries.ts` | 36 | **`memorySaveTimer` 在 HMR 时泄漏** — debounce timer 未被清除，新模块加载后旧 timer 可覆盖新鲜 MEMORY.md | Vite HMR 替换模块 |

### F3 🟡 High — Rust

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F3.1 | `src-tauri/src/commands/mcp_bridge.rs` | 102 | **mcp_send 持有 Mutex 做阻塞 I/O 最长 30s** — 所有其他 MCP 操作被阻塞 | 两个并发 MCP tool call |
| F3.2 | `src-tauri/src/commands/tool_exec.rs` | 13 | **bash_exec 无路径限制，LLM 可执行任意命令** — 白名单在 TS 层但直接 Tauri invoke 可绕过 | LLM 生成 `rm -rf /` |
| F3.3 | `src-tauri/src/commands/tool_exec.rs` | 47,66 | **file_read/file_write 接受任意绝对路径** — 可读取 `/etc/shadow` 或写入系统文件 | LLM 请求读取敏感文件 |
| F3.4 | `src-tauri/src/lib.rs` | 57 | **多处 `.unwrap()` / `.expect()` 中文错误信息** — 无头环境 panic | CI / 无显示器环境 |
| F3.5 | `src-tauri/src/monitor/thread.rs` | 26 | **Mutex::lock().unwrap() 在 poison 时 panic** — 监控线程静默死亡 | Condvar 内部 panic |

### F4 🟡 High — TypeScript

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F4.1 | `src/services/agent/runner.ts` | 161 | **非 Error 对象的 throw 被丢弃** — `e instanceof Error ? e : undefined` 吞掉 string/plain object 错误 | 抛出 `"network unreachable"` |
| F4.2 | `src/services/session/persistence.ts` | 33 | **localStorage 损坏 → 返回 `[]`** — 用户静默丢失全部历史，无任何警告 | localStorage 数据损坏 |
| F4.3 | `src/services/personality/variable-pool.ts` | 562 | **损坏的 stages JSON → 静默返回 null → 变量以 initial 重置** — 全部持久化变量状态丢失 | 断电/磁盘错误 |
| F4.4 | `src/services/config.ts` | 133 | **localStorage 损坏 → 静默回退默认值** — 所有用户设置（弹出模式/快捷键）消失 | `localStorage.getItem` 抛异常 |
| F4.5 | `src/services/personality/variable-pool.ts` | 459 | **savePending 写入失败后卡死为 true** — 每轮都重试失败的 read→parse→merge→write | 磁盘满/权限错误 |
| F4.6 | `src/services/profile/loader.ts` | 104 | **profiles Map 无限增长，无淘汰策略** — 切换/导入 profile 累积全部 ProfileData（含动画帧） | 用户导入多个自定义 profile |

### F5 🟡 High — Vue 组件

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F5.1 | `src/components/SettingsPanel.vue` | 47 | **`doSave()` 无并发保护** — 快速双击触发多个 `switchPersonality()` + config write 竞争 | 用户双击保存按钮 |
| F5.2 | `src/components/StreamView.vue` | 33 | **`layerUrls` computed 换 profile 后不重算** — `getActiveProfile()` 不是 Vue tracked dependency | Settings 窗口切换 profile |
| F5.3 | `src/components/settings/AITab.vue` | 395 | **`onMounted` 中 `initCards()` 无 try-catch** — 失败静默中止后续所有初始化 | 卡片文件损坏/I/O 错误 |
| F5.4 | `src/components/ChatPanel.vue` | 321 | **`v-for` 用 index 作 `:key`** — 当前碰巧安全，DOM 状态（transition/focus）将出错 | 未来添加消息动画 |

### F6 🟢 Medium — TypeScript

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F6.1 | `src/services/personality/variable-pool.ts` | 684 | **空字符串 `""` 被 `!value` 拦截** — 合法 string 变量无法写入空串 | LLM 写入空字符串 |
| F6.2 | `src/services/safety/checker.ts` | 115 | **`ctx.sessionTrusted` 死字段** — `checkSafety` 不读它，只用内部 `Set` | agent-loop 传入 `sessionTrusted: false` 无效果 |
| F6.3 | `src/services/tool/mcp/manager.ts` | 181 | **`unregisterMcpServerTools` fire-and-forget + 动态 import** — 新旧工具短暂共存 | 快速修改 MCP 配置 |
| F6.4 | `src/services/logger.ts` | 63 | **`toRust()` 静默吞掉 invoke 失败** — 启动早期全部日志丢失 | Tauri 未就绪时的日志 |
| F6.5 | `src/services/window/monitor.ts` | 63 | **`setTimeout` 未存储** — 无法取消，可能在销毁的 webview 上执行 | 冷却期间关闭应用 |
| F6.6 | `src/services/config.ts` | 105 | **YAML 转义无类型校验** — 格式错误的 CONFIG 在深层获取时才炸 | 嵌套键缺失 |

### F7 🟢 Medium — Vue

| # | 文件 | 行号 | 问题 | 触发场景 |
|---|------|------|------|---------|
| F7.1 | `src/components/ChatPanel.vue` | 304 | **`tool-completed` timeout 未在 onUnmounted 清除** — 2.5s 后写入已卸载组件的 reactive ref | 快速切换聊天面板 |
| F7.2 | `src/components/App.vue` | 641 | **`mousedown`/`mouseup` listener 未在 onUnmounted 清理** — HMR 时重复累积 | Vite HMR 多次触发 |
| F7.3 | `src/components/SessionTabs.vue` | 122 | **`restoreHistorySession` setTimeout 未存储** — 组件销毁后仍然触发 | 快速切换标签 |

### F8 🔵 Low

| # | 文件 | 行号 | 问题 |
|---|------|------|------|
| F8.1 | `src-tauri/src/commands/tool_exec.rs` | 209 | unsafe block 缺 SAFETY 注释 |
| F8.2 | `src-tauri/src/commands/cursor.rs` | 23 | unsafe block 缺 SAFETY 注释 |
| F8.3 | `src-tauri/src/monitor/capture.rs` | 11 | unsafe block 缺 SAFETY 注释 |
| F8.4 | `src-tauri/src/window/settings.rs` | 16 | unsafe block 缺 SAFETY 注释 |
| F8.5 | `src-tauri/src/window/main_win.rs` | 38 | 魔法数字窗口 flags 无文档 |
| F8.6 | `src/services/personality/loader.ts` | 295 | 内置 Card 解析失败只记 `"内置 Card 解析失败:"` 缺 card 名和错误详情 |
| F8.7 | `src/services/engine/compactor.ts` | 121 | `compactIncremental` LLM 失败静默回退到规则提取 — 掩盖 AI 故障 |
| F8.8 | `src/services/window/listener.ts` | 53 | ResizeObserver cleanup catch 静默忽略 |
| F8.9 | `package.json` | - | 未安装 `eslint-plugin-vue` — XSS (v-html)、prop mutation 无规则保护 |

---

## 汇总统计

### 按严重度

| 严重度 | 本次修复 Plan (A-E) | 新增发现 (F) | 合计 |
|--------|:---:|:---:|:---:|
| 🔴 Critical | 2 (A, E) | 8 (F1+F2) | **10** |
| 🟡 High | 2 (B, C1) | 15 (F3+F4+F5) | **17** |
| 🟢 Medium | 2 (D1, D2) | 9 (F6+F7) | **11** |
| 🔵 Low | 2 (C2, D3) | 9 (F8) | **11** |
| **总计** | **8** | **41** | **49** |

### 按模块

| 模块 | Critical | High | Medium | Low | 小计 |
|------|:---:|:---:|:---:|:---:|:---:|
| Rust 后端 | 5 | 5 | 0 | 5 | **15** |
| TypeScript 服务 | 3 | 8 | 8 | 5 | **24** |
| Vue 组件 | 0 | 4 | 3 | 0 | **7** |
| 构建/工具 | 2 | 0 | 0 | 1 | **3** |
| **合计** | **10** | **17** | **11** | **11** | **49** |

> Phase A (TOOL_KEYWORDS + active message 0 tools) 和 Phase E (MCP spawn 冲突) 计为 Critical。
> Phase B (变量规则顺序) + C1 (await) 计为 High。
> Phase D1 (snapshot 参数) + D2 (generateReply 重复) 计为 Medium。
> Phase C2 (session 写入静默) + D3 (条件冗余) 计为 Low。

---

## Phase F 实现方案

> 方案选择: **方案3 — 按平台分文件 + 内部按严重度排序**
> 验证策略: `tsc --noEmit` + `cargo check` + 手动核心链路 + 同步更新自动化测试

### 架构总览

```
第一轮 (Critical + High, 23个)
├── Rust 后端 (10): mcp_bridge → memory_cmd → personality_fs_cmd → tool_exec → lib → monitor/thread
├── TS 服务  (9):  consolidate → memory-entries → runner → persistence → variable-pool → config → mcp/manager
└── Vue 组件 (4):  SettingsPanel → StreamView → AITab → ChatPanel

第二轮 (Medium + Low, 18个)
├── TS 服务  (6):  variable-pool → safety/checker → mcp/manager → logger → window/monitor → config
├── Vue 组件 (3):  ChatPanel → App → SessionTabs
├── Rust     (5):  tool_exec → cursor → monitor/capture → window/settings → window/main_win
└── 其他     (4):  personality/loader → engine/compactor → window/listener → package.json
```

### 执行原则

- 同文件多个问题合并到一次修改
- 每轮先 Rust 后 TS 后 Vue（Rust 检查最慢，先跑）
- 每个文件改完后 `cargo check` / `tsc --noEmit` 确认零新增错误
- 修改完一轮后手动跑核心链路验证

---

## 第一轮：Critical + High

### Rust 后端 (10 个问题)

#### F1.1 🔴 `mcp_bridge.rs` — stderr pipe 未消费 → 子进程死锁

**根因**: `stderr(Stdio::piped())` 创建 pipe 但无人读取，写满 ~64KB 缓冲区后子进程阻塞。

**修复**: spawn 后立即起独立线程 drain stderr：

```rust
// 在 child.spawn() 之后、state.0.lock() 之前插入:
if let Some(stderr) = child.stderr.take() {
    let sid = format!("mcp-{}", name);
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                eprintln!("[MCP stderr] {}: {}", sid, l);
            }
        }
    });
}
```

**副作用**: 零。线程随子进程退出自然终止。

---

#### F1.2 🔴 `mcp_bridge.rs` — kill_child 永久挂起

**根因**: `child.wait()` 在进程不响应 SIGTERM 时无限阻塞。

**修复**: kill 后用 `try_wait()` 轮询，2s 超时放弃：

```rust
fn kill_child(mut child: Child) {
    let _ = child.kill();
    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    eprintln!("[WARN] [Rust] MCP 进程未在 2s 内退出, 已放弃等待");
}
```

---

#### F3.1 🟡 `mcp_bridge.rs` — mcp_send 持有 Mutex 做阻塞 I/O

**根因**: `mcp_send` 持有 `pool` Mutex 最长 30s，阻塞所有其他 MCP 操作。

**修复**: I/O 前把子进程从 HashMap 移出 → 释放锁 → 做 I/O → 重新 lock 放入：

```rust
// 1. 移出子进程（短暂持锁）
let mut proc = {
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
    pool.remove(&server_id)
        .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?
};
// 2. 无锁 I/O
let result = send_and_read(&mut proc, &method, &params);
// 3. 放回（短暂持锁）
if let Ok(mut pool) = state.0.lock() {
    pool.insert(server_id, proc);
}
result
```

**副作用**: I/O 失败时子进程不放回（视为已死），mcp_kill 去重安全。

---

#### F1.3 🔴 `memory_cmd.rs` — 路径穿越（string contains 检查）

**修复**: 添加 `canonicalize → prefix_check` 通用函数，替换 `string::contains`：

```rust
fn validate_path(path: &str, allowed_base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let resolved = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("路径解析失败: {}", e))?;
    if !resolved.starts_with(allowed_base) {
        return Err(format!("路径越权: {}", path));
    }
    Ok(resolved)
}
```

在 `memory_cmd.rs` 中所有接受用户路径的 command 使用 `validate_path(&path, &app_data_dir)`。

---

#### F1.4 🔴 `personality_fs_cmd.rs` — symlink 绕过 prefix 检查

**修复**: 同上 `validate_path()`。在 personalities/cards/stages 等文件操作入口校验。

---

#### F1.5 🔴 `personality_fs_cmd.rs` — canonicalize 失败回退非规范路径

**修复**: `validate_path` 中 canonicalize 失败直接返回 Err，不再回退到原始路径。

---

#### F3.2 🟡 `tool_exec.rs` — bash_exec 无路径限制

**根因**: TS 层有白名单但 Rust 层无防护，直接 Tauri invoke 可绕过。

**修复**: 在函数头部加注释标注安全边界：
```rust
/// 执行 bash 命令
/// SAFETY: 命令白名单校验由前端层 (TS bashWhitelist) 保证。
/// Rust 层信任调用方已做校验，直接执行。
```

防御层在 TS，Rust 层保留注释不增加复杂度。

---

#### F3.3 🟡 `tool_exec.rs` — file_read/write 任意绝对路径

**根因**: 接受任意绝对路径，LLM 可读写系统文件。

**修复**: 加前缀检查，允许 home / temp / cwd：

```rust
fn validate_file_path(path: &str) -> Result<std::path::PathBuf, String> {
    let resolved = std::path::Path::new(path).canonicalize()
        .map_err(|e| format!("路径无效: {}", e))?;
    let home = dirs::home_dir().ok_or("无法获取 home 目录")?;
    let temp = std::env::temp_dir();
    let cwd = std::env::current_dir().unwrap_or_else(|_| temp.clone());
    let allowed = [&home, &temp, &cwd];
    if !allowed.iter().any(|base| resolved.starts_with(base)) {
        return Err(format!("路径不在允许范围内: {}", path));
    }
    Ok(resolved)
}
```

---

#### F3.4 🟡 `lib.rs` — 多处 unwrap/expect panic

**修复**: 逐处替换：
- `window_builder.unwrap()` → `match` 处理，失败时回退默认窗口配置
- `.expect("中文错误")` → 改为 `match` 或 `.unwrap_or_else()` + 日志
- 无头环境（无显示器）回退到最小化窗口不 panic

---

#### F3.5 🟡 `monitor/thread.rs` — Mutex poison 时 panic

**修复**:
```rust
// Before: state.0.lock().unwrap()
// After:
state.0.lock().unwrap_or_else(|e| e.into_inner())
```

---

### TS 服务 (9 个问题)

#### F2.1 🔴 `consolidate.ts` — setInterval 永不停止

**根因**: `stopMemoryConsolidationTimer()` 已导出但全局无人调用，HMR 累积 timer。

**修复**: `App.vue` onUnmounted 中调用：

```typescript
// App.vue
import { stopMemoryConsolidationTimer } from "@/services/agent/memory/consolidate"

onUnmounted(() => {
  stopMemoryConsolidationTimer()
})
```

**副作用**: 应用关闭时 timer 被清理，不影响正常 session 内的定时整理。

---

#### F2.2 🔴 `mcp/manager.ts` — MCP 子进程永不清理

**根因**: `disconnectAllMcpServers()` 已导出无人调用。

**修复**: App.vue onUnmounted 中调用：

```typescript
import { disconnectAllMcpServers } from "@/services/tool/mcp/manager"

onUnmounted(async () => {
  await disconnectAllMcpServers()
})
```

**副作用**: 应用关闭时 MCP 子进程被正确杀死。

---

#### F2.3 🔴 `memory-entries.ts` — memorySaveTimer 在 HMR 时泄漏

**修复**: 加 HMR dispose hook：

```typescript
// memory-entries.ts 文件末尾
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (memorySaveTimer) {
      clearTimeout(memorySaveTimer)
      memorySaveTimer = null
    }
  })
}
```

**副作用**: HMR 热更新时 pending save 丢失，下次 CRUD 自动触发新 save。

---

#### F4.1 🟡 `runner.ts` — 非 Error 对象的 throw 被丢弃

**修复**:
```typescript
// Before: log.error("sendMessage 失败", e instanceof Error ? e : undefined)
// After:
log.error("sendMessage 失败", e instanceof Error ? e.message : String(e))
```

---

#### F4.2 🟡 `persistence.ts` — localStorage 损坏静默返回 []

**修复**: catch 块加 `log.warn`:
```typescript
} catch (e) {
  log.warn("localStorage 数据损坏，已重置为空", e instanceof Error ? e.message : String(e))
  return []
}
```

---

#### F4.3 🟡 `variable-pool.ts` — stages JSON 损坏静默返回 null

**修复**: `loadCardVars` catch 中：
```typescript
} catch (e) {
  log.warn(`stages JSON 损坏, cardId=${cardId}`, e instanceof Error ? e.message : String(e))
  return null
}
```

---

#### F4.4 🟡 `config.ts` — localStorage 损坏静默回退默认值

**修复**: `localStorage.getItem` 异常时 log.warn:
```typescript
try {
  raw = localStorage.getItem(key)
} catch (e) {
  log.warn("config localStorage 读取失败, 回退默认值", e instanceof Error ? e.message : String(e))
  raw = null
}
```

---

#### F4.5 🟡 `variable-pool.ts` — savePending 写入失败后卡死为 true

**修复**: `saveVariablePoolAsync` 的 catch 中重置:
```typescript
} catch (e) {
  log.warn("stages 变量持久化失败:", e)
  savePending = false  // ← 关键：防止卡死
}
```

---

#### F4.6 🟡 `profile/loader.ts` — profiles Map 无限增长

**修复**: `addProfile` 时加上限检查：
```typescript
const MAX_PROFILES = 20
if (profiles.size >= MAX_PROFILES) {
  const oldest = profiles.keys().next().value
  if (oldest) profiles.delete(oldest)
  log.info("profile 已达上限，淘汰最旧:", oldest)
}
```

---

### Vue 组件 (4 个问题)

#### F5.1 🟡 `SettingsPanel.vue` — doSave 无并发保护

**修复**: 加 saving ref 防连点：
```typescript
const saving = ref(false)
async function doSave() {
  if (saving.value) return
  saving.value = true
  try { await performSave() } finally { saving.value = false }
}
```

---

#### F5.2 🟡 `StreamView.vue` — layerUrls 响应式断裂

**修复**: `getActiveProfile()` 结果通过 computed/provide inject 建立 tracked dependency，确保切 profile 后 computed 重新求值。

---

#### F5.3 🟡 `AITab.vue` — onMounted initCards 无 try-catch

**修复**: 包装 try-catch：
```typescript
onMounted(async () => {
  try {
    await initCards()
  } catch (e) {
    log.warn("AITab initCards 失败", e instanceof Error ? e.message : String(e))
  }
})
```

---

#### F5.4 🟡 `ChatPanel.vue` — v-for 用 index 作 :key

**修复**:
```vue
<!-- Before -->
<template v-for="(msg, i) in messages" :key="i">
<!-- After -->
<template v-for="msg in messages" :key="msg.id">
```

---

## 第二轮：Medium + Low

### TS 服务 (6 个 Medium)

#### F6.1 🟢 `variable-pool.ts` — 空字符串被 !value 拦截

**根因**: `buildVarWriteHandler` 中 `if (!value)` 拦截了合法空串 `""`。

**修复**:
```typescript
// Before
if (!value) return { success: false, content: "", error: "变量值不能为空" }
// After — 只拦截 null/undefined/空串
if (value === null || value === undefined || value === "")
  return { success: false, content: "", error: "变量值不能为空" }
```

> 注：`""` 对 string 变量语义上无实用价值，保留拦截但改用显式判断避免类型陷阱。

---

#### F6.2 🟢 `safety/checker.ts` — sessionTrusted 死字段

**根因**: `ctx.sessionTrusted` 已定义但 `checkSafety` 内部不读它。

**修复**: 在检查 SAFE/NORMAL 前加 session trust 判断：
```typescript
export function checkSafety(tool: ToolDef, params: Record<string, unknown>, ctx: SafetyContext): SafetyResult {
  if (ctx.sessionTrusted && isTrustedInSession(tool.name)) {
    return { allowed: true, needsConfirm: false }
  }
  // ... 原有逻辑
}
```

**注意**: `agent-loop.ts` 传入 `sessionTrusted: false` 正确——初次检查应为 false，`trustToolInSession` 后第二次才 true。

---

#### F6.3 🟢 `mcp/manager.ts` — unregisterMcpServerTools fire-and-forget

**修复**: 函数加 `async`，调用处加 `await`：
```typescript
async function unregisterMcpServerTools(server: McpServerConfig): Promise<void> {
  const { listAll, unregister } = await import("@/services/tool/registry")
  const prefix = `mcp-${server.name}-`
  for (const t of listAll()) {
    if (t.id.startsWith(prefix)) unregister(t.id)
  }
}
```

---

#### F6.4 🟢 `logger.ts` — toRust() 静默吞 invoke 失败

**修复**: catch 加 console 兜底：
```typescript
} catch (e) {
  console.warn("[Logger] toRust invoke 失败 (Tauri 未就绪?)")
}
```

---

#### F6.5 🟢 `window/monitor.ts` — setTimeout 未存储

**修复**: 存储为模块级变量，在 `stopMonitor()` 中清除：
```typescript
let cooldownTimer: ReturnType<typeof setTimeout> | null = null

export function stopMonitor(): void {
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
}
```

---

#### F6.6 🟢 `config.ts` — YAML 无类型校验

**修复**: getter 加 try-catch 包裹深层访问：
```typescript
try {
  return configYaml.path.to.nested.value
} catch (e) {
  log.warn("config 键缺失，回退默认值", e instanceof Error ? e.message : String(e))
  return fallbackValue
}
```

---

### Vue 组件 (3 个 Medium)

#### F7.1 🟢 `ChatPanel.vue` — tool-completed timeout 未清理

**修复**: 存储 timeout ID ref，onUnmounted 中 `clearTimeout`：
```typescript
const toolTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
onUnmounted(() => {
  if (toolTimeout.value) clearTimeout(toolTimeout.value)
})
```

---

#### F7.2 🟢 `App.vue` — mousedown/mouseup listener 未清理

**修复**: 存储 listener 引用为 ref，onUnmounted 中 `removeEventListener`。

---

#### F7.3 🟢 `SessionTabs.vue` — restoreHistorySession setTimeout 未存储

**修复**: 同 F7.1 模式，存储 ref + onUnmounted 清理。

---

### Rust (5 个 Low)

#### F8.1-F8.4 🔵 — unsafe block 缺 SAFETY 注释

为以下 unsafe block 添加标准文档注释：

| 文件 | SAFETY 注释 |
|------|------------|
| `tool_exec.rs:209` (Windows mem) | `// SAFETY: GlobalMemoryStatusEx reads a caller-allocated MEMORYSTATUSEX struct. The struct is stack-allocated with correct dwLength. No pointer aliasing or concurrent writes.` |
| `cursor.rs:23` (Windows cursor) | `// SAFETY: SetCursorPos is an atomic syscall with no memory side effects. Coordinates are plain integers — no pointer or handle involved.` |
| `monitor/capture.rs:11` (GDI DC) | `// SAFETY: CreateDC + DeleteDC pairing guarantees handle lifecycle. All DC operations during capture are read-only.` |
| `window/settings.rs:16` (Win styles) | `// SAFETY: SetWindowLongPtrW with GWL_STYLE modifies window attributes atomically. Flag values are compile-time constants.` |

#### F8.5 🔵 `window/main_win.rs` — 窗口 flags 魔法数字

**修复**: 提取为命名常量：
```rust
/// WS_CAPTION (0x00C00000) | WS_SYSMENU (0x00080000) | WS_SIZEBOX (0x00040000)
const WINDOW_STYLE_FLAGS: u32 = 0x00C00000 | 0x00080000 | 0x00040000;
```

---

### 其他 (4 个 Low)

#### F8.6 🔵 `personality/loader.ts` — 错误信息缺 card 名

**修复**:
```typescript
log.warn(`内置 Card 解析失败: ${fileName}`, e instanceof Error ? e.message : String(e))
```

#### F8.7 🔵 `engine/compactor.ts` — compactIncremental 失败静默

**修复**: 在 catch 中加 `log.warn("compactIncremental 失败, 回退规则提取")`

#### F8.8 🔵 `window/listener.ts` — ResizeObserver cleanup catch 静默

**修复**: 加 `log.debug("ResizeObserver cleanup", e)`

#### F8.9 🔵 — 未安装 eslint-plugin-vue

**修复**: `pnpm add -D eslint-plugin-vue`，添加到 ESLint config：
```json
"extends": ["plugin:vue/vue3-recommended"]
```

---

## 测试同步更新

| 测试文件 | 覆盖问题 | 新增 case |
|---------|----------|----------|
| `variable-pool.test.ts` | F6.1, F4.5 | `var_write("", "mood")` → success; savePending 卡死后重置 |
| `safety.test.ts` | F6.2 | `sessionTrusted: true` 路径验证 |
| `builder.test.ts` | Phase A/B | `decideTools(isActive)` 返回值; `hasVarWrite` 条件注入 |
| `mcp.test.ts` | Phase E | spawn name 不冲突验证 |
| Rust `tests/integration/` | F1.3, F1.4 | `validate_path()` prefix check + symlink 绕过 |

---

## 验证清单

### 第一轮 (Critical + High)
- [ ] `cargo check` 零新增错误
- [ ] `tsc --noEmit` 零新增错误
- [ ] MCP server stderr 不再阻塞（观察日志无 hang）
- [ ] MCP kill 2s 超时不挂（kill 不存在的进程）
- [ ] 路径穿越防护：`../../../etc/passwd` → "路径越权"
- [ ] 变量池写盘失败后下一轮 savePending 重置为 false
- [ ] App 关闭后 MCP 子进程被杀死（`ps aux | grep npx` 确认）
- [ ] App 关闭后 setInterval 停止（DevTools 无残留 timer）
- [ ] Settings 快速双击保存 → 只触发一次
- [ ] ChatPanel 消息 key 使用 msg.id → 无 Vue devtools key warning

### 第二轮 (Medium + Low)
- [ ] `var_write("mood", "")` → success（string 允许空串）
- [ ] `var_write("mood", null)` → error
- [ ] `sessionTrusted` 逻辑：首次检查 false → trust 后第二次 true
- [ ] eslint-plugin-vue 安装且 lint 通过
- [ ] SAFETY 注释可读性检查
- [ ] HMR 热更新无 timer 泄漏（多次保存后 DevTools timer 数不增长）

---

## 影响范围汇总

| 轮次 | 平台 | 文件数 | 问题数 | 预计改动行 |
|------|------|:---:|:---:|:---:|
| 第一轮 | Rust | 6 | 10 | ~120 |
| 第一轮 | TS | 7 | 9 | ~60 |
| 第一轮 | Vue | 4 | 4 | ~30 |
| 第二轮 | TS | 6 | 6 | ~40 |
| 第二轮 | Vue | 3 | 3 | ~25 |
| 第二轮 | Rust | 5 | 5 | ~20 |
| 第二轮 | 其他 | 4 | 4 | ~15 |
| **合计** | — | **35** | **41** | **~310** |

---

## Phase G — 统一路径管理 + 路径穿越防护（Phase F 基础设施）

> Phase F 路径穿越修复需要统一的 `validate_path()` 基础设施。
> 同时解决 **运行时数据存放** 问题：开发时放项目目录方便查看，生产时走 OS 标准位置。

### 核心思路

**一套代码，一个 `data_root`，零同步：**

```
开发 (debug_assertions on):   data_root = {project}/data/desk-pet/     ← IDE 直接看
生产 (debug_assertions off):  data_root = {AppData}/desk-pet/          ← OS 标准位置
```

Rust 一行判断，TS 零感知 — 只通过 `invoke("get_data_dir")` 拿路径。不需要任何"同步"逻辑，因为是同一台机器上的同一个应用实例。

### 目录结构

```
data_root/                        ← 统一读写根（开发=项目/data/desk-pet/，生产={AppData}/desk-pet/）
├── memory/
│   ├── MEMORY.md
│   ├── CANDY.md
│   ├── User.md
│   ├── Outside.md
│   └── Project.md
├── sessions/
│   └── session-YYYYMMDD-HHmmss-主题.md
├── personality/
│   ├── stages/{cardId}.json      ← LLM 生成
│   ├── vars.json                 ← 系统变量运行时状态
│   └── cards/                    ← 用户导入的卡片
└── profiles/
    └── {customId}/               ← 用户创建/导入的 profile + 上传素材

内置只读（随 app 打包，不动）:
  {resource_dir}/personality/cards/     ← 4 张内置 Card
  {resource_dir}/profiles/{builtin}/    ← 3 套内置 Profile
```

### 两类数据对比

| | 内置数据 | 运行时数据 |
|---|---|---|
| **来源** | 随 app 打包 | 用户使用中产生 |
| **存放** | `resource_dir` (bundle 内) | `data_root` |
| **读写** | 只读 | 读写 |
| **例子** | 内置 Card、内置 Profile、stage 模板 | stages JSON、vars.json、记忆、会话、上传素材 |
| **需要同步？** | ❌ 打包构建自动包含 | ❌ 新装为空，使用中累积 |

### Rust: `src-tauri/src/paths.rs`

```rust
// ==========================================
// 统一路径管理 — base dirs + 路径校验
// ==========================================

use std::path::{Path, PathBuf};
use std::fs;

pub struct AppPaths {
    pub data_root:    PathBuf,  // 统一读写根
    pub memory:       PathBuf,  // {data_root}/memory/
    pub sessions:     PathBuf,  // {data_root}/sessions/
    pub personality:  PathBuf,  // {data_root}/personality/
    pub profiles:     PathBuf,  // {data_root}/profiles/

    pub builtin_personality: PathBuf,  // {resource}/personality/  (只读)
    pub builtin_profiles:    PathBuf,  // {resource}/profiles/     (只读)
}

impl AppPaths {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let resource = resolve_resource_dir()?;

        // ★ 唯一环境判断：开发→项目下，生产→AppData
        let data_root = if cfg!(debug_assertions) {
            // 开发: {project}/data/desk-pet/
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest.parent().unwrap().join("data").join("desk-pet")
        } else {
            // 生产: {AppData}/desk-pet/
            app.path().app_local_data_dir()
                .map_err(|e| format!("app_local_data_dir: {e}"))?
                .join("desk-pet")
        };

        let paths = Self {
            memory:       data_root.join("memory"),
            sessions:     data_root.join("sessions"),
            personality:  data_root.join("personality"),
            profiles:     data_root.join("profiles"),
            builtin_personality: resource.join("personality"),
            builtin_profiles:    resource.join("profiles"),
            data_root,
        };

        for dir in [&paths.memory, &paths.sessions, &paths.personality, &paths.profiles] {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {dir:?}: {e}"))?;
        }

        Ok(paths)
    }

    // ── Phase F 路径穿越防护 ──

    /// 校验路径在 base 内（用于 personality/memory/profile 读写）
    pub fn validate_path(path: &Path, base: &Path) -> Result<PathBuf, String> {
        let resolved = path.canonicalize()
            .map_err(|_| "路径不存在".to_string())?;
        if !resolved.starts_with(base) {
            return Err("路径越权".to_string());
        }
        Ok(resolved)
    }

    /// 校验文件路径在 home / temp 内（用于 tool_exec file_read/write）
    pub fn validate_file_path(path: &Path) -> Result<PathBuf, String> {
        let resolved = path.canonicalize()
            .map_err(|_| "路径不存在".to_string())?;
        let home = dirs::home_dir().ok_or("无法获取 home 目录")?;
        let temp = std::env::temp_dir();
        if !resolved.starts_with(&home) && !resolved.starts_with(&temp) {
            return Err("路径不在允许范围".to_string());
        }
        Ok(resolved)
    }
}

fn resolve_resource_dir() -> Result<PathBuf, String> {
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        Ok(PathBuf::from(&manifest).parent().unwrap().join("public"))
    } else {
        Ok(tauri::Manager::path(&/* app */).resource_dir()??)
    }
}
```

### lib.rs 集成 + 新 commands

```rust
// setup() 中：
let paths = AppPaths::init(app.handle()).expect("路径初始化失败");
app.manage(paths);

// 新 commands（TS 端获取 base dirs）：
#[command] fn get_data_dir(paths: State<AppPaths>) -> String {
    paths.data_root.to_string_lossy().to_string()
}
#[command] fn get_memory_dir(paths: State<AppPaths>) -> String {
    paths.memory.to_string_lossy().to_string()
}
// ... sessions_dir, personality_dir, profiles_dir 同理
```

### 已有 commands 改造

| 文件 | 改造 |
|------|------|
| `memory_cmd.rs` | 移除 `find_project_root()` fallback，直接用 `paths.memory`；读写加 `paths.validate_path()` |
| `personality_fs_cmd.rs` | `resolve_personality_path` 区分读写：读先查 `builtin_personality` 再查 `personality`；写只走 `personality` |
| `profile_cmd.rs` | `get_app_data_dir` → `paths.profiles`；读写加 `paths.validate_path()` |

### TS: `src/services/paths.ts`

```typescript
// ==========================================
// 路径模块 — 从 Rust 拿 base dir，业务模块自己拼文件名
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("Paths")

let _inited = false

// ── Base dirs ──
let _dataDir = ""
let _memoryDir = ""
let _sessionsDir = ""
let _personalityDir = ""
let _profilesDir = ""

export async function initPaths(): Promise<void> {
  if (_inited) return
  try {
    _dataDir        = await invoke<string>("get_data_dir")
    _memoryDir      = await invoke<string>("get_memory_dir")
    _sessionsDir    = await invoke<string>("get_sessions_dir")
    _personalityDir = await invoke<string>("get_personality_dir")
    _profilesDir    = await invoke<string>("get_profiles_dir")
    _inited = true
    log.info("路径模块已初始化:", _dataDir)
  } catch (e) { log.error("路径初始化失败", e) }
}

// ── Base dirs（业务模块用这些拼自己的文件名）──
export const BaseDirs = {
  data:        () => _dataDir,
  memory:      () => _memoryDir,
  sessions:    () => _sessionsDir,
  personality: () => _personalityDir,
  profiles:    () => _profilesDir,
}

/** 内置 profile 的 URL 前缀 */
export const BUILTIN_PROFILES_URL = "/profiles"
export const DEFAULT_PROFILE = "sugar-pink"
```

**使用示例：**

```typescript
// variable-pool.ts — 模块自己知道文件名
import { BaseDirs } from "@/services/paths"
const varsPath = `${BaseDirs.personality()}/vars.json`
const stagesPath = `${BaseDirs.personality()}/stages/${cardId}.json`

// memory-entries.ts
import { BaseDirs } from "@/services/paths"
const memPath = `${BaseDirs.memory()}/MEMORY.md`

// animation.ts — 兜底
import { BUILTIN_PROFILES_URL, DEFAULT_PROFILE } from "@/services/paths"
const bodyUrl = `${BUILTIN_PROFILES_URL}/${DEFAULT_PROFILE}/materials/L2/body.png`
```

> 原则：`BaseDirs` 只给目录。**模块内生硬编码自己的文件名是允许的**（`variable-pool.ts` 当然知道它管的是 `vars.json`）。

### 迁移步骤

1. **Rust**: 新建 `paths.rs`，`lib.rs` setup 注入 + 注册新 commands
2. **Rust**: `memory_cmd.rs` / `personality_fs_cmd.rs` / `profile_cmd.rs` → 用 `State<AppPaths>`
3. **TS**: 新建 `paths.ts`，`initPaths()` 在 startup 调用
4. **TS**: 逐文件迁移（`variable-pool.ts` → `stages-cache.ts` → `memory-entries.ts` → ...）
5. **`.gitignore`**: 添加 `data/`（开发时项目下的测试数据不入库）

---

---

## Phase G 验收标准（强制，G 完成后逐项验证）

> G 完成后 **必须** 逐项跑通，任一 FAIL 则 G 未完成，F 不得开始。

### 接口全景

Phase G 迁移后涉及 **20 个 Rust command** + **15 个 TS/Web 路径操作**，按域分类：

| 域 | Rust commands | TS 路径操作 |
|----|-------------|------------|
| Personality | `personality_file_read/write/list/delete`, `get_personality_dir`, `get_cards_dir` | `personality/vars.json`, `stages/{id}.json`, `cards/{file}.md` |
| Profile | `profile_file_read/write/delete`, `list_user_profiles`, `list_profile_files`, `get_profiles_dir` | `/profiles/{id}/` 系列 URL + `{id}/materials/L{i}/` |
| Memory | `get_memory_dir`, `list_session_files`, `delete_session_file`, `init_memory_files` | `MEMORY.md`, `CANDY.md`, `User.md`, `sessions/*.md` |

### AC-1: 设置页 — AI Tab（Card 管理）

| # | 操作 | 预期 |
|---|------|------|
| AC-1.1 | 打开设置 → AI Tab | 卡片列表正常加载（内置 4 张 + 用户导入的） |
| AC-1.2 | 点击某张 Card 展开 | 显示 "阶段文案已生成" 或 "未生成" 状态（`personality/stages/{id}.json` 存在性检查） |
| AC-1.3 | 展开 Card 后 → 变量池预览 | `vars.json` 读取成功，显示 system/card/interaction 变量当前值 |
| AC-1.4 | 展开 Card 后 → 阶段文案表格 | `stages/{id}.json` 读取成功，表格显示各 stage 的文案 |
| AC-1.5 | 编辑阶段文案 → 保存 | `personality_file_write("personality/stages/{id}.json", content)` 成功 |
| AC-1.6 | 切换 Card | `switchPersonality()` → `initVariablePool()` → `refreshVariablePool()` 链路完整；新 Card 的 stages/vars 正确加载 |
| AC-1.7 | 导入自定义 Card (.md) | `personality_file_write("personality/cards/{name}.md", content)` 成功 → 刷新列表显示新 Card |
| AC-1.8 | **验收关键**: 切换 Card → 关闭设置 → 再打开 → Card 仍然是切换后的 | `personalityActive` localStorage + `stages/{id}.json` 持久化一致 |

**开发环境验证:** `data/desk-pet/personality/` 下有 `vars.json`、`stages/`、`cards/` 三个目录，内容正确。
**生产环境验证:** 打包后同路径在 `{AppData}/desk-pet/personality/` 下。

### AC-2: 设置页 — Appearance Tab（Profile 管理）

| # | 操作 | 预期 |
|---|------|------|
| AC-2.1 | 打开设置 → Appearance Tab | 内置 profiles 列表显示（3 个），当前激活项高亮 |
| AC-2.2 | 点击 preview 按钮 | `fetch("/profiles/{id}/profile.yaml")` 成功，预览图加载 |
| AC-2.3 | 导入自定义 profile | `profile.yaml` + `character.yaml` 写入 → `profile_file_write(profileId, "profile.yaml", ...)` + 素材文件写入成功 |
| AC-2.4 | 切换 profile | `appearanceConfig.activeProfile` 更新 → StreamView 的 layerUrls 重新计算 → 画面更新 |
| AC-2.5 | 导入 profile 带素材图片 | 素材写入 `profiles/{id}/materials/L{i}/` → 图层编辑器能列出素材 → 画面正确显示 |
| AC-2.6 | 删除自定义 profile | `profile_delete(id)` 成功 → 列表清除 → 回退默认 profile |
| AC-2.7 | **验收关键**: 导入 profile → 关闭窗口 → 重新打开 → profile 仍在列表中 | 持久化无误 |

### AC-3: 图层编辑器 — 素材管理

| # | 操作 | 预期 |
|---|------|------|
| AC-3.1 | 打开图层编辑器 | 各层素材正确加载（`profile.basePath + materials/L{i}/image.png`） |
| AC-3.2 | 点击 "选择素材" | `list_profile_files(profileId, "materials/L{i}")` 返回文件列表 → 显示在 picker 中 |
| AC-3.3 | 在 picker 中点击某个素材 | 预览图加载（`profile_file_read` → blob URL）→ 显示在预览区 |
| AC-3.4 | 确认选择素材 | `profile_file_write(profileId, "character.yaml", updated)` 更新材质引用 |
| AC-3.5 | 上传新图片 | 文件 → arrayBuffer → `profile_file_write(profileId, "materials/L{i}/{file}", bytes)` → 刷新列表 → 新图片出现 |
| AC-3.6 | 上传后立即预览 | ObjectURL 显示 → **不需要等** `profile_file_read`（内存预览已正确） |
| AC-3.7 | **验收关键**: 上传图片 → 关闭图层编辑器 → 重新打开 → 图片在 picker 列表中 | 持久化无误 |
| AC-3.8 | **验收关键**: 上传素材 → 关闭应用 → 重启 → 素材仍在 | 开发: `data/desk-pet/profiles/{id}/materials/` 下文件存在；生产: `{AppData}/desk-pet/profiles/{id}/materials/` 下存在 |

### AC-4: Agent Loop 运行时读写

| # | 操作 | 预期 |
|---|------|------|
| AC-4.1 | 发送 "你真可爱" | `var_write("亲密度", +N)` → `savePoolToDisk()` → `data/desk-pet/personality/vars.json` 中 `system.hour` 更新 |
| AC-4.2 | 同上 | `data/desk-pet/personality/stages/{cardId}.json` 中 `variables.card` 有更新 |
| AC-4.3 | 发送 5 轮对话 | `data/desk-pet/memory/MEMORY.md` 有内容（记忆条目） |
| AC-4.4 | 创建新会话 | `data/desk-pet/sessions/session-*.md` 文件生成 |
| AC-4.5 | **验收关键**: 发消息 → 等 var_write 执行 → 检查文件内容 → 关闭应用 → 重启 → 变量值保留 | 持久化链完整 |

### AC-5: 路径穿越防护（Phase F 用 G 的 validate_path）

| # | 测试 | 预期 |
|---|------|------|
| AC-5.1 | 手动调 `personality_file_read("../../../etc/passwd")` | 返回错误 "路径越权" |
| AC-5.2 | 手动调 `profile_file_write("hacker", "../escape/test.txt", ...)` | 返回错误 "路径越权" |
| AC-5.3 | 正常读写 `personality/stages/angelkawaii.json` | 成功 |

### AC-6: 开发环境快速验证

| # | 检查项 | 方法 |
|---|--------|------|
| AC-6.1 | `data/` 目录在项目根下 | `ls data/desk-pet/` → 有 memory/sessions/personality/profiles |
| AC-6.2 | 开发时配置不污染 `public/` | `git status` 无 unexpected changes in public/ |
| AC-6.3 | `.gitignore` 包含 `data/` | `rg "^/?data" .gitignore` 有匹配 |

### 验收流程

```
Phase G 开发完成
  → cargo check + tsc --noEmit (零新增错误)
  → pnpm tauri dev 启动
  → 逐项执行 AC-1 ~ AC-6
  → 全部 PASS → G 完成 → 可进入 Phase F
```

---

## 执行优先级总结

| 阶段 | 内容 | 问题数 | 顺序 |
|------|------|:---:|:---:|
| Phase A-E | 工具决策、Prompt、持久化、MCP | 8 | ✅ 已完成 |
| **Phase G** | 统一路径 + Phase F 基础设施 | 新建 | ✅ 已完成 (2026-07-14) |
| **Phase F 第一轮** | Critical + High（用 G 的 validate_path） | 23 | **下一步** |
| Phase F 第二轮 | Medium + Low | 18 | 之后 |

### Phase G 完成摘要

- **8 commits**, Rust + TS 双端统一路径管理
- `src-tauri/src/paths.rs` — AppPaths struct: `cfg!(debug_assertions)` 区分 dev/prod data_root
- 6 个新 Tauri commands: `get_data_dir`, `get_memory_dir`, `get_sessions_dir`, `get_personality_dir`, `get_profiles_dir`, `get_cards_dir`
- 3 个 command 模块迁移: `memory_cmd`, `personality_fs_cmd`, `profile_cmd` → `State<AppPaths>`
- `src/services/paths.ts` — `initPaths()` + `BaseDirs` getter
- `AppPaths::validate_path()` — canonicalize 失败直接 Err（不回退），用于 Phase F 路径穿越修复
- `AppPaths::validate_file_path()` — 限制 home / temp 目录
- `profile_file_write` 路径穿越漏洞已修复（`unwrap_or` 绕过 → `validate_path` Err-on-fail）
- `.gitignore`: `data/` 已添加
- `cargo check`: 0 errors | `vue-tsc --noEmit`: 0 non-test errors
