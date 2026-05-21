/**
 * Synthetic persona used by `slopweaver demo`. A generic open-source
 * maintainer juggling a couple of PRs, a Slack inbox with unanswered
 * threads, and the usual mid-week churn. No real names, no real
 * workspaces.
 *
 * Two surfaces live here:
 *
 * 1. {@link DEMO_SNAPSHOT} — the human-readable summary printed by the
 *    bare `slopweaver demo` command. It conveys *shape* — what a
 *    populated `start_session` response looks like — without tokens or
 *    live integrations.
 *
 * 2. {@link DEMO_EVIDENCE} — synthetic `evidence_log` rows seeded by
 *    `slopweaver demo seed` into the demo DB. With these rows present,
 *    the real `start_session` MCP tool serves the demo state instead
 *    of empty cache, so a first-time user can drive the actual flow
 *    against synthetic data.
 *
 * **Capability scope.** Only GitHub and Slack are seeded — those are the
 * two integrations that ship in v1.0. Linear / Gmail / Calendar are
 * intentionally omitted so the demo can't claim a richer product than
 * the binary actually delivers. When those integrations land, add
 * synthetic rows here and bump the snapshot to match.
 */

/**
 * Row shape used to seed `evidence_log`. Mirrors the columns the
 * `@slopweaver/integrations-core` `upsertEvidence` helper accepts so the
 * seeder can call it directly. `occurredAtOffsetMs` is a *negative* offset
 * from "now" so the snapshot stays fresh-looking regardless of when the
 * user runs `demo seed`.
 */
interface DemoEvidence {
  readonly integration: 'github' | 'slack';
  readonly externalId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly citationUrl: string | null;
  readonly payloadJson: string;
  /** Negative ms offset from "now": -3_600_000 → "1 hour ago". */
  readonly occurredAtOffsetMs: number;
}

/**
 * Synthetic evidence seeded into the demo DB. Sized so `start_session`
 * (which caps at 25 items) has more rows than it shows, exercising the
 * ranking heuristic instead of trivially returning every row. ~12
 * GitHub and ~10 Slack rows.
 */
