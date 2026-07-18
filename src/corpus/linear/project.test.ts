import { describe, expect, it } from "vitest";
import { type LinearIssueItem, type LinearProjectItem, projectLinearRecords } from "./project.js";

const issue: LinearIssueItem = {
  assignee: "Dana",
  author: "Sam",
  comments: [
    {
      author: "Dana",
      body: "on it",
      id: "c1",
      tsIso: "2026-05-02T00:00:00.000Z",
      url: "https://linear.app/acme/issue/ENG-42#comment-c1",
    },
  ],
  description: "the retriever drops old records",
  identifier: "ENG-42",
  labels: ["bug", "retrieval"],
  project: "Search quality",
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
