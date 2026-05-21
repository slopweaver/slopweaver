/**
 * CLI adapter for `slopweaver annotate-image`. Reads the spec from the
 * filesystem (or from an inline `--spec-json` string), runs the pure
 * `parseAnnotationSpec` validator, then drives the sharp-based
 * compositor.
 */

import { readFile } from 'node:fs/promises';
import { annotateImage } from './annotate.ts';
import { parseAnnotationSpecFromJson } from './parse.ts';

export type AnnotateImageFlags = {
  readonly input: string;
  readonly output: string;
  readonly specFile?: string;
  readonly specJson?: string;
};

export type AnnotateImageIo = {
  readonly stdout: { write: (s: string) => void };
  readonly stderr: { write: (s: string) => void };
};

export async function runAnnotateImage({
  flags,
  io,
}: {
  flags: AnnotateImageFlags;
  io: AnnotateImageIo;
}): Promise<number> {
  let specText: string;
  if (flags.specJson !== undefined && flags.specJson.length > 0) {
    specText = flags.specJson;
  } else if (flags.specFile !== undefined && flags.specFile.length > 0) {
    try {
      specText = await readFile(flags.specFile, 'utf-8');
    } catch (e) {
      io.stderr.write(
        `annotate-image: failed to read --spec-file ${flags.specFile}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  } else {
    io.stderr.write('annotate-image: one of --spec-json or --spec-file is required.\n');
    return 2;
  }

  const specResult = parseAnnotationSpecFromJson(specText);
  if (specResult.isErr()) {
    io.stderr.write(`annotate-image: ${specResult.error.message}\n`);
    return 2;
  }

  const result = await annotateImage({
    inputPath: flags.input,
    outputPath: flags.output,
    spec: specResult.value,
  });
  if (result.isErr()) {
    io.stderr.write(`annotate-image: ${result.error.code} ${result.error.message}\n`);
    return 1;
  }
  io.stdout.write(
    `annotate-image: ok input=${flags.input} output=${flags.output} dims=${result.value.width}x${result.value.height}\n`,
  );
  return 0;
}
