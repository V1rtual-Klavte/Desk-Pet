// ==========================================
// 截图工具 details 契约 —— 形状判定与工具名常量
// ==========================================
//
// 被测语义（两条）：
// ① `SCREENSHOT_TOOL_NAME` 是模型调用的函数名、也是运行内核 afterTool 的判定名，
//    两侧共用这一处定义（改名必须红在这里，而不是让宿主静默不再收集截图路径）；
// ② `readScreenshotToolDetails` 只放行完整形状（非空路径字符串 + 布尔 showToUser），
//    且 showToUser=false 的合法结果也原样返回 —— 过滤是调用方的事，契约层不做业务取舍。
//
// 归属 L2：screenshot-details 是零依赖叶子（自身无 import），本文件只测它的纯逻辑，
// 不触达工具系统 / 会话 / 引擎（不 import 工具 barrel，也不加载 Tauri IPC）。
import { describe, expect, it } from "vitest"
import { readScreenshotToolDetails, SCREENSHOT_TOOL_NAME } from "@/services/tool/local/screenshot-details"

describe("截图工具 details 契约", () => {
  it("工具名与宿主判定同源 [screenshot-details-tool-name]", () => {
    expect(SCREENSHOT_TOOL_NAME, "工具名是模型调用与宿主收集的共同锚点").toBe("screenshot")
  })

  it("只放行完整形状，合法 false 不被契约层过滤 [screenshot-details-shape]", () => {
    // 完整形状：返回冻结的两字段（多余键不透传，避免宿主把任意 details 当成截图）。
    expect(readScreenshotToolDetails({ screenshotPath: "/data/screenshots/1.png", showToUser: true }))
      .toEqual({ screenshotPath: "/data/screenshots/1.png", showToUser: true })
    expect(readScreenshotToolDetails({ screenshotPath: "/data/screenshots/1.png", showToUser: false }))
      .toEqual({ screenshotPath: "/data/screenshots/1.png", showToUser: false })

    // 缺字段 / 类型不符 / 空路径 / 非对象：一律 undefined，调用方按「没有截图」处理。
    expect(readScreenshotToolDetails({ screenshotPath: "/x.png" }), "缺 showToUser 不该放行").toBeUndefined()
    expect(readScreenshotToolDetails({ showToUser: true }), "缺路径不该放行").toBeUndefined()
    expect(readScreenshotToolDetails({ screenshotPath: "", showToUser: true }), "空路径不该放行").toBeUndefined()
    expect(readScreenshotToolDetails({ screenshotPath: 7, showToUser: true }), "非字符串路径不该放行").toBeUndefined()
    expect(readScreenshotToolDetails({ screenshotPath: "/x.png", showToUser: "true" }), "字符串布尔不该放行").toBeUndefined()
    expect(readScreenshotToolDetails(undefined)).toBeUndefined()
    expect(readScreenshotToolDetails(null)).toBeUndefined()
    expect(readScreenshotToolDetails("screenshot")).toBeUndefined()
  })
})
