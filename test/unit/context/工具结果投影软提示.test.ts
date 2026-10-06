// ==========================================
// 工具结果投影的循环软提示 —— 三个投影档位（未缩短 / 缩短 / 清空）都不丢
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 1）：病理检测的软提示经
// `context/tool-output.ts` 的 `annotateToolResultText` / `projectToolResultText` 唯一出口
// 附到工具结果正文，**三个投影档位都不丢** —— 循环病态的提示不该被预算缓解措施挤掉。
//
// 期望值口径：档位形态按契约手写（占位标记与软提示哨兵都是独立见证，不 import 实现常量）；
// 每个档位同时钉住「出现且只出现一次」。把对应分支里的软提示拼接删掉（或改成只在某一档拼），
// 对应用例必须变红。
//
// 归属 L2（不是 L3）：`@/services/context/tool-output` 是零 I/O 纯函数叶子、不在 L2 禁入清单；
// 不需要真 loop / 真落盘，按 test/README 的选层顺序直接落 L2。

import { describe, expect, it } from "vitest"

import { projectToolResultText } from "@/services/context/tool-output"

const WINDOW = 131_072
const ADDRESS = "entry-2f7c91ab4e55"
const READ_TOOL = "read_session_event"
/** 软提示哨兵：内容与文案无关（它是入参），哨兵化让「出现次数」判据不受文案变动干扰。 */
const NOTICE = "[循环软提示哨兵]"
/** 缩短档的正文：远超单条预算（中文 ≈1 token/字符），保证必然走级 1 的切片分支。 */
const LONG_TEXT = "缩短档正文".repeat(20_000)

/** 哨兵出现次数：删掉任一分支的拼接 → 0；逐块重复拼 → 类同判据在多 text 块处另行钉住。 */
function noticeCount(text: string): number {
  return text.split(NOTICE).length - 1
}

describe("工具结果投影的循环软提示", () => {
  it("未缩短档（级 1、未超预算）：正文 + 地址尾行 + 软提示尾行，提示只出现一次 [tool-output-notice-unshortened]", () => {
    const out = projectToolResultText("短结果正文", ADDRESS, WINDOW, READ_TOOL, 1, NOTICE)
    expect(out, "未缩短档正文被改动").toContain("短结果正文")
    expect(out, "未缩短档丢了地址尾行").toContain(ADDRESS)
    expect(noticeCount(out), "未缩短档的软提示必须出现且只出现一次").toBe(1)

    // 负对照：省略软提示入参时同样的正文不得带哨兵（哨兵不是凭空出现）。
    const without = projectToolResultText("短结果正文", ADDRESS, WINDOW, READ_TOOL, 1)
    expect(noticeCount(without), "省略软提示时不应出现提示").toBe(0)
  })

  it("缩短档（级 1、超预算）：头尾切片 + 缩短标记 + 软提示尾行，提示只出现一次 [tool-output-notice-shortened]", () => {
    const out = projectToolResultText(LONG_TEXT, ADDRESS, WINDOW, READ_TOOL, 1, NOTICE)
    expect(out, "缩短档丢了缩短标记").toContain("上下文缩短")
    expect(out, "缩短档丢了回读地址").toContain(ADDRESS)
    expect(out.length, "缩短档没有真的缩短正文").toBeLessThan(LONG_TEXT.length)
    expect(noticeCount(out), "缩短档的软提示必须出现且只出现一次").toBe(1)

    const without = projectToolResultText(LONG_TEXT, ADDRESS, WINDOW, READ_TOOL, 1)
    expect(noticeCount(without), "省略软提示时不应出现提示").toBe(0)
  })

  it("清空档（级 2、有地址）：正文只剩清空标记 + 地址 + 软提示尾行，提示只出现一次 [tool-output-notice-cleared]", () => {
    const out = projectToolResultText("清空前的正文", ADDRESS, WINDOW, READ_TOOL, 2, NOTICE)
    expect(out, "清空档丢了清空标记").toContain("上下文清空")
    expect(out, "清空档丢了回读地址").toContain(ADDRESS)
    expect(out, "清空档仍带着原始正文").not.toContain("清空前的正文")
    expect(noticeCount(out), "清空档的软提示必须出现且只出现一次").toBe(1)

    const without = projectToolResultText("清空前的正文", ADDRESS, WINDOW, READ_TOOL, 2)
    expect(noticeCount(without), "省略软提示时不应出现提示").toBe(0)
  })
})
