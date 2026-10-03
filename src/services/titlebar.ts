// ==========================================
// 顶栏 logo —— 窗口运行时状态
//
// 顶栏文案（缺省「配信中」）不随 Profile、不持久化，重启回到缺省。
// 本模块是它唯一的真值点，供联动功能（如联网状态）在运行时改写。
// ==========================================

import { reactive } from "vue"

/** 顶栏 logo 文案与颜色；颜色留空 = 跟随顶栏文字色。 */
export const titlebarLogo = reactive({
  text: "配信中",
  color: "",
})

interface StatusOwner { text: string; priority: number; sequence: number }
const owners = new Map<string, StatusOwner>()
let statusSequence = 0

function renderOwner(): void {
  const owner = [...owners.values()].sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)[0]
  titlebarLogo.text = owner?.text ?? "配信中"
  titlebarLogo.color = ""
}

/** 拥有者优先级：系统过程应高于陪伴状态；释放必须携带相同 owner。 */
export function setTitlebarStatus(owner: string, text: string, priority: number): void {
  owners.set(owner, { text, priority, sequence: ++statusSequence })
  renderOwner()
}

export function releaseTitlebarStatus(owner: string): void {
  if (owners.delete(owner)) renderOwner()
}
