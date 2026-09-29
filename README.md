# Desk-Pet

糖糖桌宠（Desk-Pet）是可自定义角色与外观的桌面陪伴应用。角色常驻桌面，能聊天、感知前台窗口并主动搭话，也能调用工具完成文件读写、命令执行与任务编排。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/V1rtual-Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)

## 特性

- **角色与人格**：Card 定义角色设定、语言风格与互动变量，同一桌宠可切换多个角色。
- **外观定制**：Profile 包含主题、立绘、字体与素材，支持图层与景深效果，可复制、导入导出。
- **窗口感知**：读取前台应用与窗口标题，按停留时长与冷却主动搭话，可随时关闭。
- **桌面交互**：透明置顶窗口、全局快捷键、托盘与音效。
- **工具与扩展**：文件读写、Bash、系统信息、剪贴板、计划与子代理；Skill 按需加载，MCP 按服务器在运行期借用。所有执行受统一权限策略约束。
- **对话连续性**：多会话切换与历史恢复；长会话按预算压缩上下文，完整正文保留在本地。

启动时不连接 MCP；记忆整理也不在启动时自动发起（只按用户操作或显式开启的空闲策略运行）。工具执行不等于无条件授权：Rust 保留路径裁决与命令安全基线。长期记忆由本地 SQLite 承载：跨会话召回、显式记住/纠正/忘记与「整理产出待审候选、用户批准后才生效」的 dreaming 已接通；记忆管理在设置页的「记忆」标签里。

## 技术栈

Tauri v2 · Vue 3 + TypeScript · Rust · Pi Agent Core

## 环境要求

- Node.js 22
- Rust toolchain
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ 构建工具与 WebView2 运行时

pnpm 版本由 [package.json](package.json) 的 `packageManager` 指定。

## 快速开始

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
| `pnpm tauri build` | 构建安装产物 |
| `pnpm run test:types` | TypeScript 类型检查与 Rust 编译检查 |
| `pnpm run test:rust` | Rust 单元测试 |
| `pnpm run test:e2e -- --module <模块>` | 运行指定模块的 E2E 场景 |
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
