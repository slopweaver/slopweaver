/**
 * Pure projection: shaped Linear items → `CorpusRecord[]`. No I/O. An issue fans out into: the issue
 * **atom** (`<TEAM-123>`) carrying its current state/assignee/labels/project folded into the text, one
 * **comment** record per comment (`<TEAM-123>:comment:<id>`), and standalone **project** records
 * (`project:<id>`). Current state is folded into the issue rather than emitted as churny status events.
 * Linear identifiers (`TEAM-123`) are preserved in titles/text so the graph + citations see the tokens.
 */

import { extractRefs } from "../refs.js";
import type { CorpusAttributeValue, CorpusRecord } from "../types.js";

/** A Linear comment, already shaped by the fetch edge. */
export interface LinearCommentItem {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly tsIso: string;
  readonly url: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Linear issue with its current state + all comments. */
export interface LinearIssueItem {
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url: string;
  readonly tsIso: string;
  readonly author?: string;
  readonly state?: string;
  readonly assignee?: string;
  readonly team?: string;
  readonly project?: string;
  readonly labels: readonly string[];
  readonly comments: readonly LinearCommentItem[];
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Linear project/milestone summary. */
export interface LinearProjectItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly tsIso: string;
  readonly state?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** Join defined string parts with a newline (drops undefined without faking an empty). */
function joinDefined({ parts }: { parts: readonly (string | undefined)[] }): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join("\n");
}

/** `linear/<team>` when the team is known, else `linear`. */
function issueContainer({ team }: { team: string | undefined }): string {
  return team !== undefined && team.length > 0 ? `linear/${team}` : "linear";
}

/** A one-line facts summary (state · assignee · labels · project) folded ahead of the description. */
function issueSummary({ issue }: { issue: LinearIssueItem }): string {
  const parts: string[] = [];
  if (issue.state !== undefined) {
    parts.push(`State: ${issue.state}`);
  }
  if (issue.assignee !== undefined) {
    parts.push(`Assignee: ${issue.assignee}`);
  }
  if (issue.labels.length > 0) {
    parts.push(`Labels: ${issue.labels.join(", ")}`);
  }
  if (issue.project !== undefined) {
    parts.push(`Project: ${issue.project}`);
  }
  return parts.join(" · ");
}

/** Rich structured metadata for an issue — stored in bronze, kept OUT of the embedded text. */
function issueAttrs({ issue }: { issue: LinearIssueItem }): Record<string, CorpusAttributeValue> {
  const attrs: Record<string, CorpusAttributeValue> = {};
  if (issue.state !== undefined) {
    attrs["state"] = issue.state;
  }
  if (issue.assignee !== undefined) {
    attrs["assignee"] = issue.assignee;
  }
  if (issue.team !== undefined) {
    attrs["team"] = issue.team;
  }
  if (issue.project !== undefined) {
    attrs["project"] = issue.project;
  }
  if (issue.labels.length > 0) {
    attrs["labels"] = issue.labels;
  }
  return attrs;
}

/** The issue atom + a comment record per comment. */
function issueRecords({ issue }: { issue: LinearIssueItem }): CorpusRecord[] {
  const container = issueContainer({ team: issue.team });
  const summary = issueSummary({ issue });
  const text = joinDefined({ parts: [summary, issue.description] });
  const attrs = issueAttrs({ issue });
  const records: CorpusRecord[] = [
    {
      container,
      kind: "issue",
      refs: extractRefs({ text: joinDefined({ parts: [issue.identifier, issue.title, issue.description] }) }),
      source: "linear",
      sourceId: issue.identifier,
      text: text.length > 0 ? text : issue.title,
      title: `${issue.identifier} ${issue.title}`,
      tsIso: issue.tsIso,
      url: issue.url,
      ...(issue.author !== undefined ? { author: issue.author } : {}),
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(issue.raw !== undefined ? { raw: issue.raw } : {}),
    },
  ];
  for (const comment of issue.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    records.push({
      container,
      kind: "comment",
      refs: extractRefs({ text: `${issue.identifier} ${comment.body}` }),
      source: "linear",
      sourceId: `${issue.identifier}:comment:${comment.id}`,
      text: comment.body,
      tsIso: comment.tsIso,
      url: comment.url.length > 0 ? comment.url : issue.url,
      ...(comment.author !== undefined ? { author: comment.author } : {}),
      ...(comment.raw !== undefined ? { raw: comment.raw } : {}),
    });
  }
  return records;
}

/** A standalone project/milestone record. */
function projectRecord({ project }: { project: LinearProjectItem }): CorpusRecord {
  const summary = project.state !== undefined ? `State: ${project.state}` : undefined;
  const text = joinDefined({ parts: [summary, project.description] });
  return {
    container: "linear",
    kind: "project",
    refs: extractRefs({ text: joinDefined({ parts: [project.name, project.description] }) }),
    source: "linear",
    sourceId: `project:${project.id}`,
    text: text.length > 0 ? text : project.name,
    title: project.name,
    tsIso: project.tsIso,
    url: project.url,
    ...(project.raw !== undefined ? { raw: project.raw } : {}),
  };
}

/**
 * Project issues (+ comments) and projects into corpus records.
 *
 * @param issues the fetched issues
 * @param projects the fetched projects/milestones
 * @returns the flattened corpus records
 */
export function projectLinearRecords({
  issues,
  projects,
}: {
  issues: readonly LinearIssueItem[];
  projects: readonly LinearProjectItem[];
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const issue of issues) {
    records.push(...issueRecords({ issue }));
  }
  for (const project of projects) {
    records.push(projectRecord({ project }));
  }
  return records;
}