export const DEMO_EVIDENCE: readonly DemoEvidence[] = [
  // ── GitHub ──────────────────────────────────────────────────────────
  {
    integration: 'github',
    externalId: 'demo-pr-418',
    kind: 'review_request',
    title: 'demo/repo#418: backwards-compat shim for v2 config schema',
    body: 'Reviewer asked: is the v2 config schema backwards-compatible? Last comment 6h ago.',
    citationUrl: 'https://example.com/demo/repo/pull/418',
    payloadJson: '{"demo":true,"kind":"review_request","number":418}',
    occurredAtOffsetMs: -6 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-417',
    kind: 'pull_request',
    title: 'demo/repo#417: drop legacy /v1 endpoint',
    body: 'CI green; awaiting one more approval.',
    citationUrl: 'https://example.com/demo/repo/pull/417',
    payloadJson: '{"demo":true,"kind":"pull_request","number":417}',
    occurredAtOffsetMs: -10 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-412',
    kind: 'pull_request',
    title: 'demo/repo#412: auth middleware migration (merged)',
    body: 'Merged 14h ago by a co-maintainer; CI green; no outstanding threads.',
    citationUrl: 'https://example.com/demo/repo/pull/412',
    payloadJson: '{"demo":true,"kind":"pull_request","number":412,"state":"merged"}',
    occurredAtOffsetMs: -14 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-issue-204',
    kind: 'mention',
    title: 'demo/repo#204: @you can you confirm the failure mode?',
    body: 'Mentioned in a triage thread for a flaky CI signal.',
    citationUrl: 'https://example.com/demo/repo/issues/204',
    payloadJson: '{"demo":true,"kind":"mention","number":204}',
    occurredAtOffsetMs: -3 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-issue-201',
    kind: 'issue',
    title: 'demo/repo#201: typo in docs/quickstart.md',
    body: 'Low-priority drive-by from an external contributor.',
    citationUrl: 'https://example.com/demo/repo/issues/201',
    payloadJson: '{"demo":true,"kind":"issue","number":201}',
    occurredAtOffsetMs: -8 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-issue-198',
    kind: 'issue',
    title: 'demo/repo#198: rate-limit retry has off-by-one on the third attempt',
    body: 'Reproducible — has a repro script attached.',
    citationUrl: 'https://example.com/demo/repo/issues/198',
    payloadJson: '{"demo":true,"kind":"issue","number":198}',
    occurredAtOffsetMs: -22 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-issue-195',
    kind: 'issue',
    title: 'demo/repo#195: add Linear integration',
    body: 'Feature request; no PR yet.',
    citationUrl: 'https://example.com/demo/repo/issues/195',
    payloadJson: '{"demo":true,"kind":"issue","number":195}',
    occurredAtOffsetMs: -30 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-411',
    kind: 'pull_request',
    title: 'demo/repo#411: refactor poller registry (merged)',
    body: 'Merged 2 days ago.',
    citationUrl: 'https://example.com/demo/repo/pull/411',
    payloadJson: '{"demo":true,"kind":"pull_request","number":411,"state":"merged"}',
    occurredAtOffsetMs: -2 * 24 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-410',
    kind: 'pull_request',
    title: 'demo/repo#410: bump pnpm to 10.4 (merged)',
    body: 'Merged 2 days ago.',
    citationUrl: 'https://example.com/demo/repo/pull/410',
    payloadJson: '{"demo":true,"kind":"pull_request","number":410,"state":"merged"}',
    occurredAtOffsetMs: -2 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-415',
    kind: 'pull_request',
    title: 'demo/repo#415: extract token-refresh helper',
    body: 'Open; CI yellow (one flake retried).',
    citationUrl: 'https://example.com/demo/repo/pull/415',
    payloadJson: '{"demo":true,"kind":"pull_request","number":415}',
    occurredAtOffsetMs: -18 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-pr-419',
    kind: 'review_request',
    title: 'demo/repo#419: add structured logging wrapper',
    body: 'Review requested; small diff, looks straightforward.',
    citationUrl: 'https://example.com/demo/repo/pull/419',
    payloadJson: '{"demo":true,"kind":"review_request","number":419}',
    occurredAtOffsetMs: -1 * 60 * 60 * 1000,
  },
  {
    integration: 'github',
    externalId: 'demo-issue-205',
    kind: 'issue',
    title: 'demo/repo#205: doctor command should print version',
    body: 'Quick win; one-liner change.',
    citationUrl: 'https://example.com/demo/repo/issues/205',
    payloadJson: '{"demo":true,"kind":"issue","number":205}',
    occurredAtOffsetMs: -45 * 60 * 1000,
  },

  // ── Slack ───────────────────────────────────────────────────────────
  {
    integration: 'slack',
    externalId: 'demo-msg-1700001',
    kind: 'mention',
    title: '#proj-channel: @you can you confirm the staging deploy failure mode?',
    body: 'Direct mention. No replies yet; you are the natural owner.',
    citationUrl: 'https://example.com/demo-workspace/proj-channel/p1700001',
    payloadJson: '{"demo":true,"kind":"mention","channel":"proj-channel"}',
    occurredAtOffsetMs: -4 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700002',
    kind: 'dm',
    title: 'DM from a maintainer: hey, quick question about the v2 schema',
    body: 'Single DM. Last activity 2h ago.',
    citationUrl: 'https://example.com/demo-workspace/dm/p1700002',
    payloadJson: '{"demo":true,"kind":"dm"}',
    occurredAtOffsetMs: -2 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700003',
    kind: 'mention',
    title: '#triage: @you triage these 3 inbound issues',
    body: 'Triage assignment from overnight intake.',
    citationUrl: 'https://example.com/demo-workspace/triage/p1700003',
    payloadJson: '{"demo":true,"kind":"mention","channel":"triage"}',
    occurredAtOffsetMs: -7 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700004',
    kind: 'message',
    title: '#announcements: release-cycle planning is at 17:00 today',
    body: 'Calendar reminder posted to the team channel.',
    citationUrl: 'https://example.com/demo-workspace/announcements/p1700004',
    payloadJson: '{"demo":true,"kind":"message","channel":"announcements"}',
    occurredAtOffsetMs: -5 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700005',
    kind: 'message',
    title: '#standup: thread from yesterday',
    body: 'Catch-up read; no action required.',
    citationUrl: 'https://example.com/demo-workspace/standup/p1700005',
    payloadJson: '{"demo":true,"kind":"message","channel":"standup"}',
    occurredAtOffsetMs: -20 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700006',
    kind: 'mention',
    title: '#proj-channel: @you can you review #418 today?',
    body: 'Cross-reference to the PR review request above.',
    citationUrl: 'https://example.com/demo-workspace/proj-channel/p1700006',
    payloadJson: '{"demo":true,"kind":"mention","channel":"proj-channel"}',
    occurredAtOffsetMs: -90 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700007',
    kind: 'dm',
    title: 'DM: thanks for the merge on #412!',
    body: 'Already-resolved thanks; no reply needed.',
    citationUrl: 'https://example.com/demo-workspace/dm/p1700007',
    payloadJson: '{"demo":true,"kind":"dm"}',
    occurredAtOffsetMs: -12 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700008',
    kind: 'message',
    title: '#proj-channel: anyone else seeing the staging deploy failure?',
    body: 'No mention — but you are the natural owner. Posted 4h ago.',
    citationUrl: 'https://example.com/demo-workspace/proj-channel/p1700008',
    payloadJson: '{"demo":true,"kind":"message","channel":"proj-channel"}',
    occurredAtOffsetMs: -4 * 60 * 60 * 1000 - 30 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700009',
    kind: 'mention',
    title: '#design: @you ping when the release-cycle deck is ready',
    body: 'Soft mention; deadline is the 17:00 meeting.',
    citationUrl: 'https://example.com/demo-workspace/design/p1700009',
    payloadJson: '{"demo":true,"kind":"mention","channel":"design"}',
    occurredAtOffsetMs: -3 * 60 * 60 * 1000,
  },
  {
    integration: 'slack',
    externalId: 'demo-msg-1700010',
    kind: 'message',
    title: '#community: question about the demo command',
    body: 'A community member asked how `slopweaver demo` works. No mention.',
    citationUrl: 'https://example.com/demo-workspace/community/p1700010',
    payloadJson: '{"demo":true,"kind":"message","channel":"community"}',
    occurredAtOffsetMs: -25 * 60 * 60 * 1000,
  },
];

