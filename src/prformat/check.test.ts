import { describe, expect, it } from "vitest";
import { countWords, MAX_WORDS, validatePrBody } from "./checkCore.js";

/** Badge row for a given proof grade. */
function badges({ grade = "bronze" }: { grade?: "bronze" | "silver" | "gold" } = {}): string {
  return `![CI](https://img.shields.io/badge/CI-passing-2ea44f) ![proof](https://img.shields.io/badge/proof-${grade}-9ea7ad)`;
}

/** Build a canonical HTML-table PR body. */
function body({
  problem,
  solution,
  proof = "ok",
  grade = "bronze",
  withBadges = true,
}: {
  problem: string;
  solution: string;
  proof?: string;
  grade?: "bronze" | "silver" | "gold";
  withBadges?: boolean;
}): string {
  return [
    withBadges ? badges({ grade }) : "(no badges)",
    "",
    "<table>",
    `<tr><td><strong>Problem</strong></td><td>${problem}</td></tr>`,
    `<tr><td><strong>Solution</strong></td><td>${solution}</td></tr>`,
    `<tr><td><strong>Proof</strong></td><td>${proof}</td></tr>`,
    "</table>",
  ].join("\n");
}

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(" ");

describe("countWords", () => {
  it("ignores HTML tags, <br>, link URLs, inline code and markdown noise", () => {
    expect(
      countWords({ cell: '• <strong>Strip</strong> the prototype<br><img src="x.png"> `argv` [run](https://x.y/z)' }),
    ).toBe(5);
  });
});

describe("validatePrBody", () => {
  it("accepts a conforming bronze body with terse proof", () => {
    expect(validatePrBody({ body: body({ problem: words(10), solution: words(40) }) })).toEqual({
      errors: [],
      ok: true,
    });
  });

  it("accepts exactly MAX_WORDS", () => {
    expect(validatePrBody({ body: body({ problem: words(MAX_WORDS), solution: words(1) }) }).ok).toBe(true);
  });

  it("rejects a Problem over the word cap", () => {
    const result = validatePrBody({ body: body({ problem: words(MAX_WORDS + 1), solution: words(1) }) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Problem") && e.includes("max"))).toBe(true);
  });

  it("rejects a missing badge row", () => {
    const result = validatePrBody({ body: body({ problem: words(2), solution: words(2), withBadges: false }) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("badge"))).toBe(true);
  });

  it("rejects a missing Solution row", () => {
    const noSolution = `${badges()}\n<table>\n<tr><td><strong>Problem</strong></td><td>${words(3)}</td></tr>\n<tr><td><strong>Proof</strong></td><td>ok</td></tr>\n</table>`;
    const result = validatePrBody({ body: noSolution });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Solution"))).toBe(true);
  });

  it("rejects a missing Proof row", () => {
    const noProof = `${badges()}\n<table>\n<tr><td><strong>Problem</strong></td><td>${words(3)}</td></tr>\n<tr><td><strong>Solution</strong></td><td>${words(3)}</td></tr>\n</table>`;
    expect(validatePrBody({ body: noProof }).errors.some((e) => e.includes("Proof"))).toBe(true);
  });

  it("still accepts the markdown-table fallback", () => {
    const md = `${badges()}\n\n| | |\n|---|---|\n| **Problem** | ${words(3)} |\n| **Solution** | ${words(3)} |\n| **Proof** | ok |`;
    expect(validatePrBody({ body: md }).ok).toBe(true);
  });

  it('rejects a silver proof with no evidence (terse "ok" in the Proof cell)', () => {
    const result = validatePrBody({
      body: body({ grade: "silver", problem: words(3), proof: "ok", solution: words(3) }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Proof") && e.includes("evidence"))).toBe(true);
  });

  it("accepts a silver proof with a transcript/run link in the Proof cell", () => {
    const proof = "silver — terminal transcript: https://github.com/x/y/pull/1#issuecomment-123";
    expect(validatePrBody({ body: body({ grade: "silver", problem: words(3), proof, solution: words(3) }) }).ok).toBe(
      true,
    );
  });

  it("accepts a silver proof with an embedded image in the Proof cell", () => {
    const proof = 'ran it <img src="https://user-images.githubusercontent.com/x.png">';
    expect(validatePrBody({ body: body({ grade: "silver", problem: words(3), proof, solution: words(3) }) }).ok).toBe(
      true,
    );
  });

  it("rejects a gold proof with no evidence in the Proof cell", () => {
    const result = validatePrBody({
      body: body({ grade: "gold", problem: words(3), proof: "ok", solution: words(3) }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Proof") && e.includes("evidence"))).toBe(true);
  });

  it("accepts a gold proof with a run link in the Proof cell", () => {
    const proof = "gold — end-to-end run: https://github.com/x/y/actions/runs/1";
    expect(validatePrBody({ body: body({ grade: "gold", problem: words(3), proof, solution: words(3) }) }).ok).toBe(
      true,
    );
  });
});
