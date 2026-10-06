// ==========================================
// bash 工具的超时档位 —— 默认 = 上限 = 5 分钟，模型只可下调
// ==========================================
//
// 零依赖叶子：唯一消费方是 `tool/local/pi-tools.ts` 的 `pi-bash` 注册点
// （档位声明 + 模型可见描述 + `prepareArguments` 夹取），无任何 import，
// 让「档位语义」能在 L2 直接测，不经工具 barrel 与宿主桥。
//
// 档位语义（对齐主流 harness 的「默认值与上限成对出现、上限只可放宽 + clamp 留痕」）：
// - 默认 300s：bash 跑的是用户的真实命令（`sleep`、慢构建、下载），全局 30s 会把合法
//   长命令误判成超时；300s 覆盖这类命令，同时给真正跑飞的进程一个上限。
// - 上限 300s：模型按次传的 `timeout`（秒）由 `clampBashTimeoutArguments` 统一夹取
//   `effective = min(请求值 ?? 默认, 上限)`，越界按上限执行（不是拒绝，也不是静默放大）。
// - 生效值必须一路下传到 Rust 的子进程兜底：Rust `DEFAULT_BASH_TIMEOUT_MS` 与本常量
//   同值，只作「调用方没传」的深防线；两个默认值一旦不同，就会复现「5 分钟档被
//   2 分钟隐藏天花板掐死」的旧故障（2026-10-06 排查，见 .superpowers/sdd/turn-gov/
//   timeout-research.md）。改这里必须同步 `crates/native-host/src/commands/tool_exec/bash.rs`。
//
// 口径分工：本档位兜的是**合法长命令**，不是「等待用户交互」。命令的 stdin 在 Rust 侧
// 关死（`Stdio::null()`），交互式命令会立即读到 EOF 失败；需要用户确认/选择的场合走
// 既有确认通道（计划确认面板），不要用 bash 弹窗或读 stdin 等用户 —— 工具超时不是给
// 这类等待擦屁股的机制（模型向描述里写明，见下方 `BASH_TOOL_DESCRIPTION_NOTE`）。

/** bash 工具的执行超时档位：默认 = 上限 = 5 分钟。 */
export const BASH_TOOL_TIMEOUT_MS = 5 * 60 * 1000

/** 与 `BASH_TOOL_TIMEOUT_MS` 同值的秒数与模型参数口径（`timeout` 参数单位是秒）。 */
export const BASH_TOOL_TIMEOUT_SECONDS = BASH_TOOL_TIMEOUT_MS / 1000

/** 追加到 bash 工具描述尾部的档位与交互口径（模型可见；中性系统说明，不是角色台词）。 */
export const BASH_TOOL_DESCRIPTION_NOTE =
  ` 超时：timeout 参数单位为秒，默认 ${BASH_TOOL_TIMEOUT_SECONDS}、上限 ${BASH_TOOL_TIMEOUT_SECONDS}（只可下调）；不提供时按 ${BASH_TOOL_TIMEOUT_SECONDS} 秒执行，提供超过上限的值按上限执行。命令的 stdin 已关闭，交互式命令会立即读到 EOF；需要用户点按、输入或确认的操作不要用命令阻塞等待 —— 走应用的确认/计划确认通道。`

/** `timeout` 参数在 schema 里的说明（覆盖上游「no default timeout」的过时口径）。 */
export const BASH_TIMEOUT_PARAMETER_DESCRIPTION =
  `Timeout in seconds (optional). 默认 ${BASH_TOOL_TIMEOUT_SECONDS} 秒、上限 ${BASH_TOOL_TIMEOUT_SECONDS} 秒（只可下调；超过按上限执行）。`

/**
 * `pi-bash` 的 `prepareArguments`：模型参数 → 生效超时的唯一夹取点。
 *
 * - 缺省（`undefined` / `null`）：补上默认值 —— Rust 收到的是显式生效值而不是 null，
 *   5 分钟档不依赖 Rust 兜底也能成立（兜底只作深防线，两侧同值）。
 * - 有限正数（含数字字符串，先按 pi 的数值强制转换口径归一）：`min(请求值, 上限)`。
 * - 其余非法值（0、负数、非数字）：原样留下，由 pi 自己的 `validateTimeout` / schema
 *   校验如实拒绝 —— 不在这里静默替换成默认值，避免吞掉模型的参数错误。
 */
export function clampBashTimeoutArguments(args: unknown): Record<string, unknown> {
  const params = typeof args === "object" && args !== null ? { ...args as Record<string, unknown> } : {}
  const raw = params.timeout
  if (raw === undefined || raw === null) {
    params.timeout = BASH_TOOL_TIMEOUT_SECONDS
    return params
  }
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
  if (Number.isFinite(value) && value > 0) {
    params.timeout = Math.min(value, BASH_TOOL_TIMEOUT_SECONDS)
  }
  return params
}

/** `withBashToolPolicy` 会碰的最小结构面；其余字段（执行体等）原样透传。 */
interface BashToolSurface {
  description: string
  parameters: { properties?: Record<string, unknown>; [key: string]: unknown }
  prepareArguments?: (args: unknown) => Record<string, unknown>
}

/**
 * 给 pi 的 bash 工具套上本应用的档位口径：
 * - 描述尾部追加 `BASH_TOOL_DESCRIPTION_NOTE`（档位 + stdin 关死的交互口径）；
 * - `timeout` 参数说明替换为夹取口径（上游「no default timeout」与实现不符）；
 * - `prepareArguments` 接上 `clampBashTimeoutArguments`（生效值下传 Rust 的唯一入口）。
 *
 * 只替换模型可见字段与参数准备；执行体与其它字段不动，返回的是同一个工具的新对象。
 */
export function withBashToolPolicy<T extends object>(tool: T): T {
  const surface = tool as unknown as BashToolSurface
  const properties = surface.parameters?.properties ?? {}
  const timeoutSchema = typeof properties.timeout === "object" && properties.timeout !== null
    ? properties.timeout as Record<string, unknown>
    : {}
  const patched: BashToolSurface = {
    description: `${surface.description}${BASH_TOOL_DESCRIPTION_NOTE}`,
    parameters: {
      ...surface.parameters,
      properties: { ...properties, timeout: { ...timeoutSchema, description: BASH_TIMEOUT_PARAMETER_DESCRIPTION } },
    },
    prepareArguments: clampBashTimeoutArguments,
  }
  return { ...tool, ...patched }
}
