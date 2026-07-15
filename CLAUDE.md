# CLAUDE.md

> 糖糖桌宠 (Desk Pet) — Tauri v2 桌面虚拟主播助手
> **v5: 单次 LLM 回复，Card 永远激活 (neutral 兜底)**

## 技术栈

Tauri v2 + Vue 3 + TypeScript + Vite | pnpm | Rust/Cargo | OpenAI 兼容 Provider | 双端 Win+Mac

## 构建

```bash
pnpm install && pnpm tauri dev    # 开发
pnpm tauri build                  # 生产
cd src-tauri && cargo check       # Rust 检查
```

## 文档
在docs目录下，包含详细的设计文档。项目整体描述是DES.md

## 项目结构

```
src/services/
├── engine/      # Agent Loop v5, 会话状态机, Slash命令, 上下文压缩
├── personality/ # 人格模块: cards(4张+neutral默认), stages(LLM生成), 变量池v2, When引擎
├── tool/        # 工具: local(10个)/local-extra(7个,助手模式)/skill(3个)/mcp(5个)
├── context/     # buildPrompt() — 统一system prompt构建(角色+变量+工具+记忆)
├── reply/       # 回复后处理: generateReply() → ReplyResult {text,emotionKey,expression,sound}
├── agent/       # Provider, Runner, Sub-agent(fork/team), Sub-loop, Memory, Active
├── safety/      # 四级安全(SAFE/NORMAL/DANGER/NOWAY) + 三策略 + 确认弹窗
├── session/     # 多会话管理(store/manager/persistence)
├── audio/       # 33音效(8类), Web Audio合成
├── profile/     # 3套内置预设(sugar-pink/dark-purple/glass)
├── paths/       # 统一路径管理: initPaths() + BaseDirs (对应 Rust paths.rs)
└── window/      # 窗口监控→主动搭话

src-tauri/src/
├── paths.rs         # AppPaths: 统一 base dirs + validate_path() 路径穿越防护
├── commands/
│   ├── memory_cmd.rs        # 记忆文件系统命令 → State<AppPaths>
│   ├── personality_fs_cmd.rs # 人格文件系统命令 → State<AppPaths>
│   └── profile_cmd.rs       # Profile 文件系统命令 → State<AppPaths>
└── lib.rs           # setup() 中 AppPaths::init() + app.manage() + 6 个 path commands
```

## 核心数据流 (v5)

```
用户消息 → PreProcessor → refreshVariablePool() + When引擎
  → buildPrompt(card全量注入: 角色/风格/情绪/When语气/行为准则/变量池/记忆)
  → 单次LLM(永远非流式) → runToolLoop(安全→执行)
  → generateReply(raw, card) → 剥离[emo:key] + 表情/音效映射 + 截断
  → ReplyResult {text, emotionKey, expression, sound}
  → var_write即时落盘 stages/{cardId}.json
```

## 配置系统

```
CONFIG.yaml → Vite YAML Plugin → config.ts (getter + localStorage overrides)
```

**所有配置通过 `@/services/config` 读取**，禁止模块内硬编码常量。本地调参只改 CONFIG-DEV.yaml。

## 关键约束

- **Card 永远激活**: `getActiveCard()` 永不返回 null (neutral 兜底)
- **硬编码兜底**: 一律用 `getFallbackReply(key)` — stages cache → FALLBACK_FALLBACKS 多级降级
- **变量池 v2**: system(只读)/card(LLM可写,updateBy=llm)/interaction(系统,只读)/session(只读)
- **emotionMappings**: `card.sections.emotionMappings` 已是 `EmotionMapping[]`，直接用，勿重复 parse
- **stages**: 持久化到 `stages/{cardId}.json`，含变量状态和 fallbacks 字段

## 路径管理 (Phase G)

### 统一 data_root

```
开发 (debug_assertions):  {project}/data/desk-pet/
生产 (release):           {AppData}/desk-pet/
```

```
data_root/
├── memory/         MEMORY.md, CANDY.md, User.md, Outside.md, Project.md
├── sessions/       session-YYYYMMDD-HHmmss-主题.md
├── personality/
│   ├── stages/{cardId}.json   LLM 生成的阶段文案 + 变量状态
│   ├── vars.json              系统变量运行时状态
│   └── cards/                 用户导入的卡片 .md
└── profiles/
    └── {customId}/            用户创建/导入的 profile + 素材
```

