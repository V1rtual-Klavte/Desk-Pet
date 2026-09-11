@AGENTS.md

# Claude Code 补充

上方 `@AGENTS.md` 是**导入指令**，会在每次会话启动时把 AGENTS.md 的全部内容注入上下文。
本文件不承载任何规则 —— 唯一来源始终是 AGENTS.md。

⚠️ 不要把 `@AGENTS.md` 改成 Markdown 链接 `[AGENTS.md](AGENTS.md)`，那样就退化成普通超链接，
**AGENTS.md 不会被加载**（只会变成一句建议 agent 自己去读的话）。也不要复制 AGENTS.md 的内容过来，
那会制造两份需要同步的规则。

本文件只在需要写 **Claude Code 专属**补充时追加内容；通用开发约束一律写进 AGENTS.md。
