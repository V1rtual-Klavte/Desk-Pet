# 运行时数据与配置

## 唯一路径策略

Rust `AppPaths` 是环境判断和运行时路径的唯一真相源。前端必须先执行
`initPaths()`，需要完整文件路径时通过 `runtimePath(scope, ...segments)` 交给 Rust
拼接和校验；业务模块不能自行判断开发/生产环境或硬编码数据根。

| 环境 | 数据根 | 配置真相源 |
|---|---|---|
| 开发调试构建 | `{project}/data/desk-pet/` | 工作区 `CONFIG-DEV.yaml`，不存在时 `CONFIG.yaml` |
| 生产发布构建 | Tauri 应用标识专属的 `app_local_data_dir` | `data_root/settings/CONFIG.yaml`，首次由默认 `CONFIG.yaml` 初始化 |

`CONFIG-DEV.yaml` 是完整开发配置，不是与默认配置合并的增量覆盖层。生产配置不再依赖打包进前端的开发文件；设置页、配置导入导出和运行时写入同一份生产 CONFIG。

Live Test 仅在 debug 构建且 `DESKPET_LIVE_TEST=1` 时将数据根替换为系统临时目录；测试结束会删除该目录。它不属于正常开发或生产运行位置，阶段种子由 `AppPaths` 从开发数据根复制，测试脚本不维护数据目录布局。

## 数据布局

```text
data_root/
├── settings/CONFIG.yaml                 # 生产配置
├── memory/                              # CANDY.md、User.md、MEMORY.md、Project.md
├── sessions/
│   ├── index.json                       # 仅 UI 状态，可安全丢弃
│   └── session-YYYYMMDD-HHmmss-主题.md  # 会话正文和摘要真相源
├── personality/                         # Card 阶段与变量状态
├── profiles/                            # 用户导入/复制的 Profile
└── skills/{name}/SKILL.md               # 模型用 read 加载的 Skill，随包种子首次复制
```

会话 Markdown 的每轮记录同时含可读预览与完整原文元数据，历史格式仍可读取。启动时先扫描 Markdown 重建会话历史，再用 `index.json` 恢复上次打开和活跃的标签；index 损坏不应丢失任何对话。

## Profile 素材覆盖

默认 Profile 随应用一起打包，源文件位于 `src-tauri/resources/defaults/profiles/`，生产构建作为
Tauri bundle resource 提供给后端。首次启动只将缺失文件复制到运行时目录，并在
`settings/.default-resources-seeded` 写入初始化标记；之后运行时只读取 `data_root/profiles/`，
默认 Profile 与用户 Profile 没有权限差异，均可直接编辑、复制、导出和删除。

标记写入后不再自动补齐，误删或想同步随包资源的更新时，用设置页的「恢复默认资源」
（`restore_default_resources`）手动触发。该命令用种子**覆盖**运行时同名文件，因此
会丢弃用户对内置 Profile / Card 的改动；种子之外的用户自建资源不受影响。

当前随应用提供的默认 Profile 包括 `sugar-pink`、`dark-purple`、`glass` 和 `yuki`；`yuki` 的五层
透明 PNG 契约为 `profiles/yuki/materials/L0/bg_base.png`、`L1/rain_mid.png`、
`L2/body.png`、`L3/highlights.png` 与 `L4/rain_front.png`；五张图应保持同一画布尺寸与
主体位置。

用户导入和复制的 Profile 都写入 `profiles/{profileId}/`。所有 Profile 的颜色、素材等修改
都只写这个目录。Profile 选择会保存到
运行时 CONFIG 的 `appearance.activeProfile`，下次启动从该值恢复。

`appearance.effectMode`（`off` / `parallax` / `dof`）是角色展示效果的唯一开关：
灵动图层与景深互斥，用单字段枚举避免出现两个开关同时为真。`appearance.parallax`
只保存灵动图层的全局强度。

两种效果各自的素材与参数都只从当前 Profile 读取，图层编辑器也只写回当前 Profile：
灵动图层是 `theme.parallax.layers`，景深是 `theme.depthOfField`。旧 CONFIG 中遗留的
`appearance.parallax.layers` / `appearance.parallax.enabled` 会被忽略，不能覆盖或串入
另一个 Profile。Profile 切换与用户 Profile 保存通过 `deskpet-profile-updated` 事件让
各 WebView 重新加载同一个 Profile；效果模式改动经 `deskpet-settings-saved` 即时生效。

Profile 没有自带窗口 UI 位图时，可在 `theme.useDefaultUi` 声明为 `true`，运行时会直接
使用默认 Profile 的 UI，而不是请求当前 Profile 的空 `ui/` 目录。该回退仅用于 UI 位图；灵动
图层素材不会跨 Profile 回退，缺失时会停止该层并在编辑器中标记。

## 不再使用的缓存

`localStorage` 不再存储配置、会话正文、会话列表、图层编辑结果、分割线位置或音效分配。启动配置完成后会清理旧 `deskpet_*` key，避免旧缓存重新覆盖文件真相源。
