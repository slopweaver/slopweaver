/**
 * Pure projection: shaped Linear items → `CorpusRecord[]`. No I/O. An issue fans out into: the issue
 * **atom** (`<TEAM-123>`) carrying its current state/assignee/labels/project folded into the text, one
 * **comment** record per comment (`<TEAM-123>:comment:<id>`), and standalone **project** records
 * (`project:<id>`). Current state is folded into the issue rather than emitted as churny status events.
 * Linear identifiers (`TEAM-123`) are preserved in titles/text so the graph + citations see the tokens.
 */

import { classifyCurated } from "../curated/classify.js";
import { CURATED_CLASS_ATTR, CURATED_EDGES_ATTR } from "../curated/types.js";
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
  /** PR4.3: encoded curated edges (sub-issues + typed relations) this issue declares. */
  readonly edgeRefs?: readonly string[];
  /** PR4.3: ref-only attachment lines (`title (url)`, never bytes). */
  readonly attachments?: readonly string[];
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
  /** PR4.3: the project's status updates (the weekly "what's happening & why" narrative). */
  readonly updates?: readonly LinearUpdateItem[];
}

/** A Linear project update — the deliberately-authored weekly status narrative. */
export interface LinearUpdateItem {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly tsIso: string;
  readonly author?: string;
  readonly health?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Linear initiative — the top-level strategy artefact grouping projects. */
export interface LinearInitiativeItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly tsIso: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Linear document — a deliberately-authored spec/doc. */
export interface LinearDocumentItem {
  readonly id: string;
  readonly title: string;
  readonly content?: string;
  readonly url: string;
  readonly tsIso: string;
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
  if (issue.edgeRefs !== undefined && issue.edgeRefs.length > 0) {
    attrs[CURATED_EDGES_ATTR] = issue.edgeRefs;
  }
  if (issue.attachments !== undefined && issue.attachments.length > 0) {
    attrs["files"] = issue.attachments;
  }
  return attrs;
}

/** The issue atom record (the issue itself). Pure. */
function issueAtom({ issue, container }: { issue: LinearIssueItem; container: string }): CorpusRecord {
  const text = joinDefined({ parts: [issueSummary({ issue }), issue.description] });
  const attrs = issueAttrs({ issue });
  return {
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
  };
}

/** One comment record under an issue. Pure. */
function commentRecord({
  issue,
  comment,
  container,
}: {
  issue: LinearIssueItem;
  comment: LinearIssueItem["comments"][number];
  container: string;
}): CorpusRecord {
  return {
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
  };
}

/** The issue atom + a comment record per non-blank comment. */
function issueRecords({ issue }: { issue: LinearIssueItem }): CorpusRecord[] {
  const container = issueContainer({ team: issue.team });
  const records: CorpusRecord[] = [issueAtom({ container, issue })];
  for (const comment of issue.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    records.push(commentRecord({ comment, container, issue }));
  }
  return records;
}

/** Add a classification attr when the heuristic fires, else the bare attrs. Pure. */
function withClassification({
  attrs,
  kind,
  title,
  text,
}: {
  attrs: Record<string, CorpusAttributeValue>;
  kind: CorpusRecord["kind"];
  title?: string;
  text: string;
}): Record<string, CorpusAttributeValue> {
  const classification = classifyCurated({ kind, text, ...(title !== undefined ? { title } : {}) });
  return classification !== undefined ? { ...attrs, [CURATED_CLASS_ATTR]: classification } : attrs;
}

/** A standalone project/milestone record. */
function projectRecord({ project }: { project: LinearProjectItem }): CorpusRecord {
  const summary = project.state !== undefined ? `State: ${project.state}` : undefined;
  const text = joinDefined({ parts: [summary, project.description] });
  const attrs = withClassification({
    attrs: {},
    kind: "project",
    text: joinDefined({ parts: [project.name, project.description] }),
    title: project.name,
  });
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
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(project.raw !== undefined ? { raw: project.raw } : {}),
  };
}

