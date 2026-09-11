/**
 * Parse an OpenAI-compatible `chat.completions` SSE stream (what the `pr`
 * Hermes profile's api_server returns — see
 * apps/platform/src/app/api/tokens/[tokenId]/chat/route.ts, which pipes that
 * response straight through) into a sequence of text deltas.
 *
 * Each SSE event is a `data: <json>` line (events are separated by a blank
 * line); the stream ends with a literal `data: [DONE]` event. Content lives
 * at `choices[0].delta.content` on each chunk, same shape as OpenAI's API.
 */
export async function* streamChatCompletion(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Skip a malformed/partial event rather than aborting the whole stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
