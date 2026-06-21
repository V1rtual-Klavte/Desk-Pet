---
id: organize-files
name: 文件整理
description: 整理指定目录下的文件，按类型归类到子文件夹
trigger_keywords: ["整理文件", "归类", "帮我把文件移一下", "整理桌面"]
tools_needed: [file.list, file.read, bash.exec]
mode: assistant
safety: danger
---
# 执行步骤

1. 调用 file.list 列出目标目录中的所有文件
2. 按文件类型（扩展名）分类：图片、文档、代码、压缩包等
3. 为每个类型创建子文件夹（如 图片/、文档/、代码/）
4. 用 bash.exec 执行 mv 命令移动文件到对应文件夹
5. 返回整理结果摘要

注意：移动操作前需用户确认
