/**
 * The Claude Code LLM seam. v0.1 runs the model exactly ONE way: the keyless `claudeCli`, which shells
 * `claude` on the user's existing Claude Code session — no API key, no SDK, no headless-with-a-key path,
 * by design. There is deliberately no model or max-tokens knob: the `claude` CLI uses the session's
 * current model, so exposing those would be dead configuration.
 *
 * The `LlmClient` interface exists ONLY so tests can inject a fake in place of spawning `claude` — it is
 * a test seam, not a pluggable-provider abstraction.
 */

/** A JSON-Schema object description for a forced tool's input. */
export interface JsonObjectSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

/** A tool the model is forced to call, whose `input` becomes the structured output. */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
}

export interface LlmCreateParams {
  readonly system: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly tools?: readonly LlmTool[];
  /** Force the model to call this exact tool (structured output). */
  readonly toolChoice?: { readonly type: "tool"; readonly name: string };
}

/** One block of a model response: a `tool_use` (with `input`) or a `text` block. */
export interface LlmContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
}

export interface LlmMessage {
  readonly content: readonly LlmContentBlock[];
}

/** The Claude Code transport. `complete` throws on a transport error (spawn, timeout, non-zero exit). */
export interface LlmClient {
  complete(params: LlmCreateParams): Promise<LlmMessage>;
}
