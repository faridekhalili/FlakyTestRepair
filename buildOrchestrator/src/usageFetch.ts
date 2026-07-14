/**
 * OpenRouter streams token usage on the FINAL data event, which still carries
 * a non-empty `choices` array. The Strands OpenAI model only records usage
 * from an event with EMPTY choices (OpenAI's stream_options convention), so
 * usage silently reads 0. This fetch wrapper re-chunks the SSE stream by line
 * and, when it has seen a usage payload, echoes it as an OpenAI-style
 * empty-choices event right before [DONE] so the SDK's accounting works.
 */
export function createUsageEchoFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) return response

    return new Response(response.body.pipeThrough(usageEchoTransform()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

function usageEchoTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let lastUsage: string | undefined

  const handleLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (line.startsWith('data: ') && line.includes('"usage"')) {
      try {
        const payload = JSON.parse(line.slice(6))
        if (payload?.usage && (payload.choices?.length ?? 0) > 0) {
          lastUsage = JSON.stringify(payload.usage)
        }
      } catch {
        // not JSON (or partial) — pass through untouched
      }
    }
    if (line.trim() === 'data: [DONE]' && lastUsage) {
      const echo = `data: {"id":"usage-echo","object":"chat.completion.chunk","choices":[],"usage":${lastUsage}}\n\n`
      controller.enqueue(encoder.encode(echo))
      lastUsage = undefined
    }
    controller.enqueue(encoder.encode(line + '\n'))
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line, controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(buffer))
    },
  })
}
