// ==========================================
// Profile 加载器（src/services/profile/loader.ts）—— 轻量 meta 读取与自包含闭包
// ==========================================
//
// 两条容易被重构破坏的契约：
//   · readProfileMeta 是设置页列 Profile 的轻量入口：每次读盘、不进内存缓存
//     （内存里只留激活 Profile），也不接受加载器的缓存代答；
//   · Profile 是自包含闭包：层配置只从 Profile 自身目录读取，不跨 Profile 回退。
// 另覆盖 parallax 逐层默认值（超出默认表时回退最后一层，绝不产出 undefined）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import {
  ensureProfileLoaded,
  getActiveProfile,
  getProfile,
  invalidateAllProfileCaches,
  readProfileMeta,
  switchActiveProfile,
} from "@/services/profile"

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-profile-loader-"))
  setTestDataRoot(root)
})

beforeEach(() => {
  invalidateAllProfileCaches()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeProfileFile(id: string, relativePath: string, content: string): void {
  const target = join(root, "profiles", id, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, "utf8")
}

describe("readProfileMeta 轻量读取", () => {
  it("每次从磁盘读 meta，不写缓存也不吃加载器缓存", async () => {
    writeProfileFile("probe", "profile.yaml", "meta:\n  name: 旧名\n  description: 旧描述\n  version: 2\n")
    expect(await readProfileMeta("probe")).toEqual({ name: "旧名", description: "旧描述", version: 2 })

    // 让加载器先把旧内容装进内存缓存
    await ensureProfileLoaded("probe")
    expect(getProfile("probe")?.meta.name).toBe("旧名")

    writeProfileFile("probe", "profile.yaml", "meta:\n  name: 新名\n")
    expect((await readProfileMeta("probe"))?.name).toBe("新名") // 磁盘是新内容
    expect(getProfile("probe")?.meta.name).toBe("旧名") // 缓存未被 meta 读取改写
  })

  it("meta 缺省时用 id/空描述/版本 1 兜底，读取失败返回 null", async () => {
    writeProfileFile("bare", "profile.yaml", "theme: {}\n")
    expect(await readProfileMeta("bare")).toEqual({ name: "bare", description: "", version: 1 })
    expect(await readProfileMeta("missing")).toBeNull()
  })
})

describe("Profile 自包含", () => {
  it("自包含闭包：没有层配置时就是空层，不借邻居的层", async () => {
    writeProfileFile(
      "neighbor",
      "profile.yaml",
      "meta:\n  name: 邻居\n\ntheme:\n  parallax:\n    layers:\n      - { enabled: true, image: materials/L0/neighbor.png }\n",
    )
    writeProfileFile("lonely", "profile.yaml", "meta:\n  name: 独居\n")

    const loaded = await ensureProfileLoaded("lonely")
    // 跨 Profile 回退会让这里出现邻居那一层——闭包外没有第二来源
    expect(loaded?.theme.parallax.layers).toEqual([])
    expect(loaded?.meta.name).toBe("独居")
  })

  it("profile.yaml 缺失时返回 null，不伪造空 Profile", async () => {
    expect(await ensureProfileLoaded("ghost")).toBeNull()
  })

  it("parallax 逐层默认：索引 2 默认启用并带 L2 素材，超出默认表回退最后一层", async () => {
    writeProfileFile(
      "layers",
      "profile.yaml",
      [
        "theme:",
        "  parallax:",
        "    layers:",
        "      - { sensitivity: 0.9 }",
        "      - {}",
        "      - {}",
        "      - {}",
        "      - {}",
        "      - {}",
        "",
      ].join("\n"),
    )

    const loaded = await ensureProfileLoaded("layers")
    const layers = loaded!.theme.parallax.layers
    expect(layers).toHaveLength(6)
    expect(layers[0]!.sensitivity).toBe(0.9)
    expect(layers[1]!.sensitivity).toBe(0.5)
    expect(layers[1]!.enabled).toBe(false)
    expect(layers[2]).toMatchObject({ enabled: true, image: "materials/L2/body.png" })
    expect(layers[4]!.sensitivity).toBe(1.6)
    // 默认表只有 5 层；索引 5 必须回退最后一层默认，不能是 undefined
    expect(layers[5]!.sensitivity).toBe(1.6)
    expect(layers[5]!.offsetX).toBe(0)
  })
})

describe("switchActiveProfile", () => {
  it("只接受可加载的 Profile，失败时保持原激活项", async () => {
    writeProfileFile("good", "profile.yaml", "meta:\n  name: 好\n")
    expect(await switchActiveProfile("good")).toBe(true)
    expect(getActiveProfile()?.id).toBe("good")

    expect(await switchActiveProfile("ghost")).toBe(false)
    expect(getActiveProfile()?.id).toBe("good")
  })
})
