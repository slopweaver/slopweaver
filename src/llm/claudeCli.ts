/**
 * The keyless LLM transport: shell the `claude` CLI so gold synthesis runs on the user's existing
 * Claude Code auth — no API key, no SDK. This is what makes the pipeline zero-key.
 *
 * The prompt goes via stdin (a corpus prompt easily exceeds `ARG_MAX`) and the child runs `detached` in
 * its own process group so a timeout can SIGKILL the whole tree. There are no model/token knobs — the
 * CLI uses the session's current model, by design. Forced-tool structured output is emulated in prose
 * (a "respond with ONLY this JSON" instruction), and the JSON is recovered into a synthetic `tool_use`
 * block so the structured-completion validate/retry loop doesn't care how the JSON arrived.
 *
 * Pure `buildPrompt`/`envelopeToMessage` are exported for unit tests; `claudeCliClient` is the effectful
 * shell (spawn + watchdog) and is not unit-tested — callers inject a fake `LlmClient` instead.
 */
import { spawn } from "node:child_process";

import { isRecord } from "../lib/parsers.js";
import { extractJsonObject } from "./extractJsonObject.js";
import type { LlmClient, LlmContentBlock, LlmCreateParams, LlmMessage } from "./provider.js";

const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Flatten a request into a single prompt string; a forced tool becomes a "respond with ONLY this JSON" tail. */
export function buildPrompt({ params }: { params: LlmCreateParams }): string {
  const parts = [params.system, ...params.messages.map((m) => m.content)];
  const tool = params.tools?.[0];
  if (tool !== undefined) {
    parts.push(
      `Respond with ONLY a JSON object that conforms to this JSON schema:\n${JSON.stringify(tool.inputSchema)}`,
    );
  }
  return parts.filter((p) => p.length > 0).join("\n\n");
}

/** Map a `claude -p --output-format json` envelope into an `LlmMessage`. Throws on an error envelope. */
export function envelopeToMessage({ stdout }: { stdout: string }): LlmMessage {
  const envelope: unknown = JSON.parse(stdout);
  if (!isRecord(envelope) || envelope["is_error"] === true || typeof envelope["result"] !== "string") {
    throw new Error("claude CLI returned an error envelope");
  }
  const result = envelope["result"];
  const content: LlmContentBlock[] = [];
  const recovered = extractJsonObject({ text: result });
  if (recovered !== undefined) {
    content.push({ input: recovered, type: "tool_use" });
  }
  content.push({ text: result, type: "text" });
  return { content };
}

function resolveTimeout({ timeoutMs }: { timeoutMs?: number }): number {
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const fromEnv = Number(process.env["SLOPWEAVER_CLAUDE_CLI_TIMEOUT_MS"]);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/** A keyless {@link LlmClient} backed by the `claude` CLI. `complete` rejects on spawn/timeout/exit/parse errors. */
export function claudeCliClient({ timeoutMs }: { timeoutMs?: number } = {}): LlmClient {
  const budget = timeoutMs !== undefined ? resolveTimeout({ timeoutMs }) : resolveTimeout({});
  return {
    async complete(params: LlmCreateParams): Promise<LlmMessage> {
      return new Promise<LlmMessage>((resolve, reject) => {
        const child = spawn("claude", ["-p", "--output-format", "json"], { detached: true });
        let stdout = "";
        let settled = false;
        const kill = (): void => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // process group already gone
            }
          }
        };
        const timer = setTimeout(() => {
          kill();
          if (!settled) {
            settled = true;
            reject(new Error("claude CLI timed out"));
          }
        }, budget);
        const finish = (fn: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          fn();
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > MAX_BUFFER) {
            kill();
            finish(() => {
              reject(new Error("claude CLI output exceeded buffer"));
            });
          }
        });
        child.on("error", (error) => {
          finish(() => {
            reject(error);
          });
        });
        child.on("close", (code) => {
          if (code !== 0) {
            finish(() => {
              reject(new Error(`claude CLI exited with code ${String(code)}`));
            });
            return;
          }
          if (stdout.trim().length === 0) {
            finish(() => {
              reject(new Error("claude CLI produced no output"));
            });
            return;
          }
          finish(() => {
            try {
              resolve(envelopeToMessage({ stdout }));
            } catch (error: unknown) {
              reject(error instanceof Error ? error : new Error("claude CLI: bad envelope"));
            }
          });
        });
        child.stdin.end(buildPrompt({ params }));
      });
    },
  };
}
