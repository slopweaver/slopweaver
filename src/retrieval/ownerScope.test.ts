import { describe, expect, it } from "vitest";
import { classifyOwnerAsk, type OwnerIdentity, planOwnerRetrieval } from "./ownerScope.js";
import { DEFAULT_HALF_LIFE_MS } from "./recencyDecay.js";

const owner: OwnerIdentity = { handles: ["ada", "U_OWNER", "ada-gh"], personId: "owner-1" };

describe("classifyOwnerAsk", () => {
  it("flags a first-person owned enumeration ask", () => {
    expect(classifyOwnerAsk({ question: "what are my open PRs" })).toEqual({
      enumeration: true,
      firstPersonOwned: true,
    });
  });

  it('flags "assigned to me" as first-person owned', () => {
    expect(classifyOwnerAsk({ question: "what is assigned to me" }).firstPersonOwned).toBe(true);
  });

  it('does NOT flag a team ask using "we/our"', () => {
    expect(classifyOwnerAsk({ question: "what did we ship in our sprint" })).toEqual({
      enumeration: false,
      firstPersonOwned: false,
    });
  });

  it("treats a first-person non-enumeration ask as owned but not enumeration", () => {
    expect(classifyOwnerAsk({ question: "summarise my week" })).toEqual({
      enumeration: false,
      firstPersonOwned: true,
    });
  });

  it('does NOT treat a bare "... to me" as owner-owned (avoids "explain auth to me" false positives)', () => {
    expect(classifyOwnerAsk({ question: "explain the auth flow to me" }).firstPersonOwned).toBe(false);
  });
});

describe("planOwnerRetrieval", () => {
  it("injects the owner's handles into a first-person query", () => {
    const plan = planOwnerRetrieval({ decay: undefined, owner, question: "my open PRs" });
    expect(plan.ownerScoped).toBe(true);
    expect(plan.query).toBe("my open PRs ada U_OWNER ada-gh");
  });

  it("relaxes the recency half-life 6x for an enumeration intent", () => {
    const plan = planOwnerRetrieval({ decay: { halfLifeMs: 1000, nowMs: 0 }, owner, question: "list all my issues" });
    expect(plan.decay).toEqual({ halfLifeMs: 6000, nowMs: 0 });
  });

  it("relaxes from the default half-life when no explicit half-life is set", () => {
    const plan = planOwnerRetrieval({ decay: { nowMs: 0 }, owner, question: "all my open tickets" });
    expect(plan.decay).toEqual({ halfLifeMs: DEFAULT_HALF_LIFE_MS * 6, nowMs: 0 });
  });

  it("does NOT rewrite or relax for a we/our team ask (pass-through)", () => {
    const plan = planOwnerRetrieval({ decay: { halfLifeMs: 1000, nowMs: 0 }, owner, question: "what did we ship" });
    expect(plan).toEqual({ decay: { halfLifeMs: 1000, nowMs: 0 }, ownerScoped: false, query: "what did we ship" });
  });

  it("is a pass-through when the owner has no known handles", () => {
    const plan = planOwnerRetrieval({ decay: undefined, owner: { handles: [], personId: "x" }, question: "my PRs" });
    expect(plan).toEqual({ ownerScoped: false, query: "my PRs" });
  });

  it("does not relax recency for a first-person non-enumeration ask", () => {
    const plan = planOwnerRetrieval({ decay: { halfLifeMs: 1000, nowMs: 0 }, owner, question: "summarise my day" });
    expect(plan.decay).toEqual({ halfLifeMs: 1000, nowMs: 0 });
  });
});
