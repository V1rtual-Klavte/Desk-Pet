<div align="center">

# V1rtual-Desk-Pet

<sub>虚拟桌宠</sub>

**可自定义角色与外观的桌面宠物 —— 常驻桌面陪你聊天，感知你在做什么，也能替你干点小活。**

[![Release](https://img.shields.io/github/v/release/V1rtual-Klavte/Desk-Pet)](https://github.com/V1rtual-Klavte/Desk-Pet/releases/latest)
[![License](https://img.shields.io/github/license/V1rtual-Klavte/Desk-Pet)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#下载安装)
[![Bundled Node](https://img.shields.io/badge/node-22.22.3_bundled-3c873a)](packaging/node-runtime.json)

<p align="center">
  <img src="docs/images/theme-1.webp" width="270" alt="桌宠演示 · 主题一（浅色）">
  <img src="docs/images/theme-2.webp" width="270" alt="桌宠演示 · 主题二（明亮）">
  <img src="docs/images/theme-3.webp" width="270" alt="桌宠演示 · 主题三（暗色）">
</p>

</div>

## 这是什么

V1rtual-Desk-Pet 是一款**可自定义 人格卡 / 图层 的桌面宠物**，优先做好轻量陪伴与聊天。

角色以透明置顶窗口常驻桌面：可以陪聊、感知前台窗口并在合适的时候主动搭话，也能调用工具完成文件读写、命令执行与任务编排。整个应用由 Rust 原生宿主（含原生 UI 与平台能力）与一个随包分发的 Node 运行时组成，**没有 WebView**，安装包开箱即用，用户无需自备 Node。

设计方针：轻量、低内存、高性能、节省 token、功能完整。目标平台为 Windows 与 macOS。

## 功能特性

### 陪伴与对话

- **拟人表达**：普通聊天分条出现、显示正在输入；工具任务即时给结果。可在 AI 设置关闭。
- **插话与排队**：回复生成期间仍可继续发送消息，选择「插话」在当前响应结束后处理，或「稍后继续」等待任务自然收尾；排队中的消息可逐条撤回。
- **图片消息**：点击聊天框「图片」、拖入原文件，或直接粘贴剪贴板图片（⌘V / Ctrl+V）。
- **对话连续性**：多会话切换与历史恢复；长会话按预算压缩上下文，完整正文保留在本地。

### 角色与外观

- **人格卡（Card）**：定义角色设定、语言风格与变量，同一桌宠可切换多张卡；默认角色 void 出厂没有名字，由你在对话里给她起。设置页「人格」提供新建 / 编辑 / 重命名 / 导入 / 导出 / 删除，另附一份**编写模版**——复制给 AI，就能照着生成一张新卡。
- **变量**：人格卡可以声明自己的变量（如名字、好感度），由角色在对话中按卡内规则更新；类型与范围有硬约束，模型不能新增变量或越界乱写。变量随卡持久化，会改变她的语气与状态，跨过设定的档位还会成为她主动搭话的由头。
- **灵动图层**：立绘按层拆分，各层随光标轻微位移，形成景深跟随效果（设置「外观 → 角色展示」开关并调强度）。图层编辑器可调整图层顺序、显隐与缩放；右栏「没有素材？」提供**素材生成提示词**——复制给生图 AI，按层描述生成，或丢图让它抠图 / 补图。
- **外观（Profile）**：立绘与素材的集合，可新建（空 Profile，逐步加素材）、重命名、删除与导入导出。
- **界面主题**：五套内置主题与全局字体（设置 / 外观）。

### 记忆与主动陪伴

- **静默了解**：在设置「AI → 静默访问」用「静默了解频率」档位（关 / 低 / 中 / 高）开启与调节——「关」不自动了解（读取靠手动），低 / 中 / 高按固定钟点每日 2 / 4 / 6 轮。运行时截图优先观察前台窗口，读取哪些本地文件或目录由 AI 根据当前窗口判断（整机只读，仍禁凭据、密钥路径与应用数据根）；宿主逐项校验、只读不写，带来源的了解与用户事实分开。
- **长期记忆**：合格的可信用户来源经整批校验后自动提交；在聊天里右键你自己的消息选「记住这条」，或直接说一句「记住……」。设置页「记忆」可查看来源原话与历史版本、切换核心画像标记、纠正与遗忘（同步失效运行中的旧记忆投影），并可继续或预览整理作业与备份恢复。记忆整理默认按空闲策略与持久预算运行，也可在设置页手动触发。
- **主动陪伴**：在设置「AI → 主动陪伴」选「主动消息档位」（关 / 低 / 中 / 高，约 1–2 / 2–4 / 4–8 条每天）与静默时间段（可选，设定后该时段不打扰）。开启后会做有来源的事项跟进、明确约定、节令、轻话题与有限展示，统一受忙碌、未回复档位与每日预算约束。拟人表达与静默了解是独立开关，静默了解关闭后独立约定仍可执行。清除派生观察画像可在聊天里发送 `/behavior clear`。运行边界见[主动陪伴](docs/current/proactive.md)。

### 工具与扩展

- **内置工具**：文件读写、Bash、系统信息、截图、剪贴板、计划与子代理。
- **Skill**：按需加载，不占用常驻上下文。
- **MCP**：按服务器在运行期借用（stdio 或 Streamable HTTP），未启用的服务器不连接、不占进程；启动时不连接 MCP。
- 所有执行受统一权限策略与 Rust 安全基线约束。

### 桌面与平台

- **一键呼出与收回**：自定义组合键（设置「通用 → 快捷键」，至少一个修饰键）随时呼出 / 收回；呼出后焦点直接落在输入框，收回后交还给你之前用的应用——全程不用动鼠标，也能让桌宠帮你查东西、干杂活。呼出位置支持跟随光标与固定位置两种模式。
- 透明置顶窗口、五层角色渲染、托盘与音效。
- 单实例守卫：同一数据根只运行一个宿主，重复启动会明确提示后退出。
- 应用内自动更新：启动约 30 秒后自动检查一次（设置 → 通用 也可手动检查），确认后自动完成下载、校验、重启与安装。

## 占用与性能

打包版分平台实测；常驻进程只有两个：Rust 宿主 + 唯一 Node Harness（MCP 未启用时不驻留）。

| 平台 · 状态 | 内存（私有口径） | CPU |
|---|---|---|
| macOS（arm64）· 收回（空闲） | 宿主约 91 MB（其中活跃私有约 11 MB，其余为系统按需压缩）+ 内置 Node 约 36 MB | 约 0.2% |
| macOS（arm64）· 打开 | 宿主约 91 MB（其中活跃私有约 11 MB，其余为系统按需压缩）+ 内置 Node 约 36 MB | 约 1.4% |
| Windows · 收回 / 打开 | 待实测 | 待实测 |



## 架构

应用由两个进程组成：**`crates/native-host` —— Rust 原生宿主**（唯一常驻，管界面、观察与执行）与 **`src/` —— 唯一 Node**（业务与模型侧），两者经私有 IPC 互通；界面原生绘制，没有 WebView。

### 项目结构

```text
Desk-Pet/
├── crates/native-host/            原生宿主（Rust）：窗口 · 渲染 · 观察 · 执行 · 更新
│   └── src/
│       ├── ui/                    主窗 · 设置 · 图层编辑器 · 托盘 · 主题
│       ├── render/                五层角色舞台（CALayer / Layered Window）
│       ├── monitor/ window/       前台窗口 · 锁屏 · 截图观察
│       ├── memory/ proactive/     长期记忆与主动链（SQLite 同库，惰性打开）
│       ├── commands/              工具执行域：Bash 池 · 文件 · 截图 · MCP 进程桥
│       ├── host/ ipc/             命令分派 NativeDispatcher · Node 监督器 · 私有通道
│       └── paths/ update/         路径与安全基线 · 应用内更新
├── src/
│   ├── harness/main.ts            Node 唯一入口（bootstrap）
│   └── services/                  业务层（TypeScript，随包 Node 22.22.3 运行）
│       ├── engine/                Pi Agent 回合 · 会话 JSONL · 上下文压缩
│       ├── context/               分层构建与共享预算 · 工具输出投影
│       ├── tool/ safety/ skill/   工具路由 · 权限策略 · Skill 清单
│       ├── agent/memory/          记忆召回 · 来源采集 · dreaming 整理
│       ├── proactive/             机会 · 约定 · 预算 · 消息回执
│       ├── native-ui/             投影帧组装 · 宿主请求应答
│       └── personality/ reply/    人格卡 · 互动变量 · 回复元数据
├── resources/defaults/            出厂资源：角色卡 · 主题 · 字体素材
├── packaging/                     打包配置与随包 Node 锁定版本
├── scripts/                       开发与校验脚本：dev 启动 · 版本 · 打包
├── test/                          三层测试 · 契约 · 评测（规则见 test/AGENTS.md）
└── docs/                          设计与工程文档（索引见 docs/INDEX.md）
```

每个目录内部的模块地图、状态所有权与完整调用链见[系统地图](docs/current/system-design.md)。

### 依赖关系

- **运行时零外部依赖**：Node 22.22.3 随包分发、界面原生绘制；MCP 服务器按需借用，未启用不连接、不驻留。
- **唯一出网口是模型服务**：OpenAI 兼容接口（默认 DeepSeek，也支持 OpenAI / Ollama / LM Studio 等），Provider 调用单点收在 `engine/harness/model-gateway.ts`。
- **唯一跨进程通道是私有 IPC**（macOS Unix socket / Windows 命名管道）：Node → 宿主命令（`HostCommandMap`，逐条对应 Rust `NativeDispatcher`）、宿主 → Node 请求（`HostRequestMap`，`host_request_result` 回执）、事件（`HostEventMap`）；超限字段自动走 blob 二进制帧。业务层不直接碰窗口，宿主不直接碰模型。

## 下载安装

去 [Releases](https://github.com/V1rtual-Klavte/Desk-Pet/releases/latest) 取对应平台的文件
（页内其余文件是自动更新用的，手动安装不需要）：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS（Apple Silicon） | `v1rtual-desk-pet_x.y.z_aarch64.dmg` | 打开后把应用拖进「应用程序」。暂不支持 Intel Mac |
| Windows（安装版） | `v1rtual-desk-pet_x.y.z_x64-setup.exe` | 双击安装 |

> **首次打开会被系统拦一下** —— 当前安装包**未做代码签名与公证**：
> - macOS 提示「已损坏，无法打开」时，把应用拖进「应用程序」后执行
>   `xattr -dr com.apple.quarantine /Applications/v1rtual-desk-pet.app`，再打开。
> - Windows 弹 SmartScreen「已保护你的电脑」时，点「更多信息 → 仍要运行」。

出厂提供默认设置，仅需配置 API Key 即可。


装完之后不用手动追版本：应用启动约 30 秒后会自动检查一次更新，也可以随时到
设置 → 通用 的「检查更新」手动检查。发现新版本后只需确认一次，应用会自动完成
下载、校验、重启与安装（安装由退出后的独立 helper 完成，全程无需手动步骤）；
安装包与临时文件会在新版本首次启动时清理。

## 从源码运行

上面下载的是打包产物；下面是把同一份代码跑起来的方式，两者等价。

安装包没有任何额外的运行时依赖（Node 随包分发，界面为原生绘制）。从源码构建还需要：

- Node.js 22（仅开发工具链使用；`build:harness` 的目标是 Node 22）
- Rust toolchain
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ 构建工具

pnpm 版本由 [package.json](package.json) 的 `packageManager` 指定。

```bash
git clone https://github.com/V1rtual-Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install

# 创建本地配置（首次开发；该文件已存在时不要覆盖）
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml

pnpm dev
```

`pnpm dev` 分两步：先把随包资源暂存到 `packaging/dist/`（从 nodejs.org 取
[锁定版本](packaging/node-runtime.json)的 Node 并校验 SHA-256，版本一致时跳过；再构建
Harness 产物、把默认资源链接为种子），然后 cargo 构建并启动 `target/debug/native-host`；
debug 数据根为 `data/desk-pet/`。

编辑 `CONFIG-DEV.yaml` 填入模型服务与密钥。默认使用 DeepSeek，同时支持 OpenAI、Ollama、LM Studio 等 OpenAI 兼容接口。

macOS 的窗口观察需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权；截图需要系统已有的屏幕录制许可，不可用时回退窗口信息。

## 使用

首次启动后，在设置窗口（通用 / AI / 记忆 / 工具 / 外观）选择 Card、Profile 与 AI 模型，并按需配置拟人表达、静默访问、MCP 服务器与 Skill 条目。聊天框内输入 `/help` 查看全部命令：`/skill` 调用技能，`/compact` 整理当前会话上下文。
出厂提供默认设置，仅需配置 API Key 即可。

回复生成期间仍可继续发送消息，选择「插话」在当前响应结束后处理，或「稍后继续」等待任务自然收尾；排队中的消息可逐条撤回。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 完整开发环境：暂存随包资源 → debug 构建 → 启动原生宿主 |
| `pnpm run dev:prepare` | 只做随包资源暂存（随包 Node / Harness / 默认资源，幂等） |
| 本机打包 | 见[工作流说明](.github/workflows/README.md)「本机想验一次打包」；正式产物由 tag 触发 release.yml 构建 |
| `pnpm run test:types` | TypeScript 类型检查与 Rust 编译检查 |
| `pnpm run test:rust` | Rust 单元测试 |
| `pnpm run test:e2e -- --module <模块>` | 运行指定模块的 E2E 场景 |
| `pnpm run test:memory-quality` | 真实记忆质量采集，独立审阅后判定 |
| `pnpm run test:memory-bench:prepare` | 安装外部记忆基准数据（锁定版本 → 指定目录；数据集不进仓库） |
| `pnpm run test:memory-bench` | 外部记忆基准观测运行（LongMemEval / LoCoMo / MemoryBank，不进 CI） |
| `pnpm run test:memory-bench:<梯队>` | 分层观测运行：`smoke` / `regression` / `zh` / `difficulty` / `external`；日常默认 `regression`，节奏见[基准 README](test/memory-bench/README.md) §8 |
| `pnpm run test:memory-performance` | release 存储与 debug IPC 性能评测 |
| `pnpm run test:trace-review -- <理想稿> <trace> <manifest> <审阅>` | 用户理想线路的 AI 审阅证据门禁 |
| `pnpm run test:release` | 发布门禁：类型与编译 + 纪律扫描 + Rust 单测 + L2/L3 + 严格契约与 3 trials 的全量 E2E |

## 测试

类型与编译检查不代表运行时通过。L4 端到端在真实原生宿主与唯一 Node（随包 Node，不进浏览器）中执行真实服务层、Rust IPC 与完整的会话、工具、持久化链路，数据根隔离，Provider 可以是真实服务或确定性 fake；发布门禁执行严格契约校验与三次重复试验，跳过与超时的场景不得报通过。命令细节与场景规范见 [测试 README](test/README.md)。

[CI](.github/workflows/ci.yml) 在 macOS 与 Windows 上执行编译检查、Rust 单测与 L2 / L3 快层（经重试入口，附测试纪律扫描与 FLAKY 棘轮），不执行 L4 端到端。

## 数据与配置

开发数据保存在 `data/desk-pet/`，生产数据保存在应用专属目录（macOS `~/Library/Application Support/com.v1rtual.deskpet`、Windows `%LOCALAPPDATA%\com.v1rtual.deskpet`），均不随仓库分发。修改 `.gitignore` 或提交本地配置前需确认不会带入密钥与用户数据。

**便携模式（把数据留在安装盘、不占系统盘）**：在可执行文件同层放一个空的 `portable.txt`（macOS 放在 `.app` 的**同级目录**），数据根就改为安装位置旁的 `data/` —— 会话、记忆、设置与默认资源副本全落那一处；删掉该文件即回到默认位置。**卸载不会删除用户数据**（会话与记忆不可再生），需要清干净时手动删掉上面两个目录之一。

## 文档

- [文档索引](docs/INDEX.md)：完整目录与按任务导航
- [产品设计](docs/DES.md)：玩法、交互与用户可感知行为
- [系统地图](docs/current/system-design.md)：模块位置、主链路与状态所有权
- [工程参考](docs/current/development.md)：日志、异常、IPC 与构建排查
- [开发约束](AGENTS.md)：代码、文档与提交规范

## 许可证

[MIT](LICENSE)
