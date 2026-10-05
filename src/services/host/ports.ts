// ==========================================
// HostBridge 环境端口 —— 宿主能力在领域代码里的唯一取用面
// ==========================================
//
// 这些端口是宿主能力在领域代码里的唯一取用面（执行契约 §4.1，
// `docs/history/implementation/原生宿主迁移过程记录-2026-10-04基线.md` §9.4 §9.4 第 35 条）：
//   - `HostEnvironment`：运行模式（日志级别默认、异常覆盖层 auto、开发期日志的判据）
//     与平台（平台分支的唯一来源，见 `@/services/env`）；
//   - `ResourceUrlResolver`：本地路径 → 本地渲染通道可读 URL（convertFileSrc 的语义）；
//   - `ExecutionPathKit`：Pi ExecutionEnv 的路径运算（home/temp/join/resolve/isAbsolute）。
//
// 装配方式与本包 HostBridge 同一模式（见 index.ts）：**接口在桶、实现由 Node bootstrap
// 注入、未注入抛 HostPortUnavailableError、无降级链**。实现在 `node-ports.ts`：
// `connectHostBridge()` 构造时注册（产品 harness 与 L4 宿主都走它；L2/L3 测试宿主由
// 测试侧的等价注入点装配）。把注册挂在桥实现的构造上不是「第二份取用口」：
// 桥实现就是环境适配层，一个进程只装配一个实现。
//
// **纯 UI 的窗口间协调不进这些端口**（原生宿主迁移过程记录 §9.4 第 7/35 条）：
// 端口只服务「Node 领域确实需要、且由环境提供」的能力。

/** 端口未注入时抛（引导接线错误；不允许用它做静默降级或兜底空实现）。 */
export class HostPortUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostPortUnavailableError"
  }
}

// ==========================================
// 运行模式
// ==========================================

/**
 * 宿主环境事实（同一次握手披露，同为唯一真相源）：
 * - `runtimeMode`：`ServerWelcome.runtimeMode`（W2 握手，不得改用 process.env）；
 * - `platform`：`ServerWelcome.platform`（Rust `HostPlatform`，`"windows" | "macos"`）。
 *
 * 领域代码用 runtimeMode 做「开发期行为」（日志级别默认值、异常覆盖层 auto、开发日志），
 * 不再自行读 `import.meta.env`；用 platform 做平台分支（快捷键修饰键等），不再嗅探
 * navigator/window（产品产物是 Node 构建，浏览器全局被构建参数置空）。
 */
export interface HostEnvironment {
  runtimeMode: "development" | "production"
  platform: "windows" | "macos"
}

let hostEnvironment: HostEnvironment | null = null

export function setHostEnvironment(environment: HostEnvironment | null): void {
  hostEnvironment = environment
}

export function getHostEnvironment(): HostEnvironment {
  if (!hostEnvironment) {
    throw new HostPortUnavailableError(
      "HostEnvironment 尚未注入：bootstrap 必须先调用 setHostEnvironment(...)。" +
        "Node 侧在 connectHostBridge() 里注册。",
    )
  }
  return hostEnvironment
}

// ==========================================
// 资源 URL
// ==========================================

/**
 * 「把本地绝对路径变成可被本地渲染通道读取的 URL」—— convertFileSrc 的语义。
 * Node 侧尚未注册实现（等 W7 的原生资源通道）；消费点未注入时以
 * HostPortUnavailableError 显式失败，不伪造 URL。
 */
export interface ResourceUrlResolver {
  toResourceUrl(localPath: string): string
}

let resourceUrlResolver: ResourceUrlResolver | null = null

export function setResourceUrlResolver(resolver: ResourceUrlResolver | null): void {
  resourceUrlResolver = resolver
}

export function getResourceUrlResolver(): ResourceUrlResolver {
  if (!resourceUrlResolver) {
    throw new HostPortUnavailableError(
      "ResourceUrlResolver 尚未注入：本环境没有本地资源 URL 通道" +
        "（Node 侧等 W7 的原生资源通道接入）。",
    )
  }
  return resourceUrlResolver
}

// ==========================================
// 执行环境路径运算
// ==========================================

/**
 * Pi ExecutionEnv 需要的宿主路径运算（全部 async，调用点不感知实现）：
 * Node 实现走 `node:path` / `node:os`（`node-ports.ts`）。
 *
 * 为什么不直接在领域文件里 import `node:path`：路径运算按宿主能力经端口取用，
 * 调用点只依赖接口，与其它环境端口同一装配模式；
 * 纯字符串运算的平台差异由实现层消化，领域代码不复制路径语义。
 *
 * home/temp 的真相源待定：宿主 `get_runtime_paths` 目前没有这两个域，本包不向 Rust
 * 新增字段；Node 实现按 OS 语义取（`node:os`），是否需要宿主告知由协调者裁定（见交付报告）。
 */
export interface ExecutionPathKit {
  homeDir(): Promise<string>
  tempDir(): Promise<string>
  join(...parts: string[]): Promise<string>
  resolve(...parts: string[]): Promise<string>
  isAbsolute(path: string): Promise<boolean>
}

let executionPathKit: ExecutionPathKit | null = null

export function setExecutionPathKit(kit: ExecutionPathKit | null): void {
  executionPathKit = kit
}

export function getExecutionPathKit(): ExecutionPathKit {
  if (!executionPathKit) {
    throw new HostPortUnavailableError(
      "ExecutionPathKit 尚未注入：bootstrap 必须先调用 setExecutionPathKit(...)。" +
        "Node 侧在 connectHostBridge() 里注册。",
    )
  }
  return executionPathKit
}
