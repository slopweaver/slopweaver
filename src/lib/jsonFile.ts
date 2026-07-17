/**
 * Small JSON-file IO shared by the silver/gold stages: pretty-print writes (with a trailing newline, so
 * files diff cleanly) and a tolerant read that returns undefined rather than throwing on a
 * missing/corrupt file. The effectful edge; pure logic stays in the stage modules.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `value` as pretty JSON, creating parent dirs.
 *
 * @param path the file to write
 * @param value the JSON-serialisable value
 */
export function writeJsonFile({ path, value }: { path: string; value: unknown }): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Read + parse a JSON file, or undefined when it's missing or unparseable.
 *
 * @param path the file to read
 * @returns the parsed value, or undefined
 */
export function readJsonFile({ path }: { path: string }): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