- **内置数据**（cards/profiles）只读，走 `resource_dir` → `builtin_personality` / `builtin_profiles`
- **运行时数据**读写走 `data_root`
- **不加 `dirs` crate**，零外部依赖，用 `std::env::var` 获取 home 目录
- `.gitignore` 已包含 `data/`

### Rust 端规范

```rust
use crate::paths::AppPaths;

// 所有路径相关命令统一注入
#[tauri::command]
pub fn my_command(paths: tauri::State<AppPaths>) -> Result<(), String> {
    // 读写前必须 validate_path（不存在的文件校验父目录）
    AppPaths::validate_path(&file_path, &paths.personality)?;
    // ...
}
```

- **禁止** 手写 `dirs_next()` / `find_project_root()` / `env!("CARGO_MANIFEST_DIR")` 做路径解析
- **禁止** `canonicalize().unwrap_or()` 回退 — canonicalize 失败必须直接 Err
- 读操作: 先查 `builtin_*` 再查运行时目录
- 写操作: 只走运行时目录，必须 `validate_path()`
- 新 path command 在 `lib.rs` 中定义 + `invoke_handler!` 注册

### TS 端规范

```typescript
import { BaseDirs, initPaths } from "@/services/paths"

// startup 时调用一次
await initPaths()

// 业务模块自己拼文件名
const varsPath = `${BaseDirs.personality()}/vars.json`
const memPath = `${BaseDirs.memory()}/MEMORY.md`
```

- `BaseDirs` 只给目录，**模块内硬编码自己的文件名是允许的**
- 不要在 `paths.ts` 里写死业务文件名

## 编码约定

- **优先复用已有代码，不过度设计、不过度抽象**
- **所有操作必须 Win+Mac 双端适配**
- Vue 用 `<script setup lang="ts">`
- **统一导入路径**: `@/services/engine` / `personality` / `tool` / `agent` / `context` / `reply`
- **配置走 `@/services/config`**，不在模块里写死常量
- 日志: `createLogger("前缀")` — 格式 `[HH:MM:SS.mmm] LEVEL [前缀] msg`

## 日志

统一输出到 `pnpm tauri dev` 终端 + DevTools Console。

```ts
import { createLogger } from "@/services/logger"
const log = createLogger("模块名")
log.debug/info/warn/error(...)
```

---

## Git 分支规范

```
master   ← 稳定分支，只接受 merge，不直接 commit
V1rtual  ← 开发分支，所有改动先上 V1rtual，验证通过后合入 master
klavte   ← 备用分支
```

- **严禁直接在 master 上 commit** — 所有改动在 V1rtual 分支进行，提交信息用中文
- 流程: `V1rtual: commit → push → review通过 → merge到master → push master`
- 合并用 `git merge V1rtual --no-ff`（保留分支历史）
- `CLAUDE.md` 用户规则已明确：**不主动 commit/push**（除非用户明确要求）

## 开发流程规范

### 修改代码

1. **先读后写** — 理解现有代码再改动，基于事实不猜
2. **先给思路** → 用户同意 → 编码 → 自己测试调用链 → 确保日志正常
3. **优先复用已有代码**，不过度设计、不过度抽象
4. **所有操作必须 Win+Mac 双端适配**

### 验证标准

```bash
cd src-tauri && cargo check    # Rust: 零新增 error
npx vue-tsc --noEmit           # TS:   零新增 error（test 文件的 pre-existing error 忽略）
```

### 代码审查

- 使用 skill 和子 agent（`ecc:code-reviewer`）进行 review
- 分步实现，每步完成后 review，通过再继续
- 推荐用 SDD (Subagent-Driven Development) 模式: implementer → reviewer → fix → re-review
- 严禁假实现、漏实现

### 修改后必须同步更新

| 改动类型 | 需同步的文件 |
|----------|-------------|
| 任何代码修改 | `CLAUDE.md`（如影响规范） |
| 架构/模块变更 | `README.md` + `DES.md` |
| 配置项修改 | `CONFIG.yaml` + `CONFIG-DEV.yaml` 以及其template + 设置页面 |
| 新增/删除模块 | `CLAUDE.md` 项目结构图 |

## 用户规则

- **每次回复最后加"宝"**
- **任何修改必须**: 先给思路→用户同意→编码→自己测试调用链→确保日志正常
- **修改完成后必须同步更新**: README.md / CLAUDE.md / DES.md
- **配置项修改必须同步**: CONFIG.yaml + CONFIG-DEV.yaml + 设置页面
- **有疑问先探索代码，基于事实不猜**
- **不主动 git commit/push**（除非用户明确要求）
- **Git: 先动 V1rtual，再合 master，不动 master 基**
