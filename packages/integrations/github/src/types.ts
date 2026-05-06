/**
 * Hand-rolled minimal types for the GitHub REST endpoints we hit.
 *
 * These cover only the fields we actually read. Anything else lives in
 * `payload_json` (the verbatim response is stored as-is for replay/audit).
 * If a future poller needs more fields, widen these types — don't reach
 * into untyped objects at the call site.
 */

export type GithubSearchIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  pull_request?: { url: string };
};

export type GithubSearchResponse = {
  total_count: number;
  incomplete_results: boolean;
  items: GithubSearchIssue[];
};

export type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  html_url: string;
};