/**
 * Sentinel value written into `integration_state` when the demo DB is
 * seeded. The presence of a row with `integration = '__demo__'` is how
 * the Diagnostics UI / future `doctor` command identifies the demo
 * profile without re-reading the path. Service code should never check
 * this value for branching logic — it's purely a label.
 */
export const DEMO_SENTINEL_INTEGRATION = '__demo__';

export const DEMO_SNAPSHOT = `# start_session (demo)

**Branch:** \`ai-work-console\` · **Console:** initialized · **Identity:** open-source maintainer (synthetic persona)

**Sources polled this run:** Slack ✓ · GitHub ✓

> _Linear, Gmail, and Google Calendar are planned for v1.1+. The demo
> only covers the integrations that actually ship in v1.0._

---

### Reconciliation diff

**[propose-close]** — looks done, propose checking off
- **[#412](https://example.com/demo/repo/pull/412)** — auth middleware migration. PR merged 14 hours ago by a project co-maintainer; CI green; no outstanding review threads. Proposed: tick the matching work-file line.

**[inbox]** — surfaced in deltas, not yet in work file
- **[#418](https://example.com/demo/repo/pull/418)** — review requested by another maintainer 6 hours ago. CI passing. Propose adding to Active asks owed.

### Outstanding next actions (priority order)

1. Reply to a question on **[#418](https://example.com/demo/repo/pull/418)** about backwards-compat for the v2 config schema. Reviewer is waiting; no other blockers.
2. Triage 3 inbound issues mentioned in #triage on Slack — scoped low-priority but worth a one-pass read.

### Slack — needs response

- **#proj-channel** — _can you confirm the staging deploy failure mode?_ Posted 4 hours ago. Direct mention. You're the natural owner.

### GitHub — needs reply / failed CI

- **[#418](https://example.com/demo/repo/pull/418)** — _Is the v2 config schema backwards-compatible?_ from another maintainer. Last comment 6h ago.

### Recently done (last 7d)

3 PRs merged this week (#410, #411, #412).

### Calibration trend

Acceptance rate this week: **78%** (up from 64% last week). Top friction tag: \`friction:wrong-tone\` × 3 (down from 7 last week).

---

**What are we working on this session?**

(Reasonable picks: reply to #418 → triage #triage backlog → confirm the staging deploy thread.)

---

> _This is the \`slopweaver demo\` synthetic persona. A real
> \`start_session\` populates this from your connected MCP servers
> (currently Slack + GitHub; Linear / Gmail / Calendar planned for
> v1.1+). To drive the actual demo state end-to-end:_
>
> 1. \`slopweaver demo seed\` — populate a demo DB with synthetic evidence.
> 2. Add slopweaver to your MCP client in demo mode (or set \`SLOPWEAVER_DEMO=1\` on the slopweaver process).
> 3. Ask your MCP client to call the \`start_session\` tool — it serves real evidence rows from the demo DB.
> 4. \`slopweaver demo exit\` removes the demo DB. To return to real mode, restart the server without \`--demo\` (or unset \`SLOPWEAVER_DEMO\`).
>
> _To leave the demo and connect your own data, run \`claude mcp add slopweaver\` then \`slopweaver init\` for the interactive setup._
`;
