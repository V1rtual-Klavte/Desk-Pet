/**
 * 了解摘要的质量判定（零依赖叶子）。
 *
 * 了解层的用途是**了解这个人**；「截图是窄条」「这个目录里没有项目文件」这类
 * 纯否定结论不携带任何关于用户的信息。2026-10-21 实机：三条这种观察把了解层
 * 顶到 `ready`，还经 dreaming 沉淀成了长期记忆。这里统一判定，供存储层与
 * 沉淀口共用同一份口径。
 */
const NO_INFORMATION = /(?:无有效内容|没有有效内容|无可用信息|没有可用信息|无法读取|不可读取|看不出|无项目文件|空目录)/u

/** 摘要是否携带关于用户的信息：非空，且不是「什么也没看到」的结论。 */
export function isInformativeSummary(summary: string): boolean {
  return summary.trim().length > 0 && !NO_INFORMATION.test(summary)
}
