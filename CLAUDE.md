# CLAUDE.md

> 糖糖桌宠 (Desk Pet) — Tauri v2 桌面虚拟主播助手

---

## 技术栈

- **桌面框架**: Tauri v2 (Rust 后端 + WebView 前端)
- **前端**: Vue 3 + TypeScript + Vite
- **Rust 包管理**: Cargo
- **前端包管理**: pnpm
- **AI 后端**: 统一 OpenAI 兼容 Provider (DeepSeek / OpenAI / Ollama / LM Studio)
- **YAML 解析**: js-yaml (devDependency, Vite 插件编译时转换)
- **目标平台**: Windows + macOS

---

## 构建 & 运行

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 开发模式 (Vite + Rust 编译 + 桌面窗口)
pnpm dev              # 仅前端 dev server (端口 1420)
pnpm tauri build      # 生产构建
cd src-tauri && cargo check   # Rust 编译检查
```

---

## 项目结构

```
Desk-Pet/
├── docs/                         # 设计文档
├── CONFIG.yaml / CONFIG-DEV.yaml # 配置
├── public/profiles/              # Profile 系统 (3个内置)
├── memory/ / sessions/ / skills/ # 记忆/会话/技能
├── src/
│   ├── components/ / composables/ # UI组件 + 灵动图层
│   └── services/
│       ├── profile/    # Profile 加载/CSS注入/导入导出
│       ├── engine/     # Agent Loop, 会话, Slash命令
│       ├── personality/# ★ 人格模块 v5 (变量池v2)
│       ├── tool/       # 工具系统 (local/local-extra/skill/mcp)
│       ├── safety/     # 四级安全 + 会话信任
│       ├── context/    # 上下文引擎 (Prompt组装+压缩)
│       ├── reply/      # 回复后处理
│       └── agent/      # AI Provider + Runner
├── src-tauri/          # Rust 后端 (Tauri commands)
└── public/assets/      # 静态资源 (角色/字体/UI)
```

---

## 配置系统

```
CONFIG.yaml (默认) → CONFIG-DEV.yaml 可覆盖/dev模式
  → Vite YAML Plugin (编译时转换)
  → src/services/config.ts (类型化 getter + localStorage userConfig 覆盖)
```

**所有模块通过 `@/services/config` 读取配置**，不在模块内定义常量。本地调参只改 `CONFIG-DEV.yaml`。

---

## 日志系统

所有日志统一输出到 **运行 `pnpm tauri dev` 的终端**，同时保留 DevTools Console。

```ts
import { createLogger } from "@/services/logger";
const log = createLogger("模块前缀");

log.debug("调试信息...");
log.info("重要节点");
log.warn("警告");
log.error("错误", err);
```

输出格式：`[HH:MM:SS.mmm] LEVEL [前缀] 消息`

Rust 端用 `rust_info!` / `rust_debug!` / `rust_warn!` 宏，格式一致。

---

## 数据流

```
启动 → sessions/ 扫描 → localStorage 镜像
SessionTabs → App.vue bridge → chat.ts (★ 唯一状态管理)

主动搭话: 窗口监控 → sendActiveMessage() → AgentLoop
用户聊天: sendMessage() → PreProcessor → AgentLoop

AgentLoop (每轮):
  → refreshVariablePool() + updateInteractionVar(unansweredCount→0)
  → When 引擎求值
  → Phase1 (能力层) → 工具循环(安全校验→执行)
  → Phase2 (角色层, 可选) → 情绪标签剥离 → 流式输出
  → var_write 即时落盘 stages/{cardId}.json

全局快捷键 → 弹出/收回动画
托盘 → 隐藏/恢复窗口
```

详见 docs/DES.md 完整数据流架构。

---

## 变量池 v2

四类变量 system/card/interaction/session：

| 类型 | 真相源 | 可写？ | 持久化 |
|------|--------|--------|--------|
| `system` | 运行时计算（6 个） | 否 | `vars.json` (快照) |
| `card` | Card 注册表 | LLM 可写（仅 updateBy=llm） | `stages/{cardId}.json:variables.card` |
| `interaction` | 系统事件 | 否（LLM 只读） | `stages/{cardId}.json:variables.interaction` |
| `session` | 会话 markdown | 否 | `sessions/*.md` frontmatter |

**关键约束**：
- `var_write` 只能写已注册且 `scope=card` + `updateBy=llm` 的变量，校 type/min/max/enum
- `var_delete` = reset 到 initial，不真删
- `updateInteractionVar()` 系统内部 API；`applyResetPolicies()` 每轮 daily/session reset
- Card `# 变量定义 > ## card / ## interaction` → YAML block → `CardVariableDef[]`

详见 `docs/DESIGN-VARIABLE-POOL-v2.md`。

---

## 编码约定

- **优先复用已有代码**，不过度设计、不过度抽象
- **任何操作必须同步做 Windows + macOS 双端适配**
- Rust 平台代码用 `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "macos")]` 守卫
- Windows 专有依赖用 `[target.'cfg(windows)'.dependencies]`
- Vue 组件用 `<script setup lang="ts">` 语法
- 新增表情在 `animation.ts` 加一条即可
- **AI 模块通过 `@/services/agent` 统一导入**
- **人格模块通过 `@/services/personality` 统一导入**
- **工具模块通过 `@/services/tool` 统一导入**
- **引擎模块通过 `@/services/engine` 统一导入**
- **灵动图层通过 `@/composables/useParallax` 统一导入（含 `layerDepth`）**
- 全局冷却/并发锁走 `cooldown.ts`
- 平台检测走 `@/services/env`
- **配置走 `@/services/config`**，不在模块里写死常量

---

## macOS 兼容状态

| 功能 | 状态 |
|------|------|
| AI 聊天 / Agent Loop / 工具调用 / 窗口监控 | ✅ 全平台 |
| 全局快捷键 / 桌面悬浮 / 系统托盘 / Dock弹出 | ✅ |
| 文件/系统/剪贴板 / 设置页 | ✅ |
| 系统通知 | ❌ 未签名构建无法实现 |

---

## 要求 ##
优先复用已有代码 不要过度设计和抽象
不要乱加 任何操作一定同步做win和mac双端适配
必须使用skill

## 必要操作 ##
每次回复的最后加："宝"
每轮修改结束必须同步更新：README.md（给用户看的）；CLAUDE.md；DES.md（给我看的，现有架构进度及各个实现）
有配置项修改的地方一定统一写在相应配置文件，并同步CONFIG.yaml和CONFIG-DEV.yaml及其example，以及设置页面
当我输入1时，默认从"要求.md"里获取需求
一定要先给我思路，不要直接改代码，我同意后方可开始编码
改动必须确认改动后调用链正常，自己测试一遍，确保目录下文件及其内容符合预期，日志正常

## 核心方针 ##
轻量化，低内存占用，高性能，token消耗少，功能强
我的设计的md只是大方向，最终还是要你写的时候自觉地不断补充，自觉完善逻辑来实现