// Yarn 4 constraints — machine-enforced package.json invariants (run via `yarn constraints`).
// This repo pins EVERY dependency to an exact version (no ^/~ ranges) and always declares packageManager.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

module.exports = {
  constraints({ Yarn }) {
    for (const workspace of Yarn.workspaces()) {
      workspace.set("packageManager", "yarn@4.17.1");
    }
    for (const dep of Yarn.dependencies()) {
      // A `portal:`/`workspace:`/`patch:` protocol range is intentional; only version ranges must be exact.
      if (dep.range.includes(":")) {
        continue;
      }
      if (dep.range.startsWith("^") || dep.range.startsWith("~")) {
        dep.update(dep.range.slice(1));
        continue;
      }
      if (!EXACT_VERSION.test(dep.range)) {
        dep.error(`${dep.ident} must use an exact pinned version, got ${dep.range}`);
      }
    }
  },
};
