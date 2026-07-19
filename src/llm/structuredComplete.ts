/**
 * Structured completion: force the model to emit one JSON object matching a schema, validate it, and
 * retry a bounded number of times. Transport-agnostic — works over any {@link LlmClient}.
 *
 * `tool_use` inputs are the PRIMARY candidates; text blocks are scanned for JSON ONLY when there are no
 * tool_use inputs (so a present-but-invalid tool result still triggers a retry rather than being
 * bypassed by a valid-looking JSON object echoed in prose). The text path is the fallback for the
 * claude-CLI transport, which emulates forced tools by emitting JSON inline.
 */
import { legacyErrorMessages } from "../lib/ingestError.js";
import { err, type Result } from "../lib/result.js";
import { safeLlm } from "../lib/safeBoundary.js";
import { extractJsonObjects } from "./extractJsonObject.js";
import type { JsonObjectSchema, LlmClient, LlmMessage } from "./provider.js";

export interface StructuredRequest {
  readonly system: string;
  readonly user: string;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly schema: JsonObjectSchema;
}

/** The candidate objects to validate, in priority order (tool_use inputs, else JSON found in text). */
function candidateInputs({ message }: { message: LlmMessage }): readonly unknown[] {
  const toolInputs = message.content
    .filter((block) => block.type === "tool_use" && block.input !== undefined)
    .map((block) => block.input);
  if (toolInputs.length > 0) {
    return toolInputs;
  }
  return message.content
    .filter((block) => block.type === "text" && block.text !== undefined && block.text.length > 0)
    .flatMap((block) => extractJsonObjects({ text: block.text! })); // filtered to non-empty text above
}

/**
 * Force + validate a structured response, retrying up to `maxAttempts`.
 *
 * @param request the system/user prompt + the forced tool (name, description, schema)
 * @param client the LLM transport
 * @param validate turns a candidate object into a `Result<T>`
 * @param maxAttempts total attempts before giving up (default 2)
 * @returns the validated value, or an error accumulating every attempt's failures
 */
export async function completeStructured<T>({
  request,
  client,
  validate,
  maxAttempts = 2,
}: {
  request: StructuredRequest;
  client: LlmClient;
  validate: (input: unknown) => Result<T>;
  maxAttempts?: number;
}): Promise<Result<T>> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // The one LLM boundary: a transport throw (spawn/timeout/exit) becomes a typed llm error, surfaced as
    // a fatal string Result (no retry — a broken transport won't self-heal within the attempt budget).
    const completed = await safeLlm({
      execute: () =>
        client.complete({
          messages: [{ content: request.user, role: "user" }],
          system: request.system,
          toolChoice: { name: request.toolName, type: "tool" },
          tools: [{ description: request.toolDescription, inputSchema: request.schema, name: request.toolName }],
        }),
      operation: "claude.complete",
    });
    if (completed.isErr()) {
      return err(legacyErrorMessages({ error: completed.error }));
    }
    const message: LlmMessage = completed.value;
    for (const input of candidateInputs({ message })) {
      const validated = validate(input);
      if (validated.ok) {
        return validated;
      }
      errors.push(...validated.errors);
    }
  }
  return err(errors.length > 0 ? errors : ["no valid structured response after retries"]);
}
