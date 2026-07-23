import { describe, expect, it } from "vitest";
import { type LinearIssueItem, type LinearProjectItem, projectLinearRecords } from "./project.js";

const rawIssue = { identifier: "ENG-42", rawMarker: "linear-issue" };
const rawComment = { id: "c1", rawMarker: "linear-comment" };
const rawProject = { id: "p1", rawMarker: "linear-project" };

const issue: LinearIssueItem = {
  assignee: "Dana",
  author: "Sam",
  comments: [
    {
      author: "Dana",
      body: "on it",
      id: "c1",
      raw: rawComment,
      tsIso: "2026-05-02T00:00:00.000Z",
      url: "https://linear.app/acme/issue/ENG-42#comment-c1",
    },
  ],
  description: "the retriever drops old records",
  identifier: "ENG-42",
  labels: ["bug", "retrieval"],
  project: "Search quality",
  raw: rawIssue,
  state: "In Progress",
  team: "ENG",
  title: "recall regression",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-42",
};

const project: LinearProjectItem = {
  description: "make ask trustworthy",
  id: "p1",
  name: "Search quality",
  raw: rawProject,
  state: "started",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "https://linear.app/acme/project/p1",
};

describe("projectLinearRecords", () => {
  it("projects an issue atom keyed by identifier, folding state/assignee/labels/project into the text", () => {
    const records = projectLinearRecords({ issues: [issue], projects: [] });
    const atom = records.find((r) => r.kind === "issue")!;
    expect(atom.sourceId).toBe("ENG-42");
    expect(atom.source).toBe("linear");
    expect(atom.container).toBe("linear/ENG");
    expect(atom.title).toBe("ENG-42 recall regression");
    expect(atom.author).toBe("Sam");
    expect(atom.text).toContain("State: In Progress");
    expect(atom.text).toContain("Assignee: Dana");
    expect(atom.text).toContain("Labels: bug, retrieval");
    expect(atom.text).toContain("the retriever drops old records");
    expect(atom.refs).toContain("ENG-42");
  });

  it("threads raw payloads onto issue, comment, and project records", () => {
    const records = projectLinearRecords({ issues: [issue], projects: [project] });
    expect(records.find((r) => r.sourceId === "ENG-42")!.raw).toEqual(rawIssue);
    expect(records.find((r) => r.sourceId === "ENG-42:comment:c1")!.raw).toEqual(rawComment);
    expect(records.find((r) => r.sourceId === "project:p1")!.raw).toEqual(rawProject);
  });

  it("projects each comment to a comment record keyed by issue + comment id", () => {
    const records = projectLinearRecords({ issues: [issue], projects: [] });
    const comment = records.find((r) => r.kind === "comment")!;
    expect(comment.sourceId).toBe("ENG-42:comment:c1");
    expect(comment.text).toBe("on it");
    expect(comment.author).toBe("Dana");
  });

  it("projects a project to a `project` record keyed by project id", () => {
    const records = projectLinearRecords({ issues: [], projects: [project] });
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("project");
    expect(records[0]!.sourceId).toBe("project:p1");
    expect(records[0]!.title).toBe("Search quality");
    expect(records[0]!.text).toContain("State: started");
  });

  it("omits an absent description without faking an empty body", () => {
    const records = projectLinearRecords({
      issues: [
        { comments: [], identifier: "ENG-9", labels: [], title: "bare", tsIso: "2026-05-01T00:00:00.000Z", url: "u" },
      ],
      projects: [],
    });
    expect(records[0]!.text).toBe("bare");
  });
});

describe("projectLinearRecords — curated layer (PR4.3)", () => {
  it("carries an issue's curated edges + ref-only attachments onto its atom attrs", () => {
    const withEdges: LinearIssueItem = {
      ...issue,
      attachments: ["Design doc (https://figma/x)"],
      edgeRefs: ["sub-issue|linear:ENG-43", "blocks|linear:ENG-99"],
    };
    const atom = projectLinearRecords({ issues: [withEdges], projects: [] }).find((r) => r.sourceId === "ENG-42")!;
    expect(atom.attrs!["curatedEdges"]).toEqual(["sub-issue|linear:ENG-43", "blocks|linear:ENG-99"]);
    expect(atom.attrs!["files"]).toEqual(["Design doc (https://figma/x)"]);
  });

  it("projects a project update to an `update` record classified `status`", () => {
    const withUpdate: LinearProjectItem = {
      ...project,
      updates: [
        {
          body: "on track this week",
          health: "onTrack",
          id: "u1",
          tsIso: "2026-05-03T00:00:00.000Z",
          url: "https://linear.app/u1",
        },
      ],
    };
    const update = projectLinearRecords({ issues: [], projects: [withUpdate] }).find((r) => r.kind === "update")!;
    expect(update.sourceId).toBe("projectUpdate:u1");
    expect(update.text).toBe("on track this week");
    expect(update.attrs!["classification"]).toBe("status");
    expect(update.attrs!["project"]).toBe("Search quality");
  });

  it("projects an initiative to an `initiative` record classified `strategy`", () => {
    const records = projectLinearRecords({
      initiatives: [
        {
          description: "grow retention",
          id: "i1",
          name: "North star",
          tsIso: "2026-05-01T00:00:00.000Z",
          url: "https://linear.app/i1",
        },
      ],
      issues: [],
      projects: [],
    });
    const initiative = records.find((r) => r.kind === "initiative")!;
    expect(initiative.sourceId).toBe("initiative:i1");
    expect(initiative.attrs!["classification"]).toBe("strategy");
  });

  it("projects a document to a `document` record classified `strategy`", () => {
    const records = projectLinearRecords({
      documents: [
        {
          content: "the plan",
          id: "d1",
          title: "Roadmap",
          tsIso: "2026-05-01T00:00:00.000Z",
          url: "https://linear.app/d1",
        },
      ],
      issues: [],
      projects: [],
    });
    const document = records.find((r) => r.kind === "document")!;
    expect(document.sourceId).toBe("document:d1");
    expect(document.attrs!["classification"]).toBe("strategy");
  });
});
