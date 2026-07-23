/**
 * Pure Linear curated-layer extractors (PR4.3): turn an issue node's declared relationships into explicit
 * curated edges and its attachments into ref-only metadata. No I/O — reads the inline GraphQL node
 * `fetch.ts` already pulled (sub-issues + relations cost NO extra requests, they ride the issue page query).
 *
 *  - **Sub-issues** — an issue's `children` become `sub-issue` edges (parent → child).
 *  - **Relations** — an issue's `relations` become `blocks`/`duplicate`/`relation` edges to the related issue.
 *  - **Attachments** — kept as ref-only `title (url)` lines; never bytes.
 *
 * All targets are `linear:<IDENTIFIER>` node keys (matching the issue atom's `linear:TEAM-123` node), so an
 * edge lines up with the target issue's own record.
 */
import { isRecord } from "../../lib/parsers.js";
import { type CuratedEdgeKind, encodeCuratedEdgeRef } from "../curated/types.js";

/** Linear `IssueRelation.type` → the curated edge kind (an unknown type is a generic `relation`). Pure. */
function relationEdgeKind({ type }: { type: string }): CuratedEdgeKind {
  if (type === "blocks") {
    return "blocks";
  }
  if (type === "duplicate") {
    return "duplicate";
  }
  return "relation";
}

/** The `linear:<identifier>` node key off a nested issue-like object (`child`/`relatedIssue`), or undefined. */
function issueNodeKey({ value }: { value: unknown }): string | undefined {
  const identifier = isRecord(value) && typeof value["identifier"] === "string" ? value["identifier"] : undefined;
  return identifier !== undefined && identifier.length > 0 ? `linear:${identifier}` : undefined;
}

/** The child-node keys off a `children` connection. Pure. */
function childEdgeRefs({ children }: { children: unknown }): readonly string[] {
  const nodes = isRecord(children) && Array.isArray(children["nodes"]) ? children["nodes"] : [];
  return nodes
    .map((node) => issueNodeKey({ value: node }))
    .filter((key): key is string => key !== undefined)
    .map((target) => encodeCuratedEdgeRef({ kind: "sub-issue", target }));
}

/** The relation-node keys (typed) off a `relations` connection. Pure. */
function relationEdgeRefs({ relations }: { relations: unknown }): readonly string[] {
  const nodes = isRecord(relations) && Array.isArray(relations["nodes"]) ? relations["nodes"] : [];
  const refs: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const target = issueNodeKey({ value: node["relatedIssue"] });
    const type = typeof node["type"] === "string" ? node["type"] : "related";
    if (target !== undefined) {
      refs.push(encodeCuratedEdgeRef({ kind: relationEdgeKind({ type }), target }));
    }
  }
  return refs;
}

/**
 * The declared curated edges an issue node contributes (sub-issues + typed relations), deduped. Pure.
 *
 * @param node the raw issue node
 * @returns the encoded curated-edge refs (empty when the issue declares none)
 */
export function issueEdgeRefs({ node }: { node: Record<string, unknown> }): readonly string[] {
  return [
    ...new Set([
      ...childEdgeRefs({ children: node["children"] }),
      ...relationEdgeRefs({ relations: node["relations"] }),
    ]),
  ];
}

/**
 * An issue node's attachments as ref-only `title (url)` lines (never bytes). Pure.
 *
 * @param node the raw issue node
 * @returns the deduped attachment ref lines (empty when none)
 */
/** One attachment node → its ref-only `title (url)` line (never bytes), or undefined for a non-object. Pure. */
function attachmentRef({ att }: { att: unknown }): string | undefined {
  if (!isRecord(att)) {
    return undefined;
  }
  const title = typeof att["title"] === "string" && att["title"].length > 0 ? att["title"] : "attachment";
  const url = typeof att["url"] === "string" && att["url"].length > 0 ? att["url"] : undefined;
  return url !== undefined ? `${title} (${url})` : title;
}

export function issueAttachmentRefs({ node }: { node: Record<string, unknown> }): readonly string[] {
  const attachments = node["attachments"];
  const nodes = isRecord(attachments) && Array.isArray(attachments["nodes"]) ? attachments["nodes"] : [];
  const refs = nodes.map((att) => attachmentRef({ att })).filter((ref): ref is string => ref !== undefined);
  return [...new Set(refs)];
}
