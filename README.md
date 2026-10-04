# V1rtual-Desk-Pet

虚拟桌宠（V1rtual-Desk-Pet）是可自定义角色与外观的桌面陪伴应用。角色常驻桌面，能聊天、感知前台窗口并主动搭话，也能调用工具完成文件读写、命令执行与任务编排。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/V1rtual-Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)

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

装完之后不用手动追版本：应用启动约 30 秒后会检查一次更新，发现新版本会在聊天里
发一条系统消息并弹出确认框，点「下载并安装」即可；也可以随时到 设置 → 通用 的
「软件更新」里手动检查。

## 特性

- **角色与人格**：Card 定义角色设定、语言风格与互动变量，同一桌宠可切换多个角色；默认角色出厂没有名字，由你在对话里给她起。
- **外观定制**：Profile 包含主题、立绘与素材，支持图层与景深效果，可复制、导入导出；字体在设置/外观里全局选择（系统已安装字体，不随 Profile）。
- **静默了解**：截图优先观察前台窗口，读取哪些本地文件或目录由 AI 根据当前窗口判断（限用户主目录内、除凭据路径外），宿主逐项校验、只读不写；带来源的了解与用户事实分开。
- **拟人表达**：普通聊天分条出现、显示正在输入，工具任务即时给结果；可在 AI 设置关闭。
- **图片消息**：点击聊天框“图片”或拖入原文件；会话只保存原路径，模型请求临时读取图片，原文件移动或删除后显示不可用。也可以让她截图给你看：她说“看看你现在在做什么”时截取前台画面并展示在聊天里（需开启静默访问；截图保留最新 200 张，可直接查看或删除）。
- **桌面交互**：透明置顶窗口、全局快捷键、托盘与音效。
- **工具与扩展**：文件读写、Bash、系统信息、截图、剪贴板、计划与子代理；Skill 按需加载，MCP 按服务器在运行期借用。所有执行受统一权限策略约束。
- **对话连续性**：多会话切换与历史恢复；长会话按预算压缩上下文，完整正文保留在本地。

启动时不连接 MCP。记忆整理按配置的空闲策略和持久预算运行，也可在设置页手动触发；合格的可信用户来源经整批校验后自动提交，聊天里可对某条用户原话点「记住这条」。设置页「记忆」可查看来源原话与历史版本，切换核心画像标记，继续或预览整理作业与备份恢复，并纠正和忘记；纠正／遗忘会同步失效运行中的旧记忆投影。工具执行仍受权限策略与 Rust 安全基线约束。

主动陪伴支持有来源的事项跟进、明确约定、节令、轻话题与有限展示，统一受静默、忙碌、未回复档位和每日预算约束。聊天中可用 `/proactive on`、`/proactive off`、`/proactive status` 控制，用 `/behavior clear` 清除派生观察画像；AI 设置的主动消息、拟人表达和静默访问是独立开关；静默访问关闭后，独立约定仍可执行。运行边界见[主动陪伴](docs/current/proactive.md)。

## 技术栈

Tauri v2 · Vue 3 + TypeScript · Rust · Pi Agent Core

## 环境要求

- Node.js 22
- Rust toolchain
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ 构建工具与 WebView2 运行时

pnpm 版本由 [package.json](package.json) 的 `packageManager` 指定。

## 从源码运行

上面下载的是打包产物；下面是把同一份代码跑起来的方式，两者等价。

```bash
git clone https://github.com/V1rtual-Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install

# 创建本地配置（首次开发；该文件已存在时不要覆盖）
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml

pnpm tauri dev
```

编辑 `CONFIG-DEV.yaml` 填入模型服务与密钥。默认使用 DeepSeek，同时支持 OpenAI、Ollama、LM Studio 等 OpenAI 兼容接口。

macOS 的窗口观察需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权；截图需要系统已有的屏幕录制许可，不可用时回退窗口信息。

## 使用

首次启动后，在设置窗口选择 Card、Profile 与 AI 模型，并按需配置主动消息、拟人表达、静默访问、MCP 服务器与 Skill 条目。聊天框内输入 `/help` 查看全部命令：`/skill` 调用技能，`/compact` 整理当前会话上下文。

回复生成期间仍可继续发送消息，选择「插话」在当前响应结束后处理，或「稍后继续」等待任务自然收尾；排队中的消息可逐条撤回。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm tauri dev` | 完整桌面开发环境 |
| `pnpm dev` | 仅前端，不含 Rust IPC |
| `pnpm tauri build` | 构建安装产物（本地构建，产物在 `target/release/bundle/`；正式产物见 Releases 页）。未配置 updater 签名密钥时加 `--no-sign` |
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

类型与编译检查不代表运行时通过。Live Test 在独立 Tauri WebView 与临时数据根中执行真实前端服务、Rust IPC 与完整的会话、工具、持久化链路，Provider 可以是真实服务或确定性 fake；发布门禁执行严格契约校验与三次重复试验，跳过与超时的场景不得报通过。命令细节与场景规范见 [测试 README](test/README.md)。

[CI](.github/workflows/ci.yml) 在 macOS 与 Windows 上执行编译检查、Rust 单测与 L2 / L3 快层（经重试入口，附测试纪律扫描与 FLAKY 棘轮），不执行 L4 Live Test。

## 数据与配置

开发数据保存在 `data/desk-pet/`，生产数据保存在应用专属目录，均不随仓库分发。修改 `.gitignore` 或提交本地配置前需确认不会带入密钥与用户数据。

## 文档

- [文档索引](docs/INDEX.md)：完整目录与按任务导航
- [开发约束](AGENTS.md)：代码、文档与提交规范

## 许可证

[MIT](LICENSE)
