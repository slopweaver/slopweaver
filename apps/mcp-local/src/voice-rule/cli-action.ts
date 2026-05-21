/**
 * CLI adapter for `slopweaver add-voice-rule`. Reads the existing
 * rules file (creating an empty one if missing), runs the pure
 * `appendDirectives` helper, and writes the updated body back.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { appendDirectives } from './append.ts';
import { formatDirective } from './format.ts';
import type { VoiceDirective } from './types.ts';

export type AddVoiceRuleFlags = {
  readonly rulesFile: string;
  readonly forbid: ReadonlyArray<string>;
  readonly replace: ReadonlyArray<string>;
  readonly pattern: ReadonlyArray<string>;
};

export type AddVoiceRuleIo = {
  readonly stdout: { write: (s: string) => void };
  readonly stderr: { write: (s: string) => void };
};

export function parseFlagsToDirectives({
  flags,
}: {
  flags: AddVoiceRuleFlags;
}): { ok: true; directives: ReadonlyArray<VoiceDirective> } | { ok: false; error: string } {
  const directives: VoiceDirective[] = [];
  for (const token of flags.forbid) {
    if (token.length === 0) return { ok: false, error: '--forbid value must not be empty' };
    directives.push({ type: 'forbid', token });
  }
  for (const raw of flags.replace) {
    const idx = raw.indexOf('=>');
    if (idx === -1) {
      return { ok: false, error: `--replace value must be "<from> => <to>"; got "${raw}"` };
    }
    const from = raw.slice(0, idx).trim();
    const to = raw.slice(idx + 2).trim();
    if (from.length === 0) {
      return { ok: false, error: `--replace value must have a non-empty left side; got "${raw}"` };
    }
    directives.push({ type: 'replace', from, to });
  }
  for (const regex of flags.pattern) {
    if (regex.length === 0) return { ok: false, error: '--pattern value must not be empty' };
    directives.push({ type: 'pattern', regex });
  }
  return { ok: true, directives };
}

type ReadRulesResult = { kind: 'ok'; body: string } | { kind: 'error'; message: string };

async function readRulesFile({ path }: { path: string }): Promise<ReadRulesResult> {
  try {
    const body = await readFile(path, 'utf-8');
    return { kind: 'ok', body };
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
      return { kind: 'ok', body: '' };
    }
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function runAddVoiceRule({
  flags,
  io,
}: {
  flags: AddVoiceRuleFlags;
  io: AddVoiceRuleIo;
}): Promise<number> {
  const parsed = parseFlagsToDirectives({ flags });
  if (!parsed.ok) {
    io.stderr.write(`add-voice-rule: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.directives.length === 0) {
    io.stderr.write('add-voice-rule: at least one --forbid, --replace, or --pattern is required.\n');
    return 2;
  }

  const readResult = await readRulesFile({ path: flags.rulesFile });
  if (readResult.kind === 'error') {
    io.stderr.write(`add-voice-rule: failed to read ${flags.rulesFile}: ${readResult.message}\n`);
    return 1;
  }

  const result = appendDirectives({ body: readResult.body, directives: parsed.directives });

  if (result.added.length === 0) {
    io.stderr.write(
      `add-voice-rule: all ${result.skipped.length} directive(s) already present in ${flags.rulesFile}; nothing to do.\n`,
    );
    return 0;
  }

  try {
    await writeFile(flags.rulesFile, result.updated, 'utf-8');
  } catch (e) {
    io.stderr.write(
      `add-voice-rule: failed to write ${flags.rulesFile}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  const summary = result.added.map((d) => formatDirective({ directive: d })).join(', ');
  io.stdout.write(
    `add-voice-rule: ok added=${result.added.length} skipped=${result.skipped.length} path=${flags.rulesFile} new=${JSON.stringify(summary)}\n`,
  );
  return 0;
}
