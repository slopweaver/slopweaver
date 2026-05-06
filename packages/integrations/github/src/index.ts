export { createGithubClient, extractGithubError } from './client.ts';
export type { CreateGithubClientArgs, GithubClient, GithubErrorShape } from './client.ts';
export { fetchIdentity } from './identity.ts';
export type { FetchIdentityArgs, FetchIdentityResult } from './identity.ts';
export { pollIssues, pollMentions, pollPullRequests } from './polling.ts';
export type { PollArgs, PollMentionsArgs, PollResult } from './polling.ts';
