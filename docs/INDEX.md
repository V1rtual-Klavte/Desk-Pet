# 文档索引

按任务选择入口，不默认把 README、DES、全部 current 一起载入上下文。源码与配置决定实际行为；“当前文档”说明核对过的实现，“计划”说明尚未完成的目标。历史文档归档后封存，不再读取或修改；问题与后续工作只维护在未完成总表。

## 阅读入口

| 要解决的问题 | 先读 | 需要时再读 |
|---|---|---|
| 安装、运行、能力概览 | [README](../README.md)（[English](../README.en.md)） | [工程参考](current/development.md) |
| 产品定位、Card/Profile 玩法、交互 | [DES](DES.md) 对应章节 | [人格与回复](current/personality.md)、[资源所有权](current/runtime-data.md) |
| 找模块、跟踪主调用链 | [系统地图](current/system-design.md) | 目标源码与对应 current 文档 |
| TypeScript 业务服务与 HostBridge 接线规则 | [services AGENTS](../src/services/AGENTS.md) | 目标领域 current 与源码 |
| Rust 宿主、原生 UI 与平台规则 | [native-host AGENTS](../crates/native-host/AGENTS.md) | [工程参考](current/development.md)与目标源码 |
| 会话队列、Plan、取消、恢复、Pi 协议与 Harness 接线、PromptSnapshot | [运行时契约](current/runtime-contract.md) | [记忆与压缩](current/memory.md)、[工具系统](current/tool-system.md) |
| 配置、路径、Profile 持久化 | [运行时数据](current/runtime-data.md) | Config getter、AppPaths 和目标设置 Tab |
| 数据库表结构、schema 版本、库文件与 WAL | [数据库](current/database.md) | 记忆与主动链同库；行为见[当前记忆](current/memory.md)、[主动陪伴](current/proactive.md) |
| 工具权限、MCP、Skill | [工具系统](current/tool-system.md) | PermissionKernel、Router、对应工具实现 |
| 测试执行与验证边界 | [验证边界](current/development.md#验证边界) | [测试 README](../test/README.md)；生成契约时再读 [测试 SKILL](../test/SKILL.md) |
| 聊天评测与公开通用评测（三个 Skill、金银标、GAIA／MultiChallenge／MemoryArena／BEAM／LHTB） | [未完成总表 §12](plans/active/未完成工作与已知缺口.md#12-统一聊天评测闭环)（剩余验收项与能力缺口） | [评测说明](../test/sim/README.md)、[固定来源清单](../test/sim/desk-pet-chat/external/catalog.json)、[聊天](../test/sim/desk-pet-chat/SKILL.md)／[用例制作](../test/sim/desk-pet-eval-authoring/SKILL.md)／[运行判分](../test/sim/desk-pet-eval-runner/SKILL.md) Skill |
| 推 tag、发版、打包产物、自动更新 | [工作流说明](../.github/workflows/README.md) | [工程参考](current/development.md) 的「打包与发布」、`scripts/check-bundle-config.mjs`、`scripts/set-version.mjs` |
| 主动陪伴、行为画像、频率档位与统一调度 | [主动陪伴](current/proactive.md) | [运行时数据](current/runtime-data.md)、[工具系统](current/tool-system.md)、[运行时契约](current/runtime-contract.md)；剩余开放问题与验收见[未完成总表](plans/active/未完成工作与已知缺口.md) §10、§11 |
| 剩余未完成工作与收尾 | [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md) | 原生宿主收尾见 §8、§9，记忆重构与验证见 §3；[当前记忆](current/memory.md)及相关源码 |

## 文档职责与维护

| 文档 | 只维护什么 |
|---|---|
| [AGENTS](../AGENTS.md) | 全局约束与任务阅读路由；不承担项目百科、详细测试教程或动态进度 |
| [services AGENTS](../src/services/AGENTS.md) | TS 业务层的状态、配置取用、HostBridge、运行时与工具约束 |
| [native-host AGENTS](../crates/native-host/AGENTS.md) | Rust 宿主的类型、平台、原生 UI、执行边界与同步义务 |
| [test AGENTS](../test/AGENTS.md) | 测试域的规则入口、分层、门禁与维护义务 |
| README | 用户安装、启动、能力简介与文档导航 |
| DES | 产品定位、玩法与用户可感知行为 |
| current | 已核对的模块契约、关键边界与源码入口；按主题分文档 |
| plans/active | 未完成工作总表与尚在实施的目标契约；不为单一主题另开文档 |
| history | 封存当时设计、旧实现和验证证据；归档后不再读取或修改 |

一个事实只有一个主要维护位置，其他文件用链接。文档只在契约变化时同步：行为、接口/线协议、配置字段、用户入口、模块位置或状态所有权变化，更新对应 current / README / DES / 所属 AGENTS；纯内部重构（拆分、改名但行为与入口不变）只改系统地图的源码入口与路径引用，不逐篇追写总结。未变化的文档不为同步而追加总结。

运行时 CONFIG 字段新增、改名、删除或语义变化同时执行[配置变更同步清单](current/runtime-data.md#配置变更同步清单)，覆盖 CONFIG、开发模板、类型/getter、设置页、保存与刷新消费者。真实本地配置需单独授权，未同步/未验证项在交付中说明。归档前保留正文和证据，归档后封存；未完成总表直接写清剩余事项与验收条件，不依赖跳转历史。

计划/归档文件用简短文件头说明用途、状态、日期及替代入口；核对日期不代表整个工作树已验证。报告必须区分源码基线、执行环境和未验证项，不把旧通过数复制到每份概览。历史文件可能带 archived 或 implemented_verified 等状态，所在 history 目录均表示它不再是当前行为契约。

根 AGENTS 只维护全局规则；services、native-host、test 的 AGENTS 各自维护本域约束，通过链接引用全局条款，避免重复。模块细节通过任务路由按需读取。

## 未完成工作

- [未完成工作与已知缺口](plans/active/未完成工作与已知缺口.md)：**唯一未完成工作总表**——Pi 剩余批次、平台与发布、长期记忆剩余问题、活人感与整链陪伴的剩余环境验收、聊天评测剩余验收与能力缺口、已知代码缺口与验证缺口。

## 历史入口

`docs/history/` 归档后封存，不作为后续任务的阅读入口；不再读取或修改，当前问题与进度只看未完成总表。仍被当前文档直接引用的历史文件由引用方就地链接。

- [design](history/design/)：旧产品与交互设计、内核方案、视觉基准。
- [implementation](history/implementation/)：旧执行方案、契约基线与实施记录。
- [analysis](history/analysis/)：旧审查、收尾清单与验证快照。
- [source](history/source/)：源码快照与附录材料。
