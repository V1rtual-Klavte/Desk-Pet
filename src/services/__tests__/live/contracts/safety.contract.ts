import type { ModuleContract } from "../types"

export const safetyContract: ModuleContract = {
  module: "safety",
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/safety/checker.ts", "src/services/safety/permission.ts", "src/services/safety/confirm.ts", "src/services/tool/types.ts", "src/services/tool/policy.ts", "src/services/tool/local/pi-tools.ts", "src/services/tool/mcp/client.ts", "src-tauri/src/paths.rs", "src-tauri/src/commands/bash_policy.rs"],
  generatedAt: "2026-09-23",
  sourceHash: "43c8e2ea12884c10be2309f52b9b831d4165364f34543c561af7bef43d34330e",
  coverage: [
    { id: "sf-01", feature: "SAFE 级别放行", description: "safetyLevel=SAFE 工具被直接放行", why: "安全等级体系基础", depth: "shallow", scenarios: ["safety-safe"] },
    { id: "sf-02", feature: "NORMAL 级别检查", description: "safetyLevel=NORMAL 工具执行前检查", why: "常规工具需要安全评估", depth: "shallow", scenarios: ["safety-normal"] },
    { id: "sf-03", feature: "DANGER 级别拦截确认", description: "safetyLevel=DANGER 触发用户确认弹窗；同一份参数被确认过之后放行，换一组参数重新确认；let_me_tk 模式下会话信任不参与；测试宿主按场景声明的策略确定性应答（默认拒绝）", why: "危险操作需确认，且确认通道不得挂起", depth: "deep", scenarios: ["safety-danger", "safety-confirm-denied", "safety-confirm-approved"] },
    { id: "sf-04", feature: "NOWAY 直接拒绝", description: "safetyLevel=NOWAY 工具直接拒绝", why: "绝对不允许的操作", depth: "shallow", scenarios: ["safety-noway"] },
    { id: "sf-05", feature: "bash 危险命令匹配", description: "BASH_DANGEROUS_PATTERNS 匹配 rm 递归删除（合并/分开/长选项）与 sudo 等危险命令", why: "命令注入防护", depth: "shallow", scenarios: ["safety-danger-pattern"] },
    { id: "sf-06", feature: "bash NOWAY 匹配", description: "BASH_NOWAY_PATTERNS 匹配 rm -rf /（根目录）与 sudo rm 等硬禁止命令，且不误杀 rm -rf /home/user", why: "系统破坏命令禁止", depth: "shallow", scenarios: ["safety-noway-pattern"] },
    { id: "sf-07", feature: "文件路径分级", description: "resolveFilePathLevel 按路径分级：私钥凭据一律 NOWAY、.env 与系统目录 DANGER、普通路径 SAFE，Windows 反斜杠先归一，缺失 path 参数不提级；FILE_DANGEROUS_PATTERNS 仍是两级模式的并集；该分级确实挂在注册过的生产工具上 —— pi-read 按调用参数里的 path 分级，pi-bash 在命令模式匹配之后按同一规则逐个路径 token 取更严者（`cat ~/.ssh/id_rsa` 升为 NOWAY，普通路径不被误提级）", why: "敏感文件泄露防护，且分级必须真正接在生产工具上而不只是被断言", depth: "shallow", scenarios: ["safety-file-pattern"] },
    { id: "sf-08", feature: "会话信任粒度", description: "会话信任的粒度是「工具 + 本次参数」：同一份参数确认过才免再询问，换参数不继承；单参调用仍是工具级信任；resetSessionTrust 清空两种信任；任一种信任都不能越过动态 NOWAY", why: "用户确认后免重复弹窗，但确认一个参数不能顺带放行该工具的其他调用", depth: "deep", scenarios: ["safety-trust-lifecycle"] },
    { id: "sf-09", feature: "LLM 危险 Bash 调用实际拦截", description: "模型请求 rm -rf / 时，Bash 硬禁止策略在执行前拒绝执行；模型输出由 fake Provider 固定，工具与安全链路真实", why: "端到端安全验证", depth: "deep", scenarios: ["safety-dangerous-delete"] },
    { id: "sf-10", feature: "Pi 工具门禁 fail-closed", description: "Pi 原生工具门禁（Harness before_tool 复用同一语义）在 block 与抛错两种情况下都不执行工具，并留下带原因的 error 工具结果", why: "工具门禁必须 fail-closed，否则安全策略只是建议", depth: "deep", scenarios: ["safety-hook-errors"] },
    { id: "sf-11", feature: "MCP passthrough 终裁", description: "MCP 适配器的权限意见只能是 policy.permission.defaultDecision=passthrough；PermissionKernel 必须把它收敛为 allow、ask 或 deny，executor 不得看到 passthrough", why: "发现远端工具不等于默认信任", depth: "deep", scenarios: ["permission-passthrough-final"] },
    { id: "sf-12", feature: "PermissionKernel deny-first", description: "不可放宽的 NOWAY 硬拒绝优先于工具策略里的 allow；工具策略的独立 ask 不被普通 allow 吞掉，工具策略的 allow 也不能把标准决策的 ask 降级为放行", why: "权限组合必须 fail-closed", depth: "deep", scenarios: ["permission-deny-first"] },
    { id: "sf-13", feature: "确认身份与失效", description: "权限评估要求 sessionId、runGeneration、toolCallId 与当前代际；缺失、取消或旧代际一律拒绝", why: "旧确认不得授权新回合", depth: "deep", scenarios: ["permission-identity-invalid"] },
    { id: "sf-14", feature: "精确会话授权", description: "allow_session 仅复用相同 session、generation、tool、参数与策略指纹的未过期授权；策略指纹由工具策略（含策略版本与执行维度）、本次解析的风险等级与安全模式共同决定，任何一项变化都不复用旧授权", why: "一次确认不能扩大到其他输入、回合或已改变的策略", depth: "deep", scenarios: ["permission-session-grant"] },
    { id: "sf-15", feature: "取消确认", description: "已取消 signal 的确认立即按拒绝结算，不遗留 pending UI", why: "取消不能让旧确认继续授权", depth: "deep", scenarios: ["permission-aborted-confirm"] },
    { id: "sf-16", feature: "凭据路径的 Rust 终判", description: "经 IPC 直连 file_read 与 bash_exec：凭据路径（`.ssh` 目录组件、`.pem`/`.key` 后缀，`.sshnotes` 这类前缀不算）被拒绝 —— 文件入口返回 SENSITIVE_PATH 而不是 PATH_NOT_FOUND（判定先于 canonicalize，不存在的路径也一样），bash 入口返回 TOOL 且文案指明凭据路径（两种 scope 共用层 1 硬基线，白名单里放了 `cat` 也照样拒绝，所以拒绝不可能来自白名单或超时）", why: "TS 分级副本可被绕过，凭据泄露的最终判定必须在 Rust 且不可关闭", depth: "deep", scenarios: ["safety-credential-paths"] },
    { id: "sf-17", feature: "私钥读取被拦", description: "模型请求 read .ssh/id_rsa 时工具不以 done 收场、不经确认通道放行（确认被批准也不能把它放行），会话条目里不出现 OpenSSH 私钥正文", why: "私钥只读一次就足以泄露，且泄露会持久化进会话文件", depth: "deep", scenarios: ["safety-credential-read-blocked"] },
    { id: "sf-18", feature: "凭据命令的子进程边界", description: "模型请求 bash 把私钥重定向到文件时工具不以 done 收场；策略在 spawn 之前拒绝（被拦回合的耗时远早于命令自然时长），重定向产物不存在 —— 子进程从未产生", why: "bash 是绕过文件工具读取凭据的另一条入口，拦截必须发生在执行之前", depth: "deep", scenarios: ["safety-credential-bash-blocked"] },
  ],
  rules: { minScenarios: 7, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: true },
}
