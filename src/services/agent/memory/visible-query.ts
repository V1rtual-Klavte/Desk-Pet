import { queryMemory } from "./ipc"
import { resolveCurrentTrustedMemorySource } from "./sources"

/** Only expose user-wide, frozen current-Card, and current-session memories to the model tool. */
export async function queryMemoryVisibleToCurrentTurn(
  query: string,
  sessionId: string,
  trustedUserEventId: string,
  requestedLimit: number,
) {
  if (!sessionId || !trustedUserEventId) throw new Error("记忆查询必须绑定本轮已提交的可信用户输入")
  const source = await resolveCurrentTrustedMemorySource(sessionId, trustedUserEventId)
  const limit = Math.max(1, Math.min(50, Math.floor(requestedLimit)))
  const queries = [
    queryMemory(query, { limit, scope: "user", sessionId }),
    queryMemory(query, { limit, scope: "session", scopeId: sessionId, sessionId }),
    ...(source.cardId ? [queryMemory(query, { limit, scope: "card", scopeId: source.cardId, sessionId })] : []),
  ]
  const results = await Promise.all(queries)
  return [...new Map(results.flat().map(item => [item.id, item])).values()].slice(0, limit)
}
