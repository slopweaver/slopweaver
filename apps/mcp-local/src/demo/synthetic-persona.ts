/**
 * Synthetic persona used by `slopweaver demo`. Generic enough to
 * apply broadly — an open-source maintainer juggling a couple of
 * PRs, a Slack inbox with a few unanswered threads, and a sprint
 * planning meeting later in the day.
 *
 * No real names, no real workspaces. The point is to convey *shape*
 * — what a populated `/session-start` snapshot looks like — without
 * needing tokens or real platform connections.
 */

export const DEMO_SNAPSHOT = `# /session-start (demo)

**Branch:** \`ai-work-console\` · **Console:** initialized · **Identity:** open-source maintainer (synthetic persona)

**Sources polled this run:** Slack ✓ · GitHub ✓ · Linear ✗ (not connected) · Gmail ✓ · Calendar ✓

---

### Reconciliation diff

**[propose-close]** — looks done, propose checking off
- **[#412](https://example.com/repo/pull/412)** — auth middleware migration. PR merged 14 hours ago by a project co-maintainer; CI green; no outstanding review threads. Proposed: tick the matching work-file line.

**[propose-update]** — state shifted but not done
- **[ABC-83](https://example.com/issue/abc-83)** — moved to "In Review" overnight. The work file still says "drafting"; rewrite to "awaiting review".

**[inbox]** — surfaced in deltas, not yet in work file
- **[#418](https://example.com/repo/pull/418)** — review requested by another maintainer 6 hours ago. CI passing. Propose adding to Active asks owed.

### Outstanding next actions (priority order)

1. Reply to a question on **[#418](https://example.com/repo/pull/418)** about backwards-compat for the v2 config schema. Reviewer is waiting; no other blockers.
2. Finish the deploy-runbook draft for the planning meeting at 17:00 local time (calendar item below).
3. Triage 3 inbound issues filed overnight — heuristically scoped as low-priority, but the issue tracker UI shows them as new.

### Slack — needs response

- **#proj-channel** — _Has anyone seen the failure mode on the staging deploy?_ Posted 4 hours ago. No replies yet. You're the natural owner.

### Gmail — needs reply

_(none — single unread is a calendar invite already on the books)_

### GitHub — needs reply / failed CI

- **[#418](https://example.com/repo/pull/418)** — _Is the v2 config schema backwards-compatible?_ from another maintainer. Last comment 6h ago.

### Recently done (last 7d)

3 PRs merged this week (#410, #411, #412). One issue closed (ABC-79).

### Calendar today

- 11:00–11:30 — community-call standup (recurring, accepted)
- 17:00–18:00 — release-cycle planning (needsAction — please respond)

### Calibration trend

Acceptance rate this week: **78%** (up from 64% last week). Top friction tag: \`friction:wrong-tone\` × 3 (down from 7 last week).

---

**What are we working on this session?**

(Reasonable picks: reply to #418 → finish runbook → respond to community-call invite.)

---

> _This is the \`slopweaver demo\` synthetic persona. A real
> \`/session-start\` populates this from your connected MCP servers
> (Slack, GitHub, Linear, Gmail, Google Calendar, etc.). To try it
> with your own data: \`claude mcp add slopweaver\` then \`/session-start\`._
`;
