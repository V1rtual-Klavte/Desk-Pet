// ==========================================
// 顶栏 logo —— 窗口运行时状态
//
// 顶栏文案（缺省「就绪」）不随 Profile、不持久化，重启回到缺省。
// 本模块是它唯一的真值点，供联动功能（如联网状态）在运行时改写。
// ==========================================

import { reactive } from "vue"

/**
 * 缺省文案：**没有 owner（没有任何状态在写）时的中性空闲态**。
 * 与 Rust 宿主 `crates/native-host/src/ui/titlebar.rs::DEFAULT_TEXT` 同字面量
 * （宿主未收到推送时也显示这一文案）。**不得使用「配信中」这类在线/在播口吻的
 * 文案**：无 owner 是「空闲」，不是「在线」，缺省谎报在线是用户报告的缺陷。
 */
const DEFAULT_TEXT = "就绪"

/** 顶栏 logo 文案与颜色；颜色留空 = 跟随顶栏文字色。 */
export const titlebarLogo = reactive({
  text: DEFAULT_TEXT,
  color: "",
})

interface StatusOwner { text: string; priority: number; sequence: number }
const owners = new Map<string, StatusOwner>()
let statusSequence = 0

/**
 * 渲染通知：`renderOwner` 把仲裁结果落定后调用（A2）。
 *
 * 只是「最终文本」的渲染出口 —— 原生 UI 的推送侧（`@/services/native-ui/titlebar-status`）
 * 挂在这里把文本推给宿主；**仲裁本身（owner/优先级/序列）不受它影响**：
 * 通知在文本写入 `titlebarLogo` 之后同步发出，监听者的失败不影响渲染结果。
 * 未注册 = 静默跳过（Node 领域初始化早期、测试进程里都可能没有消费者）。
 */
let renderListener: ((text: string) => void) | null = null

/** 注册渲染监听（传 null 注销；单监听者，注册晚于渲染时由注册方自己补推当前值）。 */
export function setTitlebarRenderListener(next: ((text: string) => void) | null): void {
  renderListener = next
}

function renderOwner(): void {
  const owner = [...owners.values()].sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)[0]
  titlebarLogo.text = owner?.text ?? DEFAULT_TEXT
  titlebarLogo.color = ""
  renderListener?.(titlebarLogo.text)
}

/** 拥有者优先级：系统过程应高于陪伴状态；释放必须携带相同 owner。 */
export function setTitlebarStatus(owner: string, text: string, priority: number): void {
  owners.set(owner, { text, priority, sequence: ++statusSequence })
  renderOwner()
}

export function releaseTitlebarStatus(owner: string): void {
  if (owners.delete(owner)) renderOwner()
}
