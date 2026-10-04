import { createApp, nextTick, type App } from "vue"
import ChatPanel from "@/components/ChatPanel.vue"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent"
import { setOverride } from "@/services/config"
import { getActiveSessionId } from "@/services/session"
import { getCachedStages } from "@/services/personality"
import { titlebarLogo } from "@/services/titlebar"
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
    description: "真实Tauri WebView挂载生产ChatPanel：生成时卡面typing只进顶栏（输入框上方状态位不再占用），提交后第一泡先显、下一泡仍隐藏，停止立即全显且顶栏状态释放",
    depth: "deep", suite: "regression", entry: "production", tags: ["boundary", "ui", "timing", "production-entry"] },
  setup: async () => {
    setOverride("ai.humanizer.enabled", true)
    setOverride("ai.memory.enabled", false)
    await initChat()
    installFakeProvider([fakeText("组件验收开始")])
  },
  // 泡文本带每 trial 唯一的随机指纹：同一 App 里保留着上一 trial 的已全显消息时，
  // 按文本精确匹配全容器的可见性判定不会被旧消息撞上（曾在模块/全量跑里误判「第二泡没被藏住」）。
  turns: [{ index: 1, description: "验证生产组件对瞬态揭示状态的消费", userText: "开始组件呈现验收",
    checks: [{ type: "expectProductionChatPanelReveal", run: async () => {
      let release!: () => void
      let started!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const generating = new Promise<void>(resolve => { started = resolve })
      // 第二泡刻意写长：泡间延迟 = 字数 × 220ms（下限 0.4s），十几字给出 ≥2s 的节奏窗口，
      // 满负载宿主上的一次调度打嗝（曾见 >0.4s）不会把它误判成「没有经过泡间节奏」。
      const nonce = Math.random().toString(36).slice(2, 8)
      const firstBubble = `第一泡 ${nonce}`
      const secondBubble = `第二泡 ${nonce} 应当在泡间节奏之后才出现`
      const provider = installFakeProvider([async () => { started(); await gate; return fakeText(`${firstBubble}\n<<SPLIT>>\n${secondBubble}`) }])
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
        // typing 已改为只走顶栏：断言顶栏拿到卡面文案，且输入框上方状态位不再被占用。
        await until(() => titlebarLogo.text.trim() === expectedTyping.trim(), "真实组件未在顶栏显示Card正在输入台词")
        if (container?.querySelector("#ch-tool-status")) throw new Error("typing 不应再占用输入框上方状态位")
        release()
        const result = await sending
        if (result.outcome !== "succeeded") throw new Error(`生产回复失败：${result.failure?.message}`)
        await until(() => visibleBubble(firstBubble), "第一泡未在组件中揭示")
        // 判据：第一泡出现后的窗口内必须存在「第二泡仍隐藏」的时刻（泡间节奏确实在挡它）。
        // 容忍极短的同帧瞬态（消息推送与揭示状态注册是两条异步路径），但不允许一直同显——
        // 若产品退化成提交即全显，这个条件永远不会成立。
        const firstSeenAt = Date.now()
        let secondHeld = !visibleBubble(secondBubble)
        while (!secondHeld && Date.now() - firstSeenAt < 1_500) {
          await new Promise(resolve => setTimeout(resolve, 20))
          secondHeld = !visibleBubble(secondBubble)
        }
        if (!secondHeld) throw new Error("第二泡没有经过泡间节奏")
        await stopActiveRun(getActiveSessionId())
        await nextTick()
        if (!visibleBubble(secondBubble)) throw new Error("停止后已提交的第二泡仍被隐藏")
        try { await until(() => titlebarLogo.text.trim() !== expectedTyping.trim(), "首泡/停止后顶栏typing状态未释放") }
        catch { throw new Error(`首泡/停止后顶栏状态残留：${titlebarLogo.text}`) }
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
