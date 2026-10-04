import { createApp, nextTick, type App } from "vue"
import ChatPanel from "@/components/ChatPanel.vue"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent"
import { setOverride } from "@/services/config"
import { getActiveSessionId } from "@/services/session"
import { getCachedStages } from "@/services/personality"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import type { SceneDef } from "../../types"

let panel: App | undefined
let container: HTMLElement | undefined

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function visibleBubble(text: string): boolean {
  const part = [...(container?.querySelectorAll(".cm.assistant .ct") ?? [])].find(node => node.textContent === text)
  const row = part?.closest<HTMLElement>(".cm")
  return Boolean(row && window.getComputedStyle(row).display !== "none" && row.getBoundingClientRect().height > 0)
}

export const 真实组件分泡呈现: SceneDef = {
  meta: { caseId: "humanizer-real-component-reveal", module: "humanizer", contractId: "hz-04",
    description: "真实Tauri WebView挂载生产ChatPanel：生成显示Card typing，提交后第一泡先显、下一泡仍隐藏，停止立即全显且状态消失",
    depth: "deep", suite: "regression", entry: "production", tags: ["boundary", "ui", "timing", "production-entry"] },
  setup: async () => {
    setOverride("ai.humanizer.enabled", true)
    setOverride("ai.memory.enabled", false)
    await initChat()
    installFakeProvider([fakeText("组件验收开始")])
  },
  turns: [{ index: 1, description: "验证生产组件对瞬态揭示状态的消费", userText: "开始组件呈现验收",
    checks: [{ type: "expectProductionChatPanelReveal", run: async () => {
      let release!: () => void
      let started!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const generating = new Promise<void>(resolve => { started = resolve })
      const provider = installFakeProvider([async () => { started(); await gate; return fakeText("第一泡\n<<SPLIT>>\n第二泡") }])
      container = document.createElement("div")
      container.style.cssText = "width:300px;height:400px;position:relative;display:flex;flex-direction:column"
      document.body.append(container)
      panel = createApp(ChatPanel)
      panel.mount(container)
      try {
        await nextTick()
        const sending = sendMessage("这是一条没有工具的普通聊天")
        await generating
        const expectedTyping = getCachedStages()?.stages.typing
        if (!expectedTyping) throw new Error("测试Card没有typing台词资产")
        await until(() => container?.querySelector("#ch-tool-status")?.textContent?.trim() === expectedTyping.trim(), "真实组件未显示Card正在输入台词")
        release()
        const result = await sending
        if (result.outcome !== "succeeded") throw new Error(`生产回复失败：${result.failure?.message}`)
        await until(() => visibleBubble("第一泡"), "第一泡未在组件中揭示")
        if (visibleBubble("第二泡")) throw new Error("第二泡没有经过泡间节奏")
        await stopActiveRun(getActiveSessionId())
        await nextTick()
        if (!visibleBubble("第二泡")) throw new Error("停止后已提交的第二泡仍被隐藏")
        try { await until(() => !container?.querySelector("#ch-tool-status"), "首泡/停止后typing状态仍显示") }
        catch { throw new Error(`首泡/停止后状态残留：${container?.querySelector("#ch-tool-status")?.outerHTML}`) }
        const text = container.textContent ?? ""
        if (text.includes("<<SPLIT>>") || text.includes("<<SILENT>>")) throw new Error("组件显示了协议标记")
      } finally {
        release()
        panel.unmount()
        panel = undefined
        container.remove()
        container = undefined
        provider.restore()
      }
    } }] }],
}
export default 真实组件分泡呈现
