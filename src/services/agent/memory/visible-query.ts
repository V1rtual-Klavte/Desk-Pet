import { queryMemory } from "./ipc"
import { resolveCurrentTrustedMemorySource } from "./sources"

/** Only expose user-wide and current-session memories to the model tool. */
export async function queryMemoryVisibleToCurrentTurn(
  query: string,
  sessionId: string,
  trustedUserEventId: string,
  requestedLimit: number,
) {
  if (!sessionId || !trustedUserEventId) throw new Error("记忆查询必须绑定本轮已提交的可信用户输入")
  // 查询仍要绑定已提交的可信用户事件：不能从任意上下文发起记忆读取。
  await resolveCurrentTrustedMemorySource(sessionId, trustedUserEventId)
  const limit = Math.max(1, Math.min(50, Math.floor(requestedLimit)))
  const queries = [
    queryMemory(query, { limit, scope: "user", sessionId }),
    queryMemory(query, { limit, scope: "session", scopeId: sessionId, sessionId }),
  ]
  const results = await Promise.all(queries)
  return [...new Map(results.flat().map(item => [item.id, item])).values()].slice(0, limit)
}
