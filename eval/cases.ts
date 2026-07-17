/**
 * Bridges the typed, frozen golden cases into promptfoo's test shape: each labelled case becomes one
 * test whose deterministic grounding assertion scores it against its own expected set. promptfoo loads
 * this via `tests: file://./cases.ts`; the default export (an array of test cases) is the framework
 * contract. Labels live in GOLDEN_CASES (single source of truth); the assertion resolves them by question.
 */
import { GOLDEN_CASES } from "../src/eval/scorer.js";

export default GOLDEN_CASES.map((golden) => ({
  assert: [{ type: "javascript", value: "file://./groundingAssertion.ts" }],
  description: golden.question,
  vars: { question: golden.question },
}));
