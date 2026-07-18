# Testing

Hard rules for **all** tests in this repo. Tests run locally with `yarn test:unit` (vitest), co-located
as `*.test.ts` next to the source. Never defer a test run to CI — run it locally first.

## A unit test tests a PURE function

- **Zero mocks** — `vi.mock`, `vi.spyOn`, `vi.fn` are banned. If a function needs a mock to isolate it,
  it isn't a unit test: **extract the pure logic** and test that, or inject a seam (a plain fake
  function passed in), which is not a mock.
- **Zero I/O** — no network, no real clock. Filesystem is allowed only for a genuine fixture/round-trip
  (e.g. writing to a `mkdtempSync` temp dir and reading it back), never to reach a shared service.
- **Pure core / effectful shell**: put pure logic in testable functions; confine I/O to a thin edge.

## No conditionals — every test must be falsifiable

- **No `if` / `&&` / `?:` / `?.` in an assertion.** A test that can silently pass for any input is
  worse than no test.
- A `&&` / `?.` _inside an inline predicate_ (`.some(x => a && b)`) is fine — that's a callback.
- To access a `T | undefined` you're sure of, use a non-null assertion: `records.find(…)!`.
- For a `Result<T>`, assert `expect(result.ok).toBe(true)` then unwrap the value with the throwing
  `unwrap(result)` combinator — never `expect(result.ok && result.value)`.

## Exact assertions

```typescript
// WRONG — too permissive
expect(result).toBeDefined();
expect(result).toHaveProperty("id");
expect(typeof result.name).toBe("string");

// CORRECT — assert the actual value
expect(result.id).toBe("abc-123");
expect(result.ok).toBe(true);
```

Banned: `.toBeTruthy()`/`.toBeFalsy()`, `toHaveProperty("f")` without a value, `expect(typeof …)`.
Allowed weak assertions (intentional): `toBeDefined()` for an optional field, `toBeGreaterThan(0)` for
a count that varies, `toContain("fragment")` for an error-message fragment.

## Coverage

Cover happy path + boundaries (empty/zero/undefined) + error paths + relevant edge cases. Use
judgment — not every function needs all four.
