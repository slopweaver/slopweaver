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
 * Pure `buildPrompt`/`envelopeToMessage`/`claudeCliArgs`/`claudeExitError` are exported + unit-tested; the
 * spawn+watchdog (`spawnClaudeCli`) is the effectful shell (spawn + timers), injected via
 * `claudeCliClientWithDeps({ spawnFn })` so callers substitute a fake `LlmClient` in tests.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { parseJson } from "../lib/jsonParse.js";
import { isRecord } from "../lib/parsers.js";
import { extractJsonObject } from "./extractJsonObject.js";
import type { LlmClient, LlmContentBlock, LlmCreateParams, LlmMessage } from "./provider.js";

const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** The spawn seam — node's `spawn`, injectable so the watchdog shell is swappable in tests. */
export type SpawnFn = typeof spawn;

/** The fixed `claude` CLI args — `-p` (print) + JSON output. No `--model`/token knob, by design (keyless). */
export function claudeCliArgs(): readonly string[] {
  return ["-p", "--output-format", "json"];
}

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

/** The rejection Error for a non-zero exit — includes a trimmed stderr fragment when the CLI wrote one. */
export function claudeExitError({ code, stderr }: { code: number | null; stderr: string }): Error {
  const tail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 500)}` : "";
  return new Error(`claude CLI exited with code ${String(code)}${tail}`);
}

/** Map a `claude -p --output-format json` envelope into an `LlmMessage`. Throws on an error/invalid envelope. */
export function envelopeToMessage({ stdout }: { stdout: string }): LlmMessage {
  const parsed = parseJson({ text: stdout });
  if (parsed.isErr()) {
    throw new Error("claude CLI returned invalid JSON");
  }
  const envelope = parsed.value;
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

/** SIGKILL the child's whole detached process group (already-gone is fine). */
function killTree({ pid }: { pid: number | undefined }): void {
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // process group already gone
    }
  }
}

/** The mutable accumulator for one spawn (stdout/stderr buffers + the settled-once guard). */
interface SpawnState {
  stdout: string;
  stderr: string;
  settled: boolean;
}

/** Wire the child's stdout/stderr/error/close handlers onto the shared state + the finish/kill controls. */
function attachClaudeStreams({
  child,
  state,
  kill,
  finish,
  resolve,
  reject,
}: {
  child: ChildProcessWithoutNullStreams;
  state: SpawnState;
  kill: () => void;
  finish: (fn: () => void) => void;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}): void {
  child.stdout.on("data", (chunk: Buffer) => {
    state.stdout += chunk.toString("utf8");
    if (state.stdout.length > MAX_BUFFER) {
      kill();
      finish(() => {
        reject(new Error("claude CLI output exceeded buffer"));
      });
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    state.stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    finish(() => {
      reject(error);
    });
  });
  child.on("close", (code) => {
    finish(() => {
      onClose({ code, reject, resolve, stderr: state.stderr, stdout: state.stdout });
    });
  });
}

/**
 * The effectful shell: spawn `claude` (detached, so the whole tree is killable), stream stdout/stderr, and
 * resolve the raw stdout — rejecting on spawn error, timeout, buffer overflow, non-zero exit, or empty
 * output. Timer/stream driven, so it is not unit-tested; the pure envelope mapping is tested apart.
 */
async function spawnClaudeCli({
  spawnFn,
  prompt,
  budget,
}: {
  spawnFn: SpawnFn;
  prompt: string;
  budget: number;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn("claude", [...claudeCliArgs()], { detached: true });
    const state: SpawnState = { settled: false, stderr: "", stdout: "" };
    const kill = (): void => {
      killTree({ pid: child.pid });
    };
    const timer = setTimeout(() => {
      kill();
      if (!state.settled) {
        state.settled = true;
        reject(new Error("claude CLI timed out"));
      }
    }, budget);
    const finish = (fn: () => void): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      clearTimeout(timer);
      fn();
    };
    attachClaudeStreams({ child, finish, kill, reject, resolve, state });
    child.stdin.end(prompt);
  });
}

/** The close-handler decision (pure-ish: no I/O, just resolves/rejects the settled promise). */
function onClose({
  code,
  stdout,
  stderr,
  resolve,
  reject,
}: {
  code: number | null;
  stdout: string;
  stderr: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}): void {
  if (code !== 0) {
    reject(claudeExitError({ code, stderr }));
    return;
  }
  if (stdout.trim().length === 0) {
    reject(new Error("claude CLI produced no output"));
    return;
  }
  resolve(stdout);
}

/**
 * A keyless {@link LlmClient} with the spawn seam injected — the shell composes `buildPrompt` →
 * `spawnClaudeCli` → `envelopeToMessage`. `complete` rejects on spawn/timeout/exit/parse errors.
 *
 * @param spawnFn the spawn implementation (production passes node's `spawn`)
 * @param timeoutMs optional per-call budget (defaults to the env/150s resolution)
 * @returns the LLM client
 */
export function claudeCliClientWithDeps({ spawnFn, timeoutMs }: { spawnFn: SpawnFn; timeoutMs?: number }): LlmClient {
  const budget = timeoutMs !== undefined ? resolveTimeout({ timeoutMs }) : resolveTimeout({});
  return {
    async complete(params: LlmCreateParams): Promise<LlmMessage> {
      const stdout = await spawnClaudeCli({ budget, prompt: buildPrompt({ params }), spawnFn });
      return envelopeToMessage({ stdout });
    },
  };
}

/** A keyless {@link LlmClient} backed by the real `claude` CLI (production spawn). */
export function claudeCliClient(opts: { timeoutMs?: number } = {}): LlmClient {
  return claudeCliClientWithDeps({ spawnFn: spawn, ...opts });
}
