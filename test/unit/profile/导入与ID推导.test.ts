// ==========================================
// Profile 导入 / 新建 / 重命名 / ID 推导（src/services/profile/io.ts）
// ==========================================
//
// 导入入口有两条（旧网页壳给 File，原生设置窗给同形状对象），io 只认
// `{ name, arrayBuffer() }` 结构类型 —— 这里用普通对象 + 真实 JSZip 包证明这条契约，
// 并断言「缺 profile.yaml 拒绝、写盘失败返回失败结果」两条失败路径不会留下半份导入。
//
// 新建/重命名同样走真实落盘：ID 从现有目录表取最小未占用序号，显示名单独可改；
// 断言一律回读磁盘文件（而不是相信返回值）。新建还会预置五层空壳与
// `materials/L0`…`L4` 目录 —— 编辑器按 profile.yaml 的层列表建层、按目录插入素材，
// 缺任何一半都会让新 Profile 在图层编辑器里「无层可编辑、无处插入素材」。
//
// 落盘走 Node 测试宿主（profile_file_write → 临时数据根），文件回读才是真证据。

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import { load as loadYaml } from "js-yaml"

import { setTestDataRoot } from "../../host/node-ipc"
import { NodeHostBridge } from "../../host/node-host-bridge"
import { HostCommandError, getHostBridge, setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { initPaths } from "@/services/paths"
import { createProfile, discoverAllProfiles, importProfileZip, nextCreateId, profileDisplayPath, renameProfile } from "@/services/profile"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-profile-io-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  setHostBridge(new NodeHostBridge())
  rmSync(root, { recursive: true, force: true })
})

