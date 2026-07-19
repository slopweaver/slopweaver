/**
 * The pure core shared by the query verbs (`ask`, `facts`) — question validation, the exact stdout line
 * rendering, snippet normalisation, and the exit-code decisions — extracted from the old ~90-line `runAsk`
 * / ~80-line `runFacts` so each concern is unit-tested apart from the corpus/embedder/LLM IO the shells own.
 * Nothing here touches the network, the model, the clock, or the disk.
 */
import type { CorpusRecord } from "../../../corpus/types.js";
import type { Answer } from "../../../retrieval/answerFromSlice.js";
import { citeToken } from "../../../retrieval/citeToken.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK } from "../../exitCodes.js";

/** The default snippet cap for `facts` output (chars). */
export const FACTS_SNIPPET_CHARS = 200;

/**
 * Validate an `ask` question — a blank/whitespace-only question is the usage error `ask needs a question`.
 * Pure — returns the error line, or `undefined` when valid.
 *
 * @param question the raw question text
 * @returns the error line, or `undefined`
 */
export function validateAskQuestion({ question }: { question: string }): string | undefined {
  return question.trim().length === 0 ? "ask needs a question" : undefined;
}

/**
 * Validate a `facts` question. Pure — the `facts` sibling of {@link validateAskQuestion}.
 *
 * @param question the raw question text
 * @returns the error line, or `undefined`
 */
export function validateFactsQuestion({ question }: { question: string }): string | undefined {
  return question.trim().length === 0 ? "facts needs a question" : undefined;
}

/**
 * The exact stdout lines the pretty `ask` answer prints: the tl;dr, then details (blank-line separated) when
 * present, then a `citations:` block when there are any. Pure — the shell just emits them in order.
 *
 * @param answer the grounded answer
 * @returns the stdout lines
 */
export function renderAskTextLines({ answer }: { answer: Answer }): readonly string[] {
  const lines: string[] = [answer.tldr];
  if (answer.details !== undefined && answer.details.length > 0) {
    lines.push("", answer.details);
  }
  if (answer.citations.length > 0) {
    lines.push("", "citations:");
    for (const citation of answer.citations) {
      lines.push(`  ${citation}`);
    }
  }
  return lines;
}

/**
 * The ask exit code: a real answer exits OK; only a query that retrieved NOTHING is "expected empty" (a
 * substantive answer with no surviving citations is still a real answer). Pure.
 *
 * @param retrieved how many records the query retrieved
 * @returns the exit code
 */
export function askExitCode({ retrieved }: { retrieved: number }): number {
  return retrieved > 0 ? EXIT_OK : EXIT_EXPECTED_EMPTY;
}

/**
 * Normalise a `facts` snippet: collapse all whitespace runs to single spaces, then cap the length. Pure.
 *
 * @param text the record text
 * @param maxChars the length cap
 * @returns the normalised snippet
 */
export function normaliseFactSnippet({ text, maxChars }: { text: string; maxChars: number }): string {
  return text.replace(/\s+/g, " ").slice(0, maxChars);
}

/**
 * The exact stdout lines `facts` prints for a retrieved slice: `no matching records` when empty, else one
 * block per record (`[source] (token) url`, optional title, snippet, blank separator). Pure.
 *
 * @param slice the ranked records
 * @returns the stdout lines
 */
export function renderFactsLines({ slice }: { slice: readonly CorpusRecord[] }): readonly string[] {
  if (slice.length === 0) {
    return ["no matching records"];
  }
  const lines: string[] = [];
  for (const record of slice) {
    lines.push(`[${record.source}] (${citeToken({ record })}) ${record.url}`);
    if (record.title !== undefined && record.title.length > 0) {
      lines.push(`  ${record.title}`);
    }
    lines.push(`  ${normaliseFactSnippet({ maxChars: FACTS_SNIPPET_CHARS, text: record.text })}`, "");
  }
  return lines;
}

/**
 * The facts exit code — retrieval-only always exits OK (empty and non-empty alike; corpus-missing is a
 * separate path in the shell). Pure.
 *
 * @returns the exit code
 */
export function factsExitCode(): number {
  return EXIT_OK;
}
