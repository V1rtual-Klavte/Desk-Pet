# 🍬 糖糖桌宠（Desk-Pet）

可自定义角色与外观的桌面陪伴应用。角色常驻桌面，能聊天、感知前台窗口并主动搭话，也能使用工具完成文件读写、命令执行与任务编排。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)

## 能做什么

- **陪伴聊天**：Card 定义角色、语气、情绪和互动变量；支持多会话切换与历史恢复。
- **自定义外观**：Profile 包含主题、立绘和素材，可编辑、复制、导入导出；支持灵动图层与景深效果。
- **窗口感知**：开启监控后，根据前台应用和窗口标题主动搭话，可配置停留时长与冷却。
- **桌面交互**：透明置顶窗口、全局快捷键、托盘和音效。
- **工具协助**：文件读写、Bash、运行环境与窗口信息、剪贴板、应用打开、计划与子代理；执行受统一权限策略约束。
- **扩展能力**：Skill 提供按需加载的说明与工作流，`/skill` 可显式调用；MCP 提供外部工具，按服务器开关在运行期借用；具体操作同样受统一权限策略约束。
- **对话连续性**：长会话按预算压缩上下文，原始记录保留；压缩摘要与长期记忆分别管理。

用户长期记忆的自动提取、跨会话自动召回、画像写入与 dreaming 尚未接通。当前已提供会话记录、上下文压缩与只读用户画像入口；详见[记忆边界](docs/current/memory.md)。

启动不连接 MCP、不启动记忆 LLM 整理；Rust 保留路径裁决与命令安全基线，工具执行不等于无条件授权。

## 安装与运行

项目使用 Tauri v2、Vue 3/TypeScript、Rust 和 Pi Agent Core。

开发环境准备：

- Node.js 22（与当前 CI 一致）；pnpm 版本由 [package.json](package.json) 的 `packageManager` 指定。
- Rust toolchain。
- macOS：Xcode Command Line Tools。
- Windows：Tauri 所需的 Microsoft C++ 构建工具及 WebView2 运行环境。

```bash
git clone https://github.com/Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install
# 首次开发时创建配置；已有该文件时不要覆盖
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml
# 编辑 AI 端点、模型与密钥后启动
pnpm tauri dev
```

支持 DeepSeek、OpenAI、Ollama、LM Studio 等兼容接口。macOS 窗口监控可能需要在“隐私与安全性 → 辅助功能”中授权。

常用命令：

```bash
pnpm dev          # 只启动前端，不包含 Rust IPC
pnpm tauri dev    # 完整桌面开发环境
pnpm tauri build  # 构建安装产物
```

开发数据保存在 `data/desk-pet/`，生产数据保存在应用专属本地目录。配置选择、备份位置与资源恢复行为见[运行时数据](docs/current/runtime-data.md)。

## 使用与设置

在设置窗口选择 Card、Profile 和 AI 模型；开启所需的窗口监控，并按服务器开关 MCP、按条目开关 Skill。默认 Card/Profile 首次初始化后也是可编辑的运行时资源。“恢复默认资源”会覆盖同名内置资源的用户改动。

聊天框输入 `/help` 查看命令，`/skill` 调用技能，`/compact` 整理当前会话上下文。运行中仍可继续发送：发送按钮旁选择「插话」或「稍后继续」，排队中的消息显示在输入框上方并可逐条撤回。完整玩法、角色展示效果和交互方式见[产品设计](docs/DES.md)。

## 开发与验证

```bash
pnpm run test:types
pnpm run test:rust
pnpm test -- --module memory
```

类型与编译检查不代表运行时通过。Rust 单测覆盖仓内 Rust 纯逻辑（命令策略、路径校验、输出裁剪、工具许可），`pnpm run test:rust` 等价于 `cargo test --manifest-path src-tauri/Cargo.toml --lib`。Live Test 在独立 Tauri WebView 与临时数据根中运行，支持真实 Provider 和确定性 fake Provider；完整命令、场景规范及发布门禁以[测试 README](src/services/__tests__/live/README.md)为准。

[CI](.github/workflows/ci.yml) 在 macOS 与 Windows 执行类型/编译检查与 Rust 单测，当前不执行 Live Test。平台支持不等于所有 UI 行为均已通过双平台验收，验证范围见[测试说明](docs/current/testing.md)。

## 文档入口

- [文档索引与按任务导航](docs/INDEX.md)
- [产品定位、玩法与交互](docs/DES.md)
- [当前系统地图](docs/current/system-design.md)
- [开发约束](AGENTS.md)
- [未完成工作与已知缺口](docs/plans/active/未完成工作与已知缺口.md)
- [Pi 协议与 Harness 迁移基线（已实施并验证）](docs/history/implementation/Pi运行时与工具协议建设方案-2026-09-20基线.md)

## License

MIT
