/**
 * promptfoo custom provider for the Slopweaver eval harness. It shells the REAL `slopweaver ask --json`
 * so promptfoo drives the exact retrieval + answer path production uses — no mock, no divergent code
 * path (the eval discipline the plan turns on). The parsed answer object (including `retrievedRefs`,
 * the slice ids the scorer needs) becomes the eval output; grading assertions land in the next slice.
 *
 * `callApi` stays positional — promptfoo invokes providers by that fixed framework signature.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AskProviderResponse {
  readonly output: unknown;
  readonly error?: string;
}

export default class SlopweaverAskProvider {
  id(): string {
    return "slopweaver-ask";
  }

  async callApi(prompt: string): Promise<AskProviderResponse> {
    try {
      const stdout = execFileSync("yarn", ["slopweaver", "ask", prompt, "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return { output: JSON.parse(stdout) as unknown };
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error), output: "" };
    }
  }
}
