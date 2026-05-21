/**
 * Public types for the slack-send-image flow. The 4-call Slack web-API
 * sequence (files.getUploadURL -> binary PUT -> files.completeUpload ->
 * files.share) is the same path the official Slack web client uses; this
 * module is a thin Node port of it.
 *
 * The token is a user-scoped xoxc token (the kind a logged-in browser
 * holds in `localStorage[localConfig_v2]`). Never a bot token. The
 * caller is responsible for obtaining the token; this module never reads
 * cookies, localStorage, or any other credential store.
 */

export type SlackImageUploadConfig = {
  /**
   * Workspace API base URL, e.g. `https://acme.slack.com` for a
   * standard workspace or `https://acme.enterprise.slack.com` for an
   * enterprise grid workspace. Required because enterprise-grid clients
   * route through the workspace subdomain rather than `slack.com`.
   */
  readonly apiBaseUrl: string;
  /**
   * Optional `slack_route` query parameter. Required on enterprise-grid
   * workspaces (typically `<enterprise_id>:<team_id>`); omit on
   * standard workspaces.
   */
  readonly slackRoute?: string;
  /**
   * The xoxc token. Must begin with `xoxc-`. Tokens cycle on the order
   * of 60-90 seconds on enterprise grid, so callers should extract
   * fresh on every send.
   */
  readonly token: string;
};

export type SendImageArgs = {
  readonly config: SlackImageUploadConfig;
  /** Slack channel id (e.g. `C0123456789`). */
  readonly channelId: string;
  /** Optional thread root timestamp; omit to post at the channel root. */
  readonly threadTs?: string;
  /** Message text. Pass already-voice-linted text. */
  readonly text: string;
  /** Absolute filesystem path to the image. PNG/JPEG. */
  readonly imagePath: string;
};

export type SendImageResult = {
  /** Slack file id returned by `files.getUploadURL`. */
  readonly fileId: string;
  /** Timestamp of the channel message that carries the file. */
  readonly fileMsgTs: string;
};
