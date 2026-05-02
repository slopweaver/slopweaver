# Security Policy

SlopWeaver uses **coordinated disclosure** to protect users. If a security vulnerability is announced publicly before a fix exists, every installed user is exposed to attackers reading the announcement. Reporting privately first means a patch can ship before attackers learn about the bug. Standard practice across OSS — not an attempt to bury anything.

I'm one person ([@lachiejames](https://github.com/lachiejames)) maintaining this. The timelines below are best-effort, not contractual SLAs.

---

## How to report a vulnerability

**Preferred**: use GitHub's private vulnerability reporting.

> Go to <https://github.com/slopweaver/slopweaver/security/advisories/new> and click "Report a vulnerability." This opens a private discussion between you and me, generates a CVE if confirmed, and gives you visible credit.

**Alternative**: email **admin@slopweaver.ai** if you can't or don't want to use GitHub's tool.

Either way, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- Your name / handle (if you'd like credit) and any disclosure preferences

I aim to acknowledge receipt within **5 business days**.

---

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | ✅ (when released) |
| 0.x.y   | ❌ (pre-release)   |

Pre-1.0 versions are alpha builds and may contain known issues; do not run them in production.

---

## Disclosure timeline

Targets, in good faith:

- **5 business days** to acknowledge receipt
- **30 days** to confirm or deny the vulnerability
- **90 days** from confirmation to ship a fix
- Public disclosure timing is **coordinated with the reporter** — no unilateral disclosure

If you don't hear back within 5 business days, please re-send to admin@slopweaver.ai or open a GitHub Discussion saying you've sent a security report (without disclosing the vulnerability itself).

---

## Public disclosure of fixed vulnerabilities

Once a fix ships, SlopWeaver publishes a **GitHub Security Advisory** on this repo with:

- A description of the vulnerability and affected versions
- The fix and upgrade instructions
- A CVE identifier (where applicable)
- Credit to the reporter (with their permission)

Fixed vulnerabilities are made visible — that's how the security community learns what to look for in similar projects. The privacy is only during the patch window, not forever.

---

## Bug bounty

There's no paid bug bounty program. Security researchers are credited (with permission) in:

- Release notes
- The relevant GitHub Security Advisory
- A `THANKS.md` file (when it exists)

---

## Scope

**In scope**:

- The `slopweaver` npm package (the local binary)
- All `@slopweaver/*` packages
- The MCP server transport, auth, and audit log
- Code in this repository

**Out of scope**:

- Third-party MCP clients that consume SlopWeaver (Claude Code, Cursor, Cline, etc. — please report to the relevant vendor)
- Vulnerabilities in upstream dependencies (please report to the dependency maintainer; SlopWeaver will update once they patch)
- Issues requiring physical access to the user's machine
- Self-XSS or social-engineering scenarios

If you're not sure whether something is in scope, report it anyway via GitHub's private reporting and I'll triage.
