---
description: Capture an in-line voice correction (e.g. "don't use delve, use check") and append it as a directive to the user's voice-rules markdown via `slopweaver add-voice-rule`. The next draft will pick up the new rule.
argument-hint: <natural-language correction>
---

This skill is the upstream capture for the existing `apply_voice_rules` MCP tool. When the user corrects me mid-chat, I should:

1. Infer the directive(s) implied by the correction.
2. Show them to the user as a JSON-style preview.
3. After the user confirms (or immediately, if the correction was unambiguous), run `slopweaver add-voice-rule` to append them to the rules file.

The rules file lives at `$SLOPWEAVER_VOICE_RULES_PATH` if set, otherwise the user supplies `--rules-file`. A common per-user choice is `.claude/personal/rules/communication-style.md` (gitignored).

## Directive grammar

Three directive kinds the voice-rules parser understands:

- **`forbid: <token>`** — the literal token is banned. The post-processor flags it.
- **`replace: <from> => <to>`** — `<from>` gets rewritten to `<to>`. Whitespace either side of `=>` is trimmed.
- **`pattern: <regex>`** — anywhere the JS regex matches, flag the draft.

Pick the smallest unit that captures the correction.

- "Don't use delve" → `forbid: delve`
- "Use check instead of delve" → `replace: delve => check` (covers the forbid implicitly)
- "Stop with the negative parallelism" → `pattern: \bit's not [^,]+, it's\b` (a pattern that catches the trope)
- "No exclamation marks" → `replace: ! => .` (or `forbid: !` if any context counts)

## Steps

### 1. Parse the correction into directive(s)

Read `$ARGUMENTS` (the natural-language correction the user wrote). Decide one or more directive kinds. If there's any ambiguity, ask the user before running the binary.

### 2. Show the user a preview

Print the inferred directives in a single block:

```
proposed:
  - forbid: delve
  - replace: utilize => use
```

If the user pushes back, refine. If the correction was a clear lift-and-shift ("just add forbid: X"), skip the preview and go straight to step 3.

### 3. Apply

Run:

```bash
slopweaver add-voice-rule \
  [--rules-file "<path>"] \
  [--forbid "<token>" ...] \
  [--replace "<from> => <to>" ...] \
  [--pattern "<regex>" ...]
```

Repeatable flags allow several directives per call. The binary:

- Creates the file if missing.
- Appends inside an existing `## Hard rules` section, or creates one.
- Skips any directive that's already present byte-for-byte (idempotent).
- Reports `added=N skipped=M` so the model can confirm what landed.

### 4. Report

After the binary returns 0, surface a one-liner:

```
✓ added 2 voice rules (1 skipped as duplicate). next draft uses them.
```

If the binary returns 2, the corrective directives were malformed. Show the stderr line, ask the user to clarify.

## Why this is the upstream capture half

`apply_voice_rules` (the existing MCP tool) is the downstream lint. The user runs it on a draft before sending. But the rules file has to be populated somehow. This skill is the populate side: every time the user corrects me, the correction lands as a permanent directive.

Over time, the voice rules accumulate. The next draft starts cleaner. The pair is the actual feedback loop.

## Notes

- Don't edit `rules/communication-style.md` directly via the `Edit` tool when this skill is what the user wants. The skill is the audit trail; direct edits make duplicate detection drift.
- A directive that's structurally valid but semantically wrong (e.g. forbid: a common preposition the user didn't mean to ban) will block legitimate drafts until removed. Bias toward `replace` over `forbid`.
- Pattern regexes are JS-flavored. Escape backslashes when passing through the shell: `'pattern: \bnotably\b'` becomes `--pattern "\\bnotably\\b"` on the command line.
