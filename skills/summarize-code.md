---
id: summarize-code
name: 代码摘要
description: 分析指定代码文件/目录，生成结构化摘要
trigger_keywords: ["帮我看看代码", "分析这个项目", "这段代码做什么的"]
tools_needed: [file.read, file.list, file.search]
mode: assistant
safety: safe
---
# 执行步骤

1. 如果 path 是目录 → 调用 file.list 获取文件列表
2. 调用 file.read 读取关键文件
3. 分析代码结构，生成摘要：技术栈、主要模块、入口文件、关键依赖
4. 输出格式化摘要