async function buildZip(entries: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(entries)) zip.file(path, content)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("importProfileZip", () => {
  it("接受 { name, arrayBuffer } 结构并取字节一次，按文件名推导 ID 后真实落盘", async () => {
    const arrayBuffer = vi.fn(async () =>
      buildZip({
        "profile.yaml": "meta:\n  name: 导入探针\n",
        "materials/L0/bg.png": new Uint8Array([1, 2, 3]),
      }),
    )

    const result = await importProfileZip({ name: "MyProfile.zip", arrayBuffer })

    expect(result.ok).toBe(true)
    expect(result.profileId).toBe("myprofile")
    expect(arrayBuffer).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(root, "profiles", "myprofile", "profile.yaml"), "utf8")).toContain("导入探针")
    expect([...readFileSync(join(root, "profiles", "myprofile", "materials", "L0", "bg.png"))]).toEqual([1, 2, 3])
  })

  it("缺少 profile.yaml 的压缩包被拒绝，且一个文件都不落", async () => {
    const result = await importProfileZip({
      name: "plain.zip",
      arrayBuffer: async () => buildZip({ "readme.txt": "no profile here" }),
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("profile.yaml")
    expect(existsSync(join(root, "profiles", "plain"))).toBe(false)
  })

  it("无法从文件名推导合法 ID 时拒绝导入", async () => {
    const result = await importProfileZip({
      name: ".zip",
      arrayBuffer: async () => buildZip({ "profile.yaml": "meta: {}" }),
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Profile ID")
  })

  it("同路径条目（大小写口径）如实报告覆盖，macOS 隐藏文件被跳过", async () => {
    const result = await importProfileZip({
      name: "Collide.zip",
      arrayBuffer: async () =>
        buildZip({
          "profile.yaml": "meta: {}",
          "A.yaml": "upper",
          "a.yaml": "lower",
          "__MACOSX/._profile.yaml": "resource fork junk",
          "assets/._x.png": "resource fork junk",
        }),
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain("已导入 3 个文件")
    expect(result.message).toContain("1 个条目被同路径")
    expect(result.detail).toContain("A.yaml ← a.yaml")
  })

  it("写入失败返回失败结果而不是抛出，不留下成功假象", async () => {
    const failing = {
      request: vi.fn(async () => {
        throw new HostCommandError("IO", "磁盘不可写")
      }),
      subscribe: () => () => {},
      readBlob: async () => new Uint8Array(),
      releaseBlob: async () => {},
    } as unknown as HostBridge
    setHostBridge(failing)
    try {
      const result = await importProfileZip({
        name: "Broken.zip",
        arrayBuffer: async () => buildZip({ "profile.yaml": "meta: {}" }),
      })
      expect(result).toMatchObject({ ok: false, message: "磁盘不可写" })
    } finally {
      setHostBridge(new NodeHostBridge())
    }
  })
})

describe("新建空 Profile", () => {
  it("写五层空壳 profile.yaml + 五层素材目录，ID 与默认名取最小未占用序号", async () => {
    const result = await createProfile(["profile1", "sugar-pink"])

    expect(result.ok).toBe(true)
    expect(result.newId).toBe("profile2")
    const dir = join(root, "profiles", "profile2")
    // 回读磁盘：五层空壳在 profile.yaml 里 —— 编辑器按层列表建层，缺 layers 时
    // 整窗没有层可编辑（也就无处插入素材）。
    const profileYaml = loadYaml(readFileSync(join(dir, "profile.yaml"), "utf8")) as any
    expect(profileYaml.meta.name).toBe("新 Profile 2")
    const layers = profileYaml?.theme?.parallax?.layers
    expect(layers).toHaveLength(5)
    expect(layers.map((layer: any) => layer.image)).toEqual(["", "", "", "", ""])
    expect(layers.map((layer: any) => layer.sensitivity)).toEqual([0.2, 0.5, 0.8, 1.2, 1.6])
    expect(
      layers.every(
        (layer: any) =>
          layer.enabled === true &&
          layer.locked === false &&
          layer.scale === 1 &&
          layer.offsetX === 0 &&
          layer.offsetY === 0,
      ),
    ).toBe(true)
    // 五层素材目录已建好、可直接插入图片（真正空目录，不放占位文件）。
    for (let i = 0; i < 5; i++) {
      expect(statSync(join(dir, "materials", `L${i}`)).isDirectory(), `materials/L${i} 应已存在`).toBe(true)
    }
  })

  it("新建后可直接往五层目录写图并读回", async () => {
    const result = await createProfile(await discoverAllProfiles())
    const id = result.newId!
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await getHostBridge().request("profile_file_write", {
      profileId: id,
      relativePath: "materials/L2/body.png",
      content: bytes,
    })
    expect([...readFileSync(join(root, "profiles", id, "materials", "L2", "body.png"))]).toEqual([...bytes])
  })

  it("已有 profile1/profile2 时新建落在 profile3（磁盘实际文件为准）", async () => {
    const result = await createProfile(["profile1", "profile2"])
    expect(result.newId).toBe("profile3")
    expect(existsSync(join(root, "profiles", "profile3", "profile.yaml"))).toBe(true)
  })
})

describe("重命名", () => {
  it("只改显示名：meta.name 落盘（两侧空白裁掉），id 目录不动", async () => {
    const created = await createProfile(await discoverAllProfiles())
    const id = created.newId!
    const result = await renameProfile(id, "  小雨  ")

    expect(result.ok).toBe(true)
    const yaml = readFileSync(join(root, "profiles", id, "profile.yaml"), "utf8")
    expect(yaml).toContain("name: 小雨")
    expect(yaml).not.toContain("新 Profile")
    // id 不变：目录仍按原 id 在原处，重命名不搬文件。
    expect(readFileSync(join(root, "profiles", id, "profile.yaml"), "utf8")).toContain("小雨")
  })

  it("纯空白名字被拒绝，磁盘文件一个字节都不动", async () => {
    const created = await createProfile(await discoverAllProfiles())
    const id = created.newId!
    const path = join(root, "profiles", id, "profile.yaml")
    const before = readFileSync(path, "utf8")

    const result = await renameProfile(id, "   ")

    expect(result.ok).toBe(false)
    expect(result.message).toContain("不能为空")
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("与其它 Profile 重名被拒绝（裁剪空白后精确比对），磁盘不动", async () => {
    const a = await createProfile(await discoverAllProfiles())
    const b = await createProfile(await discoverAllProfiles())
    const pathB = join(root, "profiles", b.newId!, "profile.yaml")
    const before = readFileSync(pathB, "utf8")

    const result = await renameProfile(b.newId!, `  ${a.newId!.replace("profile", "新 Profile ")}  `)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("已有同名")
    expect(readFileSync(pathB, "utf8")).toBe(before)
  })
})

describe("新建默认名避让", () => {
  it("默认名被其它 Profile 占用时按（2）后缀避让", async () => {
    const result = await createProfile(["profile1", "profile2"], ["新 Profile 3"])

    expect(result.ok).toBe(true)
    expect(result.newId).toBe("profile3")
    expect(readFileSync(join(root, "profiles", "profile3", "profile.yaml"), "utf8")).toContain("新 Profile 3（2）")
  })
})

describe("ID 与路径文本", () => {
  it("nextCreateId 取最小未占用新建名，不跳号", () => {
    expect(nextCreateId([])).toBe("profile1")
    expect(nextCreateId(["profile2"])).toBe("profile1")
    expect(nextCreateId(["profile1", "profile2", "profile3"])).toBe("profile4")
    expect(nextCreateId(["profile1", "profile3"])).toBe("profile2")
  })

  it("profileDisplayPath 固定为数据根下 profiles/<id>", () => {
    expect(profileDisplayPath("probe")).toBe(join(root, "profiles", "probe"))
  })
})
