// ==========================================
// Slash 命令类型定义
// ==========================================

/**
 * 技能准入意图 —— `/skill <name> [额外指示]` 的出口形态。
 *
 * 命令层只声明「要启动哪个技能」：那条 `role:"user"` 消息由 Harness 在 `accept` 内按技能文件
 * 构造并提交（含技能文件的绝对路径），命令层不构造正文、不写会话条目。字段与 Harness 技能支
 * （`HarnessAdmitSkillSpec`）同名同形，构造点（`runtime.ts` 的 `admitInput` 调用）由编译器做
 * 最终核对 —— 这里不复制它的校验规则，也不留运行期约定。
 */
export interface SlashSkillAdmission {
  /** 技能名：Pi `Skill.name`，即技能清单里的键 */
  name: string
  /** 跟在技能正文之后的附加指示（命令名之后的余下文本） */
  additionalInstructions?: string
}

/** 命令执行结果：给用户看的文本（null = 不显示），或一次技能准入（由运行入口落盘并驱动回合）。 */
export type SlashCommandResult = string | null | SlashSkillAdmission

/**
 * Slash 命令定义。
 *
 * `Result` 是 `execute` 的结果面，缺省就是文本命令（现状形态）：只有把输入交给运行入口的
 * 命令（`/skill`）才需要实例化到 `SlashCommandResult`，两处都只这一份字段定义。
 */
export interface SlashCommand<Result extends SlashCommandResult = string | null> {
  /** 命令名（不含 /），如 "help", "smile", "win open" */
  name: string
  /** 简介描述，显示在下拉框和 /help 中 */
  description: string
  /** 分类，用于 /help 分组显示 */
  category?: "general" | "session" | "memory" | "skill" | "easteregg"
  /** 参数说明（可选），如 "[关键词]" */
  args?: string
  /**
   * 忙碌期（同会话有在飞运行）的准入策略，由 ingress 统一实施：
   * - immediate：只读查询/独立窗口动作，可立即执行，结果照常显示
   * - coordinated：交给命令自身的运行边界协调（如 /compact 报 busy/pending）
   * - exclusive（默认）：会改会话或运行状态，忙碌时明确拒绝，不在回合中途排队
   */
  busyPolicy?: "immediate" | "coordinated" | "exclusive"
  /**
   * 声明命令把「命令名之后的余下文本」当参数收（`/skill <技能名> [额外指示]`）。
   *
   * 只有声明了它的命令参与 `find()` 的最长前缀匹配；未声明的命令必须整串精确命中，
   * `win open` 这类含空格的命令名因此不会被前缀匹配抢走。
   */
  acceptsArgs?: boolean
  /**
   * 执行函数。
   *
   * @param args 声明了 `acceptsArgs` 时由 `find()` 拆出的余下文本（两端空白已去掉，不会有空串）；
   *             未声明的命令不接收它。
   * @returns 给用户的消息（null = 不显示），或一次技能准入 —— 后者交给运行入口在拿到运行代际后
   *          经 Harness 落盘并驱动回合，命令层不自己写会话条目。
   */
  execute: (args?: string) => Promise<Result>
}

/**
 * 注册表与 /help 持有的命令面：`execute` 的结果可能是文本，也可能是一次技能准入。
 *
 * 文本命令（`SlashCommand`，缺省结果面）都赋得进来 —— 结果面按协变放宽，命令自己的声明面不变。
 */
export type RegisteredSlashCommand = SlashCommand<SlashCommandResult>

/** 注册表中匹配到的命令 */
export interface SlashMatch {
  /** 匹配到的命令定义 */
  command: RegisteredSlashCommand
  /** 匹配度分数（完全匹配=3, 前缀匹配=2, 包含=1）用于下拉排序 */
  score: number
}

/** 执行路径的命中结果：命中命令 + 已拆出的余下参数（未声明可带参数或没带参数时为空） */
export interface SlashInvocation {
  command: RegisteredSlashCommand
  args: string | undefined
}
