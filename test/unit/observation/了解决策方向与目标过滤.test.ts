// ==========================================
// 了解决策方向 —— 广度铺面 / 深度钻已知方面
//
// 断言点：了解层为空只能广度；depth 只保留已知方面之下的目标；
// 路径按边界匹配（/Users 不覆盖 /UsersX）；文件锚点取其父目录。
// 纯函数测试，不启动模型、不读写数据库。
// ==========================================

import { describe, expect, it } from "vitest"

import { decisionSystemPrompt, depthAnchorRoots, filterTargetsForMode, nextDepthStrategy, nextObservationMode } from "@/services/observation/decide"

const target = (path: string) => ({ path, kind: "dir" as const, why: "" })

describe("了解决策方向", () => {
  it("了解层为空时只能广度 [observation-mode-empty-breadth]", () => {
    // 2026-10-21 用户口径：一开始是空的就广度。
    expect(nextObservationMode(false, 0.1)).toBe("breadth")
    expect(nextObservationMode(false, 0.9)).toBe("breadth")
    expect(nextObservationMode(true, 0.4)).toBe("breadth")
    expect(nextObservationMode(true, 0.6)).toBe("depth")
  })

  it("depth 只保留已知方面之下的目标 [observation-depth-filter]", () => {
    const anchors = ["/Users/v1rtual/WEB"]
    const kept = filterTargetsForMode([
      target("/Users/v1rtual/WEB/Desk-Pet/src"),
      target("/Applications"),
      target("/Users/v1rtual/WEBX"),
      target("/Users/v1rtual/WEB"),
    ], "depth", anchors)
    expect(kept.map(item => item.path)).toEqual(["/Users/v1rtual/WEB/Desk-Pet/src"])
    // breadth 不限制方向：整台电脑都能铺。
    expect(filterTargetsForMode([target("/Applications")], "breadth", anchors)).toHaveLength(1)
    // 没有锚点时不做过滤（防御路径；调度器此时会强制广度）。
    expect(filterTargetsForMode([target("/Applications")], "depth", [])).toHaveLength(1)
    // depth/new 自己另找方面深入：不受锚点限制（2026-10-21 用户口径）。
    expect(filterTargetsForMode([target("/Applications")], "depth", anchors, "new")).toHaveLength(1)
    expect(filterTargetsForMode([target("/Applications")], "depth", anchors, "existing")).toHaveLength(0)
  })

  it("depth 两种走法各半 [observation-depth-strategy]", () => {
    expect(nextDepthStrategy(false, 0.9)).toBe("new")
    expect(nextDepthStrategy(true, 0.2)).toBe("existing")
    expect(nextDepthStrategy(true, 0.8)).toBe("new")
  })

  it("决策提示按方向拆开，只带当前方向的指令 [observation-decision-prompt-variants]", () => {
    const breadth = decisionSystemPrompt("breadth", "new")
    expect(breadth).toContain("这一批走广度")
    expect(breadth).toContain("以截图与窗口为准")
    expect(breadth).not.toContain("depthAnchors 里挑")
    // 公共边界仍在每个变体里。
    expect(breadth).toContain("整机只读")
    expect(breadth).toContain("凭据")

    const existing = decisionSystemPrompt("depth", "existing")
    expect(existing).toContain("这一批走深度（existing）")
    expect(existing).toContain("depthAnchors 里挑")
    expect(existing).not.toContain("这一批走广度")

    const fresh = decisionSystemPrompt("depth", "new")
    expect(fresh).toContain("这一批走深度（new）")
    expect(fresh).toContain("不受 depthAnchors 限制")
    expect(fresh).not.toContain("这一批走深度（existing）")
  })

  it("文件观察锚定父目录并去重 [observation-depth-anchors]", () => {
    expect(depthAnchorRoots([
      { kind: "dir", targets: ["/Users/v1rtual/WEB", "/Users/v1rtual/WEB"] },
      { kind: "file", targets: ["/Users/v1rtual/WEB/README.md"] },
      { kind: "screenshot" },
    ])).toEqual(["/Users/v1rtual/WEB"])
  })
})
