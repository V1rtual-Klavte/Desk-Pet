---
id: check-weather
name: 天气查询
description: 查询指定城市的天气信息
trigger_keywords: ["天气", "气温", "下雨", "下雪", "热不热"]
tools_needed: [http.get]
mode: assistant
safety: safe
---
# 执行步骤

1. 从用户消息中提取城市名称
2. 如城市不明，询问用户
3. 调用 http.get 获取天气信息（或使用 MCP weather 工具）
4. 用口语化语言告诉用户天气情况和建议
