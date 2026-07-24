import type { ModuleContract } from "../types"

export const variablePoolContract: ModuleContract = {
  module: "variable-pool",
  sourceFiles: [
    "src/services/personality/variable-pool.ts",
    "src/services/personality/types.ts",
  ],
  generatedAt: "2026-07-24T00:00:00.000Z",
  sourceHash: "70598f021290e11da4b4aba97d05816653fd5dff7740984285508cc44b71bf36",
  coverage: [
    // ── 初始化 / 销毁 ──
    {
      id: "vp-init",
      feature: "initVariablePool — 变量池初始化",
      description:
        "接收 cardId、变量定义注册表、可选的持久化 card/interaction 状态，构建完整的 VariablePool。系统变量实时计算，card/interaction 变量优先从持久化恢复（通过 validateVarAgainstDef 校验），否则用定义的 initial 值。",
      why: "变量池启动入口，决定 LLM 看到的初始变量状态是否正确",
      depth: "deep",
      scenarios: [
        "初始化：无持久化状态时用 default initial 值填充 card 和 interaction 变量",
        "初始化：有有效持久化状态时恢复 card 和 interaction 的 VariableState 对象",
        "初始化：持久化值 schema 不匹配时回退到 initial（如类型变更、超出范围）",
        "初始化后 session 为空对象，savePending 置为 true",
      ],
    },
    {
      id: "vp-init-fallback",
      feature: "initVariablePool — 持久化回退到 initial",
      description:
        "对每个 card/interaction 变量，若 prevState 存在且通过 validateVarAgainstDef 校验则恢复，否则使用 CardVariableDef.initial 创建新的 VariableState（updatedBy=system）。",
      why: "防止 corrupted 持久化数据污染内存池",
      depth: "deep",
      scenarios: [
        "持久化值类型与注册表 def.type 不一致 → 用 initial",
        "number 值超出 [min, max] 范围 → 用 initial",
        "string 值不在 enum 列表中 → 用 initial",
        "prevState 为 undefined（无持久化） → 用 initial",
      ],
    },
    {
      id: "vp-destroy",
      feature: "destroyPool — 变量池销毁",
      description:
        "将 currentCardId 置 null，registry 清空，pool 重置为 emptyPool()，savePending 置 false。",
      why: "切换卡片或关闭时需要彻底清理状态，不留残留",
      depth: "deep",
      scenarios: [
        "destroyPool 后 currentCardId 为 null",
        "destroyPool 后 registry 为空数组",
        "destroyPool 后 pool 四类变量全为空 Record",
        "destroyPool 后 savePending 为 false",
      ],
    },

    // ── 系统变量 ──
    {
      id: "vp-compute-system",
      feature: "computeSystemVariables — 系统变量计算",
      description:
        "根据当前时间 Date 计算 5 个系统变量（hour、minute、dayOfWeek、isNightTime、isWeekend），并注入 activeCardId 键。纯计算，无副作用。",
      why: "时间相关变量是 when-engine 和 LLM prompt 的基础输入",
      depth: "shallow",
      scenarios: [
        "hour 返回 0-23 的当前小时数",
        "isNightTime 在 22:00-5:00 返回 true，其余 false",
        "isWeekend 在周六(6)和周日(0)返回 true",
        "activeCardId 键被注入结果中",
      ],
    },
    {
      id: "vp-refresh",
      feature: "refreshVariablePool — 每轮刷新",
      description:
        "每轮 Agent Loop 开始时调用。根据 activeCardId（可为 null，兜底 currentCardId 或空串）重新计算 system 变量，返回池快照。",
      why: "确保 system 变量（时间相关）始终是最新的",
      depth: "deep",
      scenarios: [
        "传入 activeCardId 则更新 cardId 追踪并刷新 system",
        "未传入 activeCardId 时使用 currentCardId 兜底",
        "currentCardId 也为 null 时空串兜底",
        "刷新后 pool.system 时间变量已更新",
      ],
    },

    // ── Reset 策略 ──
    {
      id: "vp-reset-policies",
      feature: "applyResetPolicies — 重置策略执行",
      description:
        "遍历 registry 中的 card 变量，对 reset=daily（跨日期）和 reset=session（新会话）的变量重置为 initial。只处理 scope=card 的变量，跳过 reset=never。",
      why: "实现变量生命周期管理，确保每日/每会话状态归零",
      depth: "deep",
      scenarios: [
        "reset=daily：日期变化时重置变量为 initial",
        "reset=session：isNewSession=true 时重置变量为 initial",
        "reset=never：永不重置",
        "scope=interaction：不参与 reset 逻辑",
      ],
    },
    {
      id: "vp-reset-branching",
      feature: "applyResetPolicies — 策略分支与 daily 边界",
      description:
        "内部通过 lastDailyResetKey（yyyy-MM-dd）追踪跨日期 detect。仅当 scope=card 且 reset 非 never 时进入判断；daily 和 session 可同时触发。日期无变化时不触发 daily reset。",
      why: "避免同一天重复 reset，同时确保 date boundary 检测准确",
      depth: "deep",
      scenarios: [
        "同一日期内多次调用 applyResetPolicies 不重复 daily reset",
        "跨日期后首次调用触发 daily reset 并更新 lastDailyResetKey",
        "isNewSession=false 时不触发 session reset",
        "reset=daily 且日期未变时不触发",
      ],
    },

    // ── 只读查询 ──
    {
      id: "vp-snapshot",
      feature: "getPoolSnapshot — 获取池快照",
      description:
        "返回 VariablePool 的浅拷贝快照，四类变量均展开新对象。只读，不修改内部状态。",
      why: "外部模块需要读取变量池但不应直接修改内部引用",
      depth: "shallow",
      scenarios: [
        "快照的 system 修改不影响内部 pool.system",
        "快照包含 card/interaction/session 的完整拷贝",
        "返回类型符合 VariablePool 接口",
      ],
    },
    {
      id: "vp-registry",
      feature: "getVariableRegistry — 获取注册表",
      description:
        "返回当前注册的 CardVariableDef[] 引用。由 initVariablePool 设置。",
      why: "其他模块需要访问变量定义的元数据（type/min/max/enum/description）",
      depth: "shallow",
      scenarios: [
        "initVariablePool 后 registry 包含完整注册表",
        "destroyPool 后返回空数组",
      ],
    },
    {
      id: "vp-snapshot-state",
      feature: "snapshotVariablePoolState / restoreVariablePoolState — 状态快照与恢复",
      description:
        "snapshot 捕获 currentCardId、pool（拷贝）和 savePending；restore 从快照完全恢复内部状态，用于会话保存和恢复。",
      why: "会话持久化和 Sub-agent fork 需要完整的变量池状态迁移",
      depth: "deep",
      scenarios: [
        "snapshot 后修改内部 pool，不影响快照内的 pool",
        "restore 后内部状态与快照完全一致",
        "restore 后 savePending 状态被正确恢复",
      ],
    },

    // ── Prompt 格式化 ──
    {
      id: "vp-format-prompt",
      feature: "formatPoolForPrompt — 格式化变量池为 LLM prompt",
      description:
        "将四类变量格式化为人类可读的 prompt 片段，包含类型元数据（enum/范围/描述）。系统变量逗号分隔，card 变量逐行含元数据，interaction 和 session 按需展示。空池显示 (空)。",
      why: "LLM 需要结构化、信息量充足的变量上下文才能正确使用 var_write",
      depth: "shallow",
      scenarios: [
        "所有四类变量非空时 prompt 包含四个 section",
        "interaction/session 为空时不展示对应 section",
        "card 变量附带注册表元数据（type/enum/range/updateBy/description）",
        "system 变量为空时显示 (空)",
      ],
    },
    {
      id: "vp-format-empty",
      feature: "formatPoolForPrompt — 空池边界处理",
      description:
        "当某类变量为空时生成对应的占位/省略表示。system 和 card 显示 (空)，interaction 和 session 为空时整段省略不输出。",
      why: "避免空内容污染 prompt token 预算",
      depth: "shallow",
      scenarios: [
        "system 为空 → [系统变量 - 只读](空)",
        "card 为空 → [Card变量](空)",
        "interaction 为空 → 整段不输出",
        "session 为空 → 整段不输出",
      ],
    },

    // ── LLM 工具：读 ──
    {
      id: "vp-var-read",
      feature: "varRead — 读取单个变量",
      description:
        "按 system → card → interaction 顺序查找变量，返回 VarDef 格式（含 source、type、updatedAt）。未找到返回 null。card/interaction 变量提取 VariableState.value。",
      why: "LLM 通过 var_read 工具查询变量当前值",
      depth: "shallow",
      scenarios: [
        "读取 system 变量：返回 VarDef 含 source=system",
        "读取 card 变量：提取 VariableState.value，source=card",
        "读取 interaction 变量：source=interaction",
        "变量不存在：返回 null",
      ],
    },
    {
      id: "vp-var-list",
      feature: "varList — 列出所有变量",
      description:
        "遍历 pool 中四类变量，返回 VarDef[] 列表供 LLM 查看全局状态。",
      why: "LLM 需要概览所有变量以决定操作",
      depth: "shallow",
      scenarios: [
        "返回包含 system/card/interaction 所有变量的完整列表",
        "session 变量也被包含在结果中",
        "VarDef 包含 name/value/source/type/updatedAt 完整字段",
      ],
    },

    // ── LLM 工具：写 ──
    {
      id: "vp-var-write",
      feature: "varWrite — LLM 写入变量",
      description:
        "接收变量名和 rawValue 字符串，通过 5 层守卫验证后写入 pool.card。守卫链：system 只读 → interaction 只读 → 必须已注册 → updateBy 必须为 llm → 类型校验（通过 inferAndValidate）。写入后 savePending=true。",
      why: "LLM 修改变量池的唯一入口，安全校验至关重要",
      depth: "deep",
      scenarios: [
        "成功写入：rawValue 通过校验后 pool.card[name] 更新为 VariableState",
        "写入后 savePending 置为 true",
        "写入后 updatedBy 标记为 llm",
      ],
    },
    {
      id: "vp-var-write-guards",
      feature: "varWrite — 5 层守卫错误路径",
      description:
        "varWrite 返回 {success: false, error: string} 的 5 种场景：写 system 变量、写 interaction 变量、变量未注册、updateBy 非 llm、类型转换/校验失败（number 范围越界、string enum 不匹配、boolean 非 true/false）。",
      why: "每种守卫阻止一类非法写入，需要独立覆盖",
      depth: "deep",
      scenarios: [
        "写 system 变量 → error: 只读",
        "写 interaction 变量 → error: 系统维护",
        "写未注册变量 → error: 未注册",
        "写 updateBy=manual/system 的变量 → error: 不可写入",
        "number 值超出 [min,max] → error: 含范围提示",
        "string 值不在 enum 列表 → error: 含可选值提示",
        "boolean 值为非 'true'/'false' → error",
      ],
    },
    {
      id: "vp-var-delete",
      feature: "varDelete — LLM 删除/重置变量",
      description:
        "删除变量操作。已注册 card 变量重置为 initial（不真删除），兼容旧数据中未注册但存在于 pool.card 的变量真删除。system/interaction 变量禁止删除。",
      why: "LLM 需要撤销自己的变量操作，但安全边界必须守住",
      depth: "deep",
      scenarios: [
        "已注册 card 变量：重置为 CardVariableDef.initial，updatedBy=system",
        "未注册但存在于 pool.card 的变量（兼容旧数据）：真正 delete",
        "删除后 savePending=true",
      ],
    },
    {
      id: "vp-var-delete-guards",
      feature: "varDelete — 3 类错误路径",
      description:
        "删除操作被拒绝的 3 种场景：system 变量不可删除、interaction 变量不可删除、变量不在 registry 也不在 pool.card 中（不存在）。",
      why: "确保系统关键变量不会被意外删除",
      depth: "deep",
      scenarios: [
        "删除 system 变量 → error: 不可删除",
        "删除 interaction 变量 → error: 系统维护不可删除",
        "删除不存在的变量 → error: 不存在",
      ],
    },

    // ── 系统工具：Interaction ──
    {
      id: "vp-interaction-update",
      feature: "updateInteractionVar — 系统更新互动状态",
      description:
        "仅系统调用。校验变量已注册且 updateBy=system，然后写入 pool.interaction。支持 string→number 自动转换（如 "3"→3），number 变量校验 min/max 范围。",
      why: "系统（如 when-engine）需要更新互动计数器/状态",
      depth: "deep",
      scenarios: [
        "成功写入 interaction 变量：VariableState 格式，updatedBy=system",
        "变量未注册 → error",
        "updateBy 非 system → error",
      ],
    },
    {
      id: "vp-interaction-coercion",
      feature: "updateInteractionVar — 类型强转与范围边界",
      description:
        "当传入 string 但变量定义为 number 时尝试 parseFloat；NaN 则拒绝。number 写入时检查 min 下限和 max 上限，越界拒绝。类型严格不匹配（如传入 boolean 期望 string）拒绝。",
      why: "防止非法值写入导致变量池数据污染",
      depth: "deep",
      scenarios: [
        "string "3" → number 3（自动转换成功）",
        "string "abc" → number（parseFloat NaN → 拒绝）",
        "number 值 < def.min → 拒绝并提示下限",
        "number 值 > def.max → 拒绝并提示上限",
        "类型完全不匹配（无转换路径） → 拒绝",
      ],
    },

    // ── Session 变量 ──
    {
      id: "vp-session-vars",
      feature: "setSessionVars — 注入会话变量",
      description:
        "用传入的 Record 替换 pool.session。通常由 Agent Loop 在每轮开始时注入当前会话上下文。",
      why: "session 变量承载当前对话的上下文信息给 LLM",
      depth: "deep",
      scenarios: [
        "setSessionVars 后 pool.session 完全替换为新值",
        "传入空对象清空 session 变量",
      ],
    },
    {
      id: "vp-session-ts",
      feature: "setSessionStart / getSessionStart — 会话时间戳管理",
      description:
        "记录和读取当前会话开始时间（毫秒时间戳），用于 reset=session 判断。",
      why: "applyResetPolicies 需要 session start 来判断是否为新会话",
      depth: "deep",
      scenarios: [
        "setSessionStart 更新内部 sessionStartMs",
        "getSessionStart 返回当前记录的 timestamp",
        "默认值为 Date.now()（模块加载时）",
      ],
    },

    // ── 持久化：保存 ──
    {
      id: "vp-save-async",
      feature: "saveVariablePoolAsync — 双文件持久化（容错）",
      description:
        "将 pool 持久化到两个文件：vars.json（system only）和 stages/{cardId}.json（card+interaction，合并到现有 stages 文件）。vars.json 写入失败不阻塞 stages 写入。stages 写入失败时设置 savePending=false 防止卡死。",
      why: "变量池状态需持久化以支持重启恢复，容错设计确保单文件失败不丢另一文件",
      depth: "deep",
      scenarios: [
        "savePending=false 或无 currentCardId → 直接 return",
        "正常路径：vars.json 和 stages/{cardId}.json 同时写入",
        "vars.json 写入失败 → 记录 warn 日志，继续尝试 stages 写入",
        "stages 写入失败 → 记录 warn 日志，savePending 置 false 防止重试卡死",
        "stages 文件已存在 → 合并 variables 字段到现有 JSON",
        "stages 文件不存在或 JSON 损坏 → 新建文件",
      ],
    },
    {
      id: "vp-save-strict",
      feature: "saveVariablePoolStrict — 双文件严格持久化",
      description:
        "与 saveVariablePoolAsync 逻辑相同，但 vars.json 写入失败会抛出异常（不 catch），用于需要事务性保证的场景。",
      why: "某些操作（如变量重置）需要确保两端都成功写入",
      depth: "deep",
      scenarios: [
        "正常路径：两文件同时成功写入，savePending=false",
        "vars.json 写入失败 → 抛出异常，调用方处理",
        "stages 文件不存在 → 新建",
      ],
    },
    {
      id: "vp-save-disk",
      feature: "savePoolToDisk / savePoolToDiskStrict — Tauri invoke 包装",
      description:
        "便捷函数，内部调用 saveVariablePoolAsync/saveVariablePoolStrict 并传入基于 Tauri invoke 的 writeFile 实现。零配置开箱即用。",
      why: "业务代码无需关心文件系统实现细节",
      depth: "deep",
      scenarios: [
        "savePoolToDisk → 调用 saveVariablePoolAsync(writeFile)",
        "savePoolToDiskStrict → 调用 saveVariablePoolStrict(writeFile)",
      ],
    },
    {
      id: "vp-save-partial",
      feature: "saveVariablePoolAsync — 双文件部分失败容错",
      description:
        "vars.json 写入失败（try-catch 包裹）不影响 stages 写入继续。stages 写入失败时也 try-catch 包裹，并将 savePending 强制置 false 防止无限重试。读取已有 stages 文件时 JSON 解析失败按新文件处理。",
      why: "磁盘故障或权限问题不应导致变量池陷入永久 savePending 状态",
      depth: "deep",
      scenarios: [
        "vars.json 写入抛异常 → stages 写入仍执行",
        "stages 写入抛异常 → savePending 置 false 防止卡死",
        "stages 文件 JSON 解析失败 → 视为新文件创建",
        "readFile 返回 null（文件不存在）→ 视为新文件",
      ],
    },

    // ── 持久化：读取 ──
    {
      id: "vp-load-card",
      feature: "loadCardVars — 从磁盘读取 card 变量",
      description:
        "读取 stages/{cardId}.json，提取其中的 variables.card 和 variables.interaction。文件不存在/null、schemaVersion<1、JSON 解析失败均返回 null。",
      why: "初始化时恢复之前持久化的变量状态",
      depth: "shallow",
      scenarios: [
        "文件不存在 → 返回 null",
        "文件存在且 variables.schemaVersion >= 1 → 返回 card/interaction 状态",
        "schemaVersion < 1 → 返回 null",
        "JSON 解析失败 → 返回 null 并记录 warn",
      ],
    },
    {
      id: "vp-read-system",
      feature: "readSystemVars — 读取系统变量快照",
      description:
        "读取 vars.json 中的 system 变量（最后一次持久化快照）。文件不存在或 schemaVersion 不兼容返回 null。",
      why: "设置页等场景需要查看系统变量历史快照",
      depth: "shallow",
      scenarios: [
        "vars.json 存在且 schemaVersion >= 1 → 返回 system 变量 Record",
        "文件不存在 → 返回 null",
        "schemaVersion < 1 → 返回 null",
        "任意异常 → 返回 null",
      ],
    },

    // ── 类型校验 ──
    {
      id: "vp-validate-def",
      feature: "validateVarAgainstDef — 持久化值校验",
      description:
        "校验 VariableState 是否符合 CardVariableDef schema。number 检查类型+[min,max] 范围；string 检查类型+enum 成员；boolean 只检查类型。全部通过返回 true，任一失败返回 false。",
      why: "初始化时防止 corrupted 持久化数据进入内存池",
      depth: "shallow",
      scenarios: [
        "number 类型匹配且值在 [min,max] 内 → true",
        "number 值 < min → false",
        "number 值 > max → false",
        "string 类型匹配且值在 enum 中 → true",
        "string 值不在 enum 中 → false",
        "boolean 类型匹配 → true",
        "类型不匹配（如 number vs string）→ false",
      ],
    },
    {
      id: "vp-infer-validate",
      feature: "inferAndValidate — LLM 写入值转换与校验",
      description:
        "将 LLM 传入的 rawValue 字符串按 def.type 转换为强类型值。boolean 只接受 "true"/"false"；number 调用 parseFloat 并校验 [min,max]；string 去除外层引号并校验 enum。不合法返回 undefined。",
      why: "LLM 输出是字符串，需要安全转换为正确类型并校验约束",
      depth: "shallow",
      scenarios: [
        "boolean "true" → true, "false" → false",
        "boolean 其他值 → undefined",
        "number "42" → 42，在 [0,100] 内通过",
        "number 超出 min/max → undefined",
        "number parseFloat NaN → undefined",
        "string 带引号 → 自动去引号",
        "string 不在 enum 列表 → undefined",
        "string 无 enum 约束 → 原样返回",
      ],
    },

    // ── 工具 Handler 构造器 ──
    {
      id: "vp-handlers",
      feature: "工具 Handler 构造器（buildVarReadHandler / buildVarListHandler / buildVarWriteHandler / buildVarDeleteHandler）",
      description:
        "4 个工厂函数返回符合工具执行接口的 async handler。Read/List 返回变量信息，Write/Delete 处理空参数守卫和操作结果映射。所有 handler 统一返回 {success, content, error?} 格式。",
      why: "桥接变量池 API 和工具执行框架的标准接口",
      depth: "shallow",
      scenarios: [
        "buildVarReadHandler: 空 name → error '变量名不能为空'",
        "buildVarReadHandler: 不存在变量 → error",
        "buildVarReadHandler: 存在变量 → success + formatted value",
        "buildVarListHandler: 空池 → '(变量池为空)'",
        "buildVarListHandler: 有变量 → 逐行列出",
        "buildVarWriteHandler: 空 name → error",
        "buildVarWriteHandler: 空 value → error '变量值不能为空'",
        "buildVarWriteHandler: 写入失败 → 透传 varWrite error",
        "buildVarWriteHandler: 写入成功 → success + 新值",
        "buildVarDeleteHandler: 空 name → error",
        "buildVarDeleteHandler: 删除失败 → 透传 varDelete error",
        "buildVarDeleteHandler: 删除成功 → success + 重置后值",
      ],
    },
  ],
  rules: {
    minScenarios: 25,
    minDeepScenarios: 19,
    requireBoundary: true,
    requireErrorPath: true,
  },
}
