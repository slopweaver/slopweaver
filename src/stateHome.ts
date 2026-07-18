/**
 * The ONE typed contract for everything the agent persists under `$SLOPWEAVER_HOME`. Every module that
 * needs a path inside the home imports it from here — no other file derives a home sub-path with its own
 * `join(home, …)`. That single-source rule is what lets the belief store, ledgers, identity, profile, and
 * the medallion corpus grow without callers drifting into disagreeing layouts (a guard test enforces it).
 *
 * Zero-file-config is preserved: this only computes paths off `slopweaverHome()`; it reads nothing and
 * writes nothing. Scaffolding those paths is `stateInit`; reporting them is `doctor`.
 *
 *   $SLOPWEAVER_HOME/
 *   ├── .home-version.json        # layout marker (STATE_HOME_VERSION) — for future migration
 *   ├── corpus/                   # the medallion store (bronze → silver → gold + caches)
 *   │   ├── bronze/  silver/  gold/  .cache/  .watermark.json
 *   ├── beliefs/                  # belief store (contents: PR10)
 *   ├── ledgers/                  # append-only run logs (dev-gate, correction ledger: PR12)
 *   ├── identity.json             # cross-integration identity map (PR4)
 *   ├── profile.json              # the persona/profile seed
 *   ├── hygiene-denylist.txt      # the private, uncommitted leak denylist
 *   └── .cache/models/            # on-device embedding model weights (rebuildable)
 */
import { join } from "node:path";

import { slopweaverHome } from "./config.js";

/** The on-disk layout version. Bump only with a migration; init stamps it, doctor reports it. */
export const STATE_HOME_VERSION = 1;

/** The medallion corpus roots under the home. Leaf paths (per-source, per-window) live in `corpusPaths`. */
export interface CorpusPaths {
  /** `$home/corpus` — the medallion root. */
  readonly root: string;
  /** `$home/corpus/bronze` — raw `CorpusRecord` lines per source. */
  readonly bronze: string;
  /** `$home/corpus/silver` — derived directory/graph/digests. */
  readonly silver: string;
  /** `$home/corpus/gold` — distilled markdown. */
  readonly gold: string;
  /** `$home/corpus/.cache` — rebuildable per-corpus caches (distil batches, vectors). */
  readonly cache: string;
  /** `$home/corpus/.watermark.json` — per-source incremental resume cursor. */
  readonly watermark: string;
}

/** Every absolute path the agent persists under one `$SLOPWEAVER_HOME`. The single home-path contract. */
export interface StateHomePaths {
  /** The resolved home root itself. */
  readonly root: string;
  /** `$home/.home-version.json` — the layout-version marker. */
  readonly homeVersion: string;
  /** The medallion corpus roots. */
  readonly corpus: CorpusPaths;
  /** `$home/beliefs` — the belief store (contents reserved for PR10). */
  readonly beliefs: string;
  /** `$home/ledgers` — append-only run logs (dev-gate log/diff; correction ledger reserved for PR12). */
  readonly ledgers: string;
  /** `$home/identity.json` — the cross-integration identity map (seeded from a template). */
  readonly identityJson: string;
  /** `$home/profile.json` — the persona/profile seed (seeded from a template). */
  readonly profileJson: string;
  /** `$home/hygiene-denylist.txt` — the private, uncommitted leak denylist the hygiene gate reads. */
  readonly hygieneDenylist: string;
  /** `$home/.cache/models` — the on-device embedding model cache (rebuildable, gitignored). */
  readonly modelCache: string;
}

/**
 * Resolve every persisted path under the home. Pure: no I/O, deterministic given `home`. All returned
 * paths are absolute descendants of the resolved home, so the whole layout moves with `$SLOPWEAVER_HOME`.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the full typed path contract rooted at `home`
 */
export function stateHomePaths({ home = slopweaverHome() }: { home?: string } = {}): StateHomePaths {
  const corpusRoot = join(home, "corpus");
  return {
    beliefs: join(home, "beliefs"),
    corpus: {
      bronze: join(corpusRoot, "bronze"),
      cache: join(corpusRoot, ".cache"),
      gold: join(corpusRoot, "gold"),
      root: corpusRoot,
      silver: join(corpusRoot, "silver"),
      watermark: join(corpusRoot, ".watermark.json"),
    },
    homeVersion: join(home, ".home-version.json"),
    hygieneDenylist: join(home, "hygiene-denylist.txt"),
    identityJson: join(home, "identity.json"),
    ledgers: join(home, "ledgers"),
    modelCache: join(home, ".cache", "models"),
    profileJson: join(home, "profile.json"),
    root: home,
  };
}
