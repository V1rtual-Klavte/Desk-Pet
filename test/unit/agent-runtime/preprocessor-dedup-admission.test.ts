import { describe, expect, it } from "vitest"

import { preProcess } from "@/services/engine/preprocessor"
import type { PreProcessState } from "@/services/engine/preprocessor"

describe("预处理去重准入租约", () => {
  it("同文并发等待首个结算，commit 后才将竞争输入判为重复 [agent-preprocess-dedup-concurrent-commit]", async () => {
    const state: PreProcessState = {}
    const first = await preProcess("同文并发输入", state)
    const concurrentDuplicate = preProcess("同文并发输入", state)

    expect(first.handled, "首条输入未进入待准入状态").toBe(false)
    expect(first.dedupAdmission, "首条输入没有 reservation").toBeDefined()
    first.dedupAdmission?.commit()

    const duplicate = await concurrentDuplicate
    expect(duplicate.handled, "首个 reservation 已 commit，等待中的同文输入没有转为重复").toBe(true)
    expect(duplicate.dedupAdmission, "已准入的同文输入不应申请第二个 reservation").toBeUndefined()
  })

  it("首个同文输入 release 后竞争者继续准入，owner 的晚到 commit 不得复活 [agent-preprocess-dedup-concurrent-release]", async () => {
    const state: PreProcessState = {}
    const first = await preProcess("同文并发输入", state)
    const waiting = preProcess("同文并发输入", state)

    first.dedupAdmission?.release()
    first.dedupAdmission?.commit()

    const retry = await waiting
    expect(retry.handled, "首个 reservation 未准入，等待中的同文输入仍被静默吞掉").toBe(false)
    expect(retry.dedupAdmission, "首个 reservation 释放后竞争者未取得自己的 reservation").toBeDefined()

    const concurrentDuplicate = preProcess("同文并发输入", state)
    retry.dedupAdmission?.commit()
    const duplicate = await concurrentDuplicate
    expect(duplicate.handled, "竞争者成功 commit 后，新同文输入没有被过滤").toBe(true)
  })

  it("旧失败 reservation 的释放不覆盖后来已准入的另一条输入 [agent-preprocess-dedup-release-owner]", async () => {
    const state: PreProcessState = {}
    const earlier = await preProcess("先进入等待的输入", state)
    const later = await preProcess("后来成功准入的输入", state)

    later.dedupAdmission?.commit()
    earlier.dedupAdmission?.release()

    const duplicate = await preProcess("后来成功准入的输入", state)
    expect(duplicate.handled, "较早失败的 reservation 释放覆盖了较晚成功的去重记账").toBe(true)
    expect(duplicate.dedupAdmission, "已准入的重复文本不应再占 reservation").toBeUndefined()
  })

  it("图片输入绕过去重且不阻挡同文不同图，成功准入后再记最近文本 [agent-preprocess-dedup-images]", async () => {
    const state: PreProcessState = {}
    const firstImage = await preProcess("图片说明", state, { imageInput: true })
    const secondImage = await preProcess("图片说明", state, { imageInput: true })

    expect(firstImage.handled, "首张图片被判为重复文本").toBe(false)
    expect(secondImage.handled, "另一张同文图片被 pending 文本拦截").toBe(false)
    firstImage.dedupAdmission?.release()
    secondImage.dedupAdmission?.commit()

    const duplicateText = await preProcess("图片说明", state)
    expect(duplicateText.handled, "图片准入后未写入最近文本去重状态").toBe(true)
  })
})
