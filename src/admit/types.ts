/**
 * The door's vocabulary — the types every side-effecting action is described in on its way out. The door
 * (PR2) is the trust spine: it ships with NO real gates, only the pathway + the warn-first / override /
 * hold contract, so that when actions arrive (PR5+) they are gated by construction, never retrofitted.
 *
 * Kept deliberately boring + reusable: pure data, no I/O, no behaviour. `door.ts` decides, `ledger.ts`
 * records, `rawTools.ts` classifies the raw-bypass tools, `coverage.ts` proves no seam escapes.
 */

/** What a seam does to the world — the axis the door polices. Local-state (under $SLOPWEAVER_HOME) is the
 * product working normally; only EXTERNAL writes/sends are the thing the door must gate or hold. */
export type DoorEffect = "none" | "local-state" | "external-read" | "external-write";

/** The action being attempted: a Slopweaver verb, or a raw bypass tool the hook intercepts. */
export type DoorAction =
  | { readonly kind: "verb"; readonly noun: string; readonly verb: string }
  | { readonly kind: "raw-tool"; readonly tool: string; readonly command: string };

/** The thing being acted on (a repo slug, a path, a message target …). Free-form, for the record + gates. */
export type DoorArtifact = Readonly<Record<string, unknown>>;

/**
 * Context the door + gates + ledger need. All fields REQUIRED so a call site states its intent explicitly
 * (an omitted `requiresApproval` can't silently read as "false"); `home` is `string | null` — null means
 * "the resolved default home", spelled out rather than an absent field.
 */
export interface DoorMeta {
  readonly effect: DoorEffect;
  readonly requiresApproval: boolean;
  readonly createsWorkItem: boolean;
  readonly home: string | null;
}

/** One request through the door. `artifact` is required — pass `{}` when there's nothing to describe. */
export interface DoorRequest {
  readonly action: DoorAction;
  readonly artifact: DoorArtifact;
  readonly meta: DoorMeta;
}

/** Fields every finding shares — structured so the agent can SELF-CORRECT (not prose-only). */
interface DoorFindingBase {
  readonly code: string;
  readonly summary: string;
  /** What to change to satisfy the gate. */
  readonly correction: string;
}

/**
 * A finding is a discriminated union so the warn/hold contract is enforced at the TYPE level: a `warn`
 * MUST carry an `override` token (so it is always self-correctable), and a `hold` has none (it is the
 * irreversible-harm core, never waivable by the per-action token). A gate cannot express "an
 * un-overridable warn" or "an overridable hold".
 */
export type DoorFinding =
  | (DoorFindingBase & {
      readonly severity: "warn";
      /** The per-action override token (e.g. `refresh.run:v1`) that, in `$SLOPWEAVER_DOOR_OVERRIDE`, waives this warn. */
      readonly override: string;
    })
  | (DoorFindingBase & { readonly severity: "hold" });

/** The door's verdict. `pass` lets the effect happen; `warn`/`hold` mean the caller MUST NOT perform it. */
export type DoorStatus = "pass" | "warn" | "hold";

/** A decision, plus the findings that produced it and any findings an override waived (for the record). */
export interface DoorDecision {
  readonly status: DoorStatus;
  readonly findings: readonly DoorFinding[];
  /** Findings that fired but were waived by an explicit override token (recorded, never silent). */
  readonly overridden: readonly DoorFinding[];
}

/** A gate: pure `request → findings`. The compose seam is EMPTY in PR2; PR9/PR14 fill it. */
export type DoorGate = (request: DoorRequest) => readonly DoorFinding[];
