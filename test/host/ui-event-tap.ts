// L4 事件观测 tap：记录 Node → Native UI 发布成功的 HostEventMap 载荷，且原样转发真实 IPC。
// 它不是事件总线：测试不能向它发布，也不能靠 tap 改变 Native 消费结果。

import { getUiEventPublisher, setUiEventPublisher } from "@/services/host"
import type { HostEventMap, NodeUiEventName } from "@/services/host"

interface PublishedEvent {
  event: NodeUiEventName
  payload: unknown
  publishedAt: number
}

const published: PublishedEvent[] = []
let installed = false

/** 只由真实 Native L4 bootstrap 调用一次。后续任何事件仍先送真实 HostBridge。 */
export function installUiEventTap(): void {
  if (installed) return
  installed = true
  const downstream = getUiEventPublisher()
  setUiEventPublisher({
    publish: async (event, payload) => {
      await downstream.publish(event, payload)
      published.push({ event, payload, publishedAt: performance.now() })
    },
  })
}

/** Scene 隔离点调用；记录只属于一个场景/试次。 */
export function resetUiEventTap(): void {
  published.length = 0
}

/** 读取真实 Node publisher 已发出的载荷；不生成、不重放事件。 */
export function publishedUiEvents<K extends NodeUiEventName>(event: K): HostEventMap[K][] {
  return published
    .filter((entry) => entry.event === event)
    .map((entry) => entry.payload as HostEventMap[K])
}

/** 读取发布时间戳，供 L4 首增量延迟计量沿用原事件到达口径。 */
export function publishedUiEventRecords<K extends NodeUiEventName>(event: K): { payload: HostEventMap[K]; publishedAt: number }[] {
  return published
    .filter((entry) => entry.event === event)
    .map((entry) => ({ payload: entry.payload as HostEventMap[K], publishedAt: entry.publishedAt }))
}
