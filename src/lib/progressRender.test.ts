import { describe, expect, it } from "vitest";
import type { ProgressLearning, ProgressPreview, ProgressSnapshot } from "./progress.js";
import {
  groupThousands,
  humanDuration,
  renderHeartbeatLine,
  renderLearningLine,
  renderPreviewLine,
  renderProgressEvent,
} from "./progressRender.js";

/** A heartbeat snapshot with the given overrides atop a minimal base. */
function snapshot(over: Partial<ProgressSnapshot>): ProgressSnapshot {
  return { elapsedMs: 0, metrics: {}, phase: "", stalled: false, step: "Working", verb: "refresh", ...over };
}

describe("groupThousands (pure)", () => {
  it("groups digits in threes", () => {
    expect(groupThousands({ value: 12_420 })).toBe("12,420");
    expect(groupThousands({ value: 999 })).toBe("999");
    expect(groupThousands({ value: 1_840 })).toBe("1,840");
  });
});

describe("humanDuration (pure)", () => {
  it("picks a single coarse unit", () => {
    expect(humanDuration({ seconds: 40 })).toBe("40s");
    expect(humanDuration({ seconds: 840 })).toBe("14m");
    expect(humanDuration({ seconds: 7200 })).toBe("2h");
  });
});

describe("renderHeartbeatLine (pure)", () => {
  it("renders the full Slack heartbeat with source, item, percent, ETA, and metrics", () => {
    const line = renderHeartbeatLine({
      snapshot: snapshot({
        currentItem: { title: "#eng-platform" },
        etaSeconds: 840,
        metrics: { messages: 12_420, skipped: 7, threads: 381 },
        percent: 63,
        source: "slack",
        step: "Reading channel",
      }),
    });
    expect(line).toBe(
      "refresh slack · Reading channel · #eng-platform · 63% · ETA 14m · 12,420 messages · 7 skipped · 381 threads",
    );
  });

  it("drops absent clauses — a pre-data heartbeat is just verb · step", () => {
    expect(renderHeartbeatLine({ snapshot: snapshot({ step: "Reading channel" }) })).toBe("refresh · Reading channel");
  });

  it("marks a stalled heartbeat", () => {
    const line = renderHeartbeatLine({ snapshot: snapshot({ percent: 40, stalled: true, step: "Reading pages" }) });
    expect(line).toBe("refresh · Reading pages · 40% · (stalled)");
  });

  it("renders a sourceless verb line (derive)", () => {
    const line = renderHeartbeatLine({
      snapshot: snapshot({
        metrics: { edges: 12_903, people: 1_840 },
        percent: 100,
        step: "Building graphs",
        verb: "derive",
      }),
    });
    expect(line).toBe("derive · Building graphs · 100% · 12,903 edges · 1,840 people");
  });
});

describe("renderPreviewLine (pure)", () => {
  it("renders subject, sender, redacted snippet, and cite", () => {
    const preview: ProgressPreview = {
      sender: "ana",
      snippet: "we should ship the retry fix first",
      sourceContentId: "chan-eng",
      subject: "#eng-platform",
    };
    expect(renderPreviewLine({ preview })).toBe(
      '  ↳ #eng-platform · ana · "we should ship the retry fix first" [chan-eng]',
    );
  });

  it("omits the sender when absent", () => {
    const preview: ProgressPreview = { snippet: "hello", sourceContentId: "P1", subject: "Roadmap" };
    expect(renderPreviewLine({ preview })).toBe('  ↳ Roadmap · "hello" [P1]');
  });
});

describe("renderLearningLine (pure)", () => {
  it("renders category/confidence, content, and cite", () => {
    const learning: ProgressLearning = {
      category: "decision",
      confidence: "high",
      content: "Pagination retry ownership moved to the connector boundary",
      sourceContentId: "example/api#482",
    };
    expect(renderLearningLine({ learning })).toBe(
      "  ↳ learned decision/high · Pagination retry ownership moved to the connector boundary [example/api#482]",
    );
  });
});

describe("renderProgressEvent (pure dispatch)", () => {
  it("dispatches each lane to its renderer", () => {
    expect(renderProgressEvent({ event: { lane: "heartbeat", snapshot: snapshot({ step: "Reading channel" }) } })).toBe(
      "refresh · Reading channel",
    );
    expect(
      renderProgressEvent({
        event: { lane: "content_preview", preview: { snippet: "hi", sourceContentId: "P1", subject: "Roadmap" } },
      }),
    ).toBe('  ↳ Roadmap · "hi" [P1]');
    expect(
      renderProgressEvent({
        event: {
          lane: "knowledge_extracted",
          learning: { category: "blocker", confidence: "low", content: "flaky CI", sourceContentId: "X1" },
        },
      }),
    ).toBe("  ↳ learned blocker/low · flaky CI [X1]");
  });
});
