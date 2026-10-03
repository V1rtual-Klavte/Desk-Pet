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
| Windows（免安装） | `v1rtual-desk-pet_x.y.z_x64-portable.zip` | 解压到任意目录，双击里面的 `v1rtual-desk-pet.exe` 即可，不写注册表、不产生卸载项 |

> **免安装版不是「全便携」** —— 它免的只是安装步骤：数据仍然写在
> `%LOCALAPPDATA%\com.v1rtual.deskpet\`（跟安装版共用同一份数据），换目录或换机器不会把数据带走。
> 另外它不自带 WebView2 运行时兜底：Windows 11 和绝大多数 Windows 10 已预装，干净系统需要先手动装
> [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（安装版会自动处理这一步）。
> 应用内的自动更新对免安装版会把「安装版」装进来——想一直保持免安装形态，就手动换新的 zip。

> **首次打开会被系统拦一下** —— 当前安装包**未做代码签名与公证**：
> - macOS 提示「已损坏，无法打开」时，把应用拖进「应用程序」后执行
>   `xattr -dr com.apple.quarantine /Applications/v1rtual-desk-pet.app`，再打开。
> - Windows 弹 SmartScreen「已保护你的电脑」时，点「更多信息 → 仍要运行」。

装完之后不用手动追版本：应用启动约 30 秒后会检查一次更新，发现新版本会在聊天里
发一条系统消息并弹出确认框，点「下载并安装」即可。

## 特性

- **角色与人格**：Card 定义角色设定、语言风格与互动变量，同一桌宠可切换多个角色。
- **外观定制**：Profile 包含主题、立绘与素材，支持图层与景深效果，可复制、导入导出；字体在设置/外观里全局选择（系统已安装字体，不随 Profile）。
- **窗口感知**：读取前台应用与窗口标题，按停留时长与冷却主动搭话，可随时关闭。
- **桌面交互**：透明置顶窗口、全局快捷键、托盘与音效。
- **工具与扩展**：文件读写、Bash、系统信息、剪贴板、计划与子代理；Skill 按需加载，MCP 按服务器在运行期借用。所有执行受统一权限策略约束。
- **对话连续性**：多会话切换与历史恢复；长会话按预算压缩上下文，完整正文保留在本地。

启动时不连接 MCP。记忆整理按配置的空闲策略和持久预算运行，也可在设置页手动触发；合格的可信用户来源经整批校验后自动提交，设置页「记忆」可查看来源、历史版本、纠正和忘记。工具执行仍受权限策略与 Rust 安全基线约束。

主动陪伴支持有来源的事项跟进、明确约定、节令、轻话题与有限展示，统一受静默、忙碌、未回复档位和每日预算约束。聊天中可用 `/proactive on`、`/proactive off`、`/proactive status` 控制，用 `/behavior clear` 清除派生观察画像；关闭窗口监控后，有来源的独立约定仍可执行。运行边界见[主动陪伴](docs/current/proactive.md)。

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

macOS 的窗口监控需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权。

## 使用

首次启动后，在设置窗口选择 Card、Profile 与 AI 模型，并按需开启窗口监控、MCP 服务器与 Skill 条目。聊天框内输入 `/help` 查看全部命令：`/skill` 调用技能，`/compact` 整理当前会话上下文。

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
| `pnpm run test:memory-performance` | release 存储与 debug IPC 性能评测 |
| `pnpm run test:trace-review -- <理想稿> <trace> <manifest> <审阅>` | 用户理想线路的 AI 审阅证据门禁 |
| `pnpm run test:release` | 发布门禁：类型与编译 + Rust 单测 + 严格 E2E 场景 |

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
