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
└── window/      # 窗口监控→主动搭话
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

## 用户规则

- **每次回复最后加"宝"**
- **任何修改必须**: 先给思路→用户同意→编码→自己测试调用链→确保日志正常
- **修改完成后必须同步更新**: README.md / CLAUDE.md / DES.md
- **配置项修改必须同步**: CONFIG.yaml + CONFIG-DEV.yaml + 设置页面
- **有疑问先探索代码，基于事实不猜**
- **不主动 git commit/push**（除非用户明确要求）