/** One project-update record (`update` kind — the weekly status narrative, classified `status`). Pure. */
function updateRecord({ update, project }: { update: LinearUpdateItem; project: LinearProjectItem }): CorpusRecord {
  const attrs = withClassification({ attrs: { project: project.name }, kind: "update", text: update.body });
  return {
    container: "linear",
    kind: "update",
    refs: extractRefs({ text: update.body }),
    source: "linear",
    sourceId: `projectUpdate:${update.id}`,
    text: update.body.length > 0 ? update.body : `Update on ${project.name}`,
    title: `Update: ${project.name}${update.health !== undefined ? ` (${update.health})` : ""}`,
    tsIso: update.tsIso,
    url: update.url.length > 0 ? update.url : project.url,
    ...(update.author !== undefined ? { author: update.author } : {}),
    attrs: { ...attrs, ...(update.health !== undefined ? { health: update.health } : {}) },
    ...(update.raw !== undefined ? { raw: update.raw } : {}),
  };
}

/** The project record + one update record per status update. Pure. */
function projectRecords({ project }: { project: LinearProjectItem }): CorpusRecord[] {
  const records: CorpusRecord[] = [projectRecord({ project })];
  for (const update of project.updates ?? []) {
    records.push(updateRecord({ project, update }));
  }
  return records;
}

/** One initiative record (`initiative` kind — a strategy artefact). Pure. */
function initiativeRecord({ initiative }: { initiative: LinearInitiativeItem }): CorpusRecord {
  const text =
    initiative.description !== undefined && initiative.description.length > 0
      ? initiative.description
      : initiative.name;
  return {
    attrs: withClassification({ attrs: {}, kind: "initiative", text, title: initiative.name }),
    container: "linear",
    kind: "initiative",
    refs: extractRefs({ text: joinDefined({ parts: [initiative.name, initiative.description] }) }),
    source: "linear",
    sourceId: `initiative:${initiative.id}`,
    text,
    title: initiative.name,
    tsIso: initiative.tsIso,
    url: initiative.url,
    ...(initiative.raw !== undefined ? { raw: initiative.raw } : {}),
  };
}

/** One document record (`document` kind — a deliberately-authored spec/doc). Pure. */
function documentRecord({ document }: { document: LinearDocumentItem }): CorpusRecord {
  const text = document.content !== undefined && document.content.length > 0 ? document.content : document.title;
  return {
    attrs: withClassification({ attrs: {}, kind: "document", text, title: document.title }),
    container: "linear",
    kind: "document",
    refs: extractRefs({ text: joinDefined({ parts: [document.title, document.content] }) }),
    source: "linear",
    sourceId: `document:${document.id}`,
    text,
    title: document.title,
    tsIso: document.tsIso,
    url: document.url,
    ...(document.raw !== undefined ? { raw: document.raw } : {}),
  };
}

/**
 * Project issues (+ comments), projects (+ updates), initiatives, and documents into corpus records.
 *
 * @param issues the fetched issues
 * @param projects the fetched projects/milestones (with their status updates)
 * @param initiatives the fetched initiatives (strategy artefacts; empty when the lane is unavailable)
 * @param documents the fetched documents (empty when the lane is unavailable)
 * @returns the flattened corpus records
 */
export function projectLinearRecords({
  issues,
  projects,
  initiatives = [],
  documents = [],
}: {
  issues: readonly LinearIssueItem[];
  projects: readonly LinearProjectItem[];
  initiatives?: readonly LinearInitiativeItem[];
  documents?: readonly LinearDocumentItem[];
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const issue of issues) {
    records.push(...issueRecords({ issue }));
  }
  for (const project of projects) {
    records.push(...projectRecords({ project }));
  }
  for (const initiative of initiatives) {
    records.push(initiativeRecord({ initiative }));
  }
  for (const document of documents) {
    records.push(documentRecord({ document }));
  }
  return records;
}
