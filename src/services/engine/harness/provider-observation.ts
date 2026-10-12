/**
 * Best-effort provider response metadata observation. The wrapped body is a
 * byte-for-byte pass-through; parsing failures never become provider failures.
 */

const MAX_OBSERVATION_BUFFER_CHARS = 16 * 1024

export interface ProviderObservationSnapshot {
  responseModel?: string
  /** True only when a recognized raw cache-usage field was present in a response. */
  cacheUsageReported?: boolean
  idleTimeout?: true
}

export interface ProviderObservation {
  fetch(fetchImpl: typeof fetch, options?: {
    signal?: AbortSignal
    idleTimeoutMs?: number
    onIdleTimeout?: (error: Error) => void
  }): typeof fetch
  snapshot(): ProviderObservationSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasReadCacheCount(usage: Record<string, unknown>, key: string): boolean {
  const value = usage[key]
  return hasOwn(usage, key) && typeof value === "number" && Number.isFinite(value) && value >= 0
}

function reportsCacheUsage(payload: Record<string, unknown>): boolean {
  // These are raw read/hit counts only. Write/miss counts do not prove that
  // cached input was read, and null or malformed values remain unknown.
  const usages = [payload.usage]
  for (const containerKey of ["message", "response"]) {
    const container = payload[containerKey]
    if (isRecord(container)) usages.push(container.usage)
  }
  for (const value of usages) {
    if (!isRecord(value)) continue
    const nestedDetails = [value.prompt_tokens_details, value.input_tokens_details].filter(isRecord)
    if (nestedDetails.some(details => hasReadCacheCount(details, "cached_tokens"))) return true
    if (hasReadCacheCount(value, "prompt_cache_hit_tokens")
      || hasReadCacheCount(value, "cache_read_input_tokens")) return true
  }
  return false
}

/** Extract only the allowlisted identity/cache-presence metadata. */
function createAccumulator(): {
  observe(payload: unknown): void
  snapshot(): ProviderObservationSnapshot
} {
  let responseModel: string | undefined
  let conflictingModels = false
  let cacheUsageReported = false

  return {
    observe(payload) {
      if (!isRecord(payload)) return
      const identities = [payload, payload.message, payload.response]
        .filter(isRecord)
        .map(record => record.model)
        .filter((model): model is string => typeof model === "string" && model.length > 0)
      for (const model of identities) {
        if (responseModel === undefined) responseModel = model
        else if (responseModel !== model) conflictingModels = true
      }
      if (reportsCacheUsage(payload)) cacheUsageReported = true
    },
    snapshot() {
      return {
        ...(!conflictingModels && responseModel ? { responseModel } : {}),
        ...(cacheUsageReported ? { cacheUsageReported: true } : {}),
      }
    },
  }
}

function parseJsonSafely(text: string, accumulator: ReturnType<typeof createAccumulator>): void {
  try {
    accumulator.observe(JSON.parse(text) as unknown)
  } catch {
    // Observation is advisory. Provider parsing and its gateway trace own failures.
  }
}

function observeResponse(
  response: Response,
  accumulator: ReturnType<typeof createAccumulator>,
  options: { signal?: AbortSignal; idleTimeoutMs?: number; onIdleTimeout?: (error: Error) => void },
): Response {
  const body = response.body
  // Opaque responses have status 0, which ResponseInit cannot represent. Leave
  // those untouched rather than changing a successful fetch into an observer error.
  if (!body || response.status === 0) return response

  const isJson = (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let lineBuffer = ""
  let lineOverflow = false
  let eventData: string[] = []
  let eventChars = 0
  let eventOverflow = false
  let jsonBuffer = ""
  let jsonOverflow = false
  let settled = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
  const cleanup = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    options.signal?.removeEventListener("abort", onAbort)
  }
  const cancelReader = (reason?: unknown) => {
    void reader.cancel(reason).catch(() => { /* The response stream owns transport failure reporting. */ })
  }
  const failBody = (reason: unknown) => {
    if (settled) return
    settled = true
    cleanup()
    cancelReader(reason)
    try { bodyController?.error(reason) } catch { /* A concurrent stream close already owns the terminal state. */ }
  }
  const onAbort = () => failBody(options.signal?.reason ?? new Error("Provider 请求已取消"))
  const armIdleTimer = () => {
    if (options.idleTimeoutMs === undefined || settled) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      const error = new Error(`Provider 响应流连续 ${options.idleTimeoutMs}ms 无数据`)
      error.name = "ProviderIdleTimeoutError"
      options.onIdleTimeout?.(error)
      failBody(error)
    }, options.idleTimeoutMs)
  }

  const parseEvent = () => {
    if (!eventOverflow && eventData.length) parseJsonSafely(eventData.join("\n"), accumulator)
    eventData = []
    eventChars = 0
    eventOverflow = false
  }

  const consumeLine = (line: string) => {
    if (line === "") {
      parseEvent()
      return
    }
    if (line.startsWith(":")) return
    if (!line.startsWith("data:")) return
    const data = line.slice(5).replace(/^ /u, "")
    if (eventChars + data.length + 1 > MAX_OBSERVATION_BUFFER_CHARS) {
      eventOverflow = true
      eventData = []
      return
    }
    eventData.push(data)
    eventChars += data.length + 1
  }

  const consumeSseText = (text: string) => {
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf("\n", start)
      const end = newline < 0 ? text.length : newline
      const segmentLength = end - start
      if (!lineOverflow) {
        if (lineBuffer.length + segmentLength > MAX_OBSERVATION_BUFFER_CHARS) {
          lineBuffer = ""
          lineOverflow = true
        } else {
          lineBuffer += text.slice(start, end)
        }
      }
      if (newline < 0) return
      if (!lineOverflow) consumeLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer)
      lineBuffer = ""
      lineOverflow = false
      start = newline + 1
    }
  }

  const observeChunk = (bytes: Uint8Array) => {
    try {
      const text = decoder.decode(bytes, { stream: true })
      if (isJson) {
        if (!jsonOverflow) {
          if (jsonBuffer.length + text.length > MAX_OBSERVATION_BUFFER_CHARS) {
            jsonBuffer = ""
            jsonOverflow = true
          } else {
            jsonBuffer += text
          }
        }
      } else {
        consumeSseText(text)
      }
    } catch {
      // Never let metadata decoding interfere with bytes delivered to Pi.
    }
  }

  const finishObservation = () => {
    try {
      const tail = decoder.decode()
      if (isJson) {
        if (!jsonOverflow) jsonBuffer += tail
        if (!jsonOverflow && jsonBuffer.length <= MAX_OBSERVATION_BUFFER_CHARS) parseJsonSafely(jsonBuffer, accumulator)
      } else {
        consumeSseText(tail)
        if (lineBuffer && !lineOverflow) consumeLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer)
        parseEvent()
      }
    } catch {
      // The original fetch/body path remains authoritative; gateway tracing owns failures.
    }
  }

  const observedBody = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller },
    async pull(controller) {
      armIdleTimer()
      try {
        const next = await reader.read()
        if (settled) return
        if (next.done) {
          finishObservation()
          settled = true
          cleanup()
          controller.close()
          return
        }
        if (next.value) {
          // Any transport bytes count as progress, including SSE comments and blank frames.
          // Model output can run for a long time as long as the provider keeps the stream moving.
          armIdleTimer()
          observeChunk(next.value)
          // Preserve the provider's original bytes and chunk boundaries.
          controller.enqueue(next.value)
        }
      } catch (error) {
        failBody(error)
      }
    },
    cancel(reason) {
      settled = true
      cleanup()
      return reader.cancel(reason)
    },
  })
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  const wrapped = new Response(observedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // ResponseInit omits these fetch metadata fields; retain them for consumers.
  Object.defineProperties(wrapped, {
    url: { configurable: true, value: response.url },
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
  })
  return wrapped
}

export function createProviderObservation(): ProviderObservation {
  const accumulator = createAccumulator()
  let idleTimeout = false
  return {
    fetch(fetchImpl, options = {}) {
      return ((input: RequestInfo | URL, init?: RequestInit) => {
        if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("Provider 请求已取消"))
        return fetchImpl(input, init).then(response => observeResponse(response, accumulator, {
          ...options,
          onIdleTimeout(error) {
            idleTimeout = true
            options.onIdleTimeout?.(error)
          },
        }))
      }) as typeof fetch
    },
    snapshot() {
      return { ...accumulator.snapshot(), ...(idleTimeout ? { idleTimeout: true as const } : {}) }
    },
  }
}
