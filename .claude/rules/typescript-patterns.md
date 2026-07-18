# TypeScript Patterns

Hard rules for **all** TypeScript in this repo — source, scripts, tests. Applied everywhere, always.

## Universal named-object params (MANDATORY)

Every function with **1 or more parameters** takes a single named object, destructured — never
positional. This holds for single-param functions too.

```typescript
// WRONG
function bronzeFile(source: string, window: ExportWindow): string;
redactText("some text");

// CORRECT
function bronzeFile({ source, window }: { source: string; window: ExportWindow }): string;
redactText({ text: "some text" });
```

**Exceptions** (positional is correct):

- **Zero-param** functions: `slopweaverHome()`, `githubToken()`.
- **Type predicates / assertion functions** (`x is T`, `asserts x`) — TypeScript error TS1230 forbids
  destructuring in a predicate. Keep them positional: `isRecord(value): value is Record<…>`.
- **Inline callbacks** passed to array/promise methods: `.map(x => …)`, `.filter(…)`, `.reduce(…)`.
- **Library-pattern primitives** — small combinators/utilities used pervasively like an external lib:
  the `Result` combinators (`ok`, `err`, `unwrap`, `unwrapErr`) and the `logger`
  methods (`logger.info(msg)`, `.error`, `.warn`, `.debug`, `.out`). Converting these to object params
  would be as noisy as `console.log({ msg })`. Their _internal_ helpers still use object params.
- **Framework/handler signatures** the runtime dictates — the CLI verb contract
  `(argv: readonly string[]) => number | Promise<number>` (e.g. `main`, `runDoctor`, `runRefresh`).

## Other rules

- **No `any`** in any code — use `unknown` + a type guard.
- **Explicit return types** on all exported functions.
- **Inline object types**, not extracted single-use interfaces (extract only when reused/exported as a
  real contract, e.g. `CorpusRecord`).
- **JSDoc `@param` + `@returns`** on all exported functions, alongside the prose "why" comment.
- Prefer `satisfies` over type assertions; loose `== null` / `!= null` for null checks is fine.
