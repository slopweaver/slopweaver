/**
 * Me-to-me resolution (PR4.5): the owner's OWN bot posts under a bot identity, so a message the bot sent
 * would otherwise read as authored by "a bot", not by the owner — and a thread the bot answered would
 * look still-owed-by-owner. This maps the owner's bot identity back to the owner's Slack user id at
 * projection time, so owner-scoped retrieval ("what's assigned to me", "threads I answered") resolves
 * correctly. A THIRD-party bot never matches — only the ids declared for the owner's own bot.
 *
 * Pure. The bot identity is declared in `profile.json` (see {@link ../../profile.Profile.slackBot}); an
 * absent declaration makes this a no-op, so the whole feature is additive and off by default.
 */
import { isRecord } from "../../lib/parsers.js";

/**
 * The owner's own Slack bot identity, matched on any of the four ids Slack can attribute a bot post to:
 * the resolved `user`, the app id, the bot-user id, and the internal bot id.
 */
export interface SlackOwnerBotIdentity {
  /** The owner's human Slack user id — what a matched bot post resolves TO. */
  readonly ownerSlackUserId: string;
  /** Bot-user ids the owner's bot posts as (`Uxxx`/`Bxxx`). */
  readonly botUserIds: readonly string[];
  /** App ids of the owner's bot (`raw.app_id`). */
  readonly appIds: readonly string[];
  /** Internal bot ids of the owner's bot (`raw.bot_id`). */
  readonly botIds: readonly string[];
}

/** The persona seed's optional owner-bot declaration (kept structural so this module never imports Profile). */
export interface SlackBotDeclaration {
  readonly ownerUserId: string;
  readonly botUserIds?: readonly string[];
  readonly appIds?: readonly string[];
  readonly botIds?: readonly string[];
}

/**
 * Build the owner-bot identity from the persona seed's `slackBot` declaration, defaulting each id list to
 * empty. `undefined` in ⇒ `undefined` out (me-to-me stays off). Pure.
 *
 * @param slackBot the profile's `slackBot` declaration, when set
 * @returns the owner-bot identity, or `undefined`
 */
export function slackOwnerBotIdentity({
  slackBot,
}: {
  slackBot: SlackBotDeclaration | undefined;
}): SlackOwnerBotIdentity | undefined {
  if (slackBot === undefined) {
    return undefined;
  }
  return {
    appIds: slackBot.appIds ?? [],
    botIds: slackBot.botIds ?? [],
    botUserIds: slackBot.botUserIds ?? [],
    ownerSlackUserId: slackBot.ownerUserId,
  };
}

/** Whether `value` (a raw payload field) is a non-empty string present in `set`. Pure. */
function matchesId({ value, set }: { value: unknown; set: readonly string[] }): boolean {
  return typeof value === "string" && value.length > 0 && set.includes(value);
}

/**
 * Resolve a record's author back to the owner when it was posted by the owner's own bot — else `undefined`
 * (leave the author unchanged). Matches the author/`user`, `app_id`, or `bot_id` of the raw Slack payload
 * against the declared owner-bot ids. A third-party bot matches none of them, so it is never rewritten.
 *
 * @param author the record's author (the raw Slack `user` id), when known
 * @param raw the record's raw Slack payload (carries `app_id`/`bot_id`), when kept
 * @param ownerBot the owner's declared bot identity, when configured
 * @returns the owner's Slack user id when the post is the owner's bot, else `undefined`
 */
export function resolveOwnerBotToOwner({
  author,
  raw,
  ownerBot,
}: {
  author: string | undefined;
  raw: Readonly<Record<string, unknown>> | undefined;
  ownerBot: SlackOwnerBotIdentity | undefined;
}): string | undefined {
  if (ownerBot === undefined) {
    return undefined;
  }
  const rawObj = isRecord(raw) ? raw : {};
  const isOwnerBot =
    matchesId({ set: ownerBot.botUserIds, value: author }) ||
    matchesId({ set: ownerBot.botUserIds, value: rawObj["user"] }) ||
    matchesId({ set: ownerBot.appIds, value: rawObj["app_id"] }) ||
    matchesId({ set: ownerBot.botIds, value: rawObj["bot_id"] });
  return isOwnerBot ? ownerBot.ownerSlackUserId : undefined;
}
