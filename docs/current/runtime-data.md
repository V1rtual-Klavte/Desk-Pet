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

## 数据布局

```text
data_root/
├── settings/CONFIG.yaml                 # 生产配置
├── memory/                              # CANDY.md、User.md、MEMORY.md、Project.md
├── sessions/
│   ├── index.json                       # 仅 UI 状态，可安全丢弃
│   └── session-YYYYMMDD-HHmmss-主题.md  # 会话正文和摘要真相源
├── personality/                         # Card 阶段与变量状态
└── profiles/                            # 用户 Profile 和内置 Profile 的素材覆盖文件
```

会话 Markdown 的每轮记录同时含可读预览与完整原文元数据，历史格式仍可读取。启动时先扫描 Markdown 重建会话历史，再用 `index.json` 恢复上次打开和活跃的标签；index 损坏不应丢失任何对话。

## Profile 素材覆盖

内置 Profile 通过前端打包资源只读提供，不复制到生产数据目录。用户写入
`profiles/{profileId}/` 后，同一相对路径的图片优先从该目录加载；没有覆盖的文件仍回退内置资源。这允许为内置 Profile 定制图层，同时避免整套素材重复占用磁盘。

## 不再使用的缓存

`localStorage` 不再存储配置、会话正文、会话列表、图层编辑结果、分割线位置或音效分配。启动配置完成后会清理旧 `deskpet_*` key，避免旧缓存重新覆盖文件真相源。
