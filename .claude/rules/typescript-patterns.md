# TypeScript patterns

Conventions for writing TypeScript in this repo. Enforced by the type-checker and ESLint where automatable; everything else is judgment.

## Named object params (mandatory)

Functions with 1+ parameters use named object params. Already noted in @CLAUDE.md: "named object params for any function with 1+ args."

```typescript
// WRONG
function findRow(id: string, userId: string): Row | null;

// CORRECT
function findRow({ id, userId }: { id: string; userId: string }): Row | null;
```

**Exceptions** (positional params OK):

- Zero-param functions: `getTimestamp()`, `useFoo()`.
- Callbacks / event handlers passed inline: `.map((item) => …)`, `onClick={(e) => …}`.
- Type guards / assertion functions (TS1230 limitation — see below).
- Library / DSL signatures: `eq(table.userId, userId)`, `describe("name", fn)`, `it("name", fn)`.
- **Single-object pass-through wrappers**: a function whose sole param is an already-typed object that's forwarded as-is to another function may skip destructuring at the signature: `function pollPullRequests(args: PollArgs): ResultAsync<...>`. The named-object rule's purpose (one positional slot, fields named at the call site) is already satisfied. Destructure when you'd otherwise spread (`{ ...args, kind: 'X' }` → `runSearch({ db, token, since, kind: 'X' })`) only if it reads more clearly; both forms are acceptable.

## TS1230: type predicates must use positional params

TypeScript error TS1230 means type predicates (`param is Type` / `asserts param is Type`) cannot destructure their input.

```typescript
// WRONG — TS1230 error
function isUser({ value }: { value: unknown }): value is User { /* … */ }

// CORRECT — positional required for type predicates
function isUser(value: unknown): value is User { /* … */ }
```

## No `any` in production code

Use `unknown` plus a type guard, or a discriminated union. Oxlint enforces `typescript/no-explicit-any`; ESLint `no-restricted-syntax` additionally bans `as any`, `<any>`, `as unknown as`, `z.any()`, and `z.coerce.boolean()`. If you find yourself reaching for any of those, the type model probably needs work. See @.claude/rules/code-quality.md for the full linter ownership table.

## Explicit return types on exported functions

Exported functions declare their return type explicitly. Inferred return types are fine for internal helpers but become a maintenance hazard at module boundaries — a refactor inside the function silently changes the public type.

## Exhaustive switch over discriminated unions

`switch` over a discriminated union (e.g. a typed error union's `code` field) must cover every variant. Enforced by ESLint `@typescript-eslint/switch-exhaustiveness-check`. Adding a new variant becomes a compile-fail at every consuming switch, which is the desired pressure — handle the case explicitly or add a `default:` with a `satisfies never` assertion.

## `satisfies` over type assertions

For complex object literals, prefer `satisfies` to `as`:

```typescript
const config = {
  github: { kind: 'polling' },
  slack: { kind: 'polling' },
} satisfies Record<string, IntegrationConfig>;
// — vs —
const config = { /* … */ } as Record<string, IntegrationConfig>; // widens away the literal types
```

`satisfies` validates against the type without widening; type assertions silently widen and hide bugs.

## Inline object types

For single-use parameter or return types, inline the object shape rather than extracting a one-off `interface`. Extract a type alias only when 2+ call sites want it.

## JSDoc on exported functions

Exported functions get a one- or two-line JSDoc summary plus `@param` / `@returns` for each non-obvious parameter. Surface the *why* — leave the *what* to identifiers and types. If a JSDoc just restates the function name, delete it.

## Loose null equality

`x == null` (and `x != null`) is the idiomatic check for "null or undefined" in this repo. Strict equality is fine too; both pass lint.

---

See @CLAUDE.md for project context and the v1.0.0 stack overview.
