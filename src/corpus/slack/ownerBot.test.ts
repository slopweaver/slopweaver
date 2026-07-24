import { describe, expect, it } from "vitest";

import { resolveOwnerBotToOwner, type SlackOwnerBotIdentity, slackOwnerBotIdentity } from "./ownerBot.js";

const ownerBot: SlackOwnerBotIdentity = {
  appIds: ["A_OWNER_APP"],
  botIds: ["B_OWNER_BOT"],
  botUserIds: ["U_OWNER_BOT"],
  ownerSlackUserId: "U_OWNER",
};

describe("resolveOwnerBotToOwner", () => {
  it("resolves a post by the owner's bot user id back to the owner", () => {
    expect(resolveOwnerBotToOwner({ author: "U_OWNER_BOT", ownerBot, raw: undefined })).toBe("U_OWNER");
  });

  it("resolves by the raw app id back to the owner", () => {
    const raw = { app_id: "A_OWNER_APP", user: "U_OWNER_BOT" };
    expect(resolveOwnerBotToOwner({ author: undefined, ownerBot, raw })).toBe("U_OWNER");
  });

  it("resolves by the raw bot id back to the owner", () => {
    const raw = { bot_id: "B_OWNER_BOT" };
    expect(resolveOwnerBotToOwner({ author: undefined, ownerBot, raw })).toBe("U_OWNER");
  });

  it("does NOT resolve an unrelated third-party bot", () => {
    const raw = { app_id: "A_SOMEONE_ELSE", bot_id: "B_SOMEONE_ELSE", user: "U_TEAMMATE" };
    expect(resolveOwnerBotToOwner({ author: "U_TEAMMATE", ownerBot, raw })).toBeUndefined();
  });

  it("is a no-op when no owner bot is declared", () => {
    expect(resolveOwnerBotToOwner({ author: "U_OWNER_BOT", ownerBot: undefined, raw: undefined })).toBeUndefined();
  });
});

describe("slackOwnerBotIdentity", () => {
  it("defaults absent id lists to empty arrays", () => {
    const built = slackOwnerBotIdentity({ slackBot: { ownerUserId: "U_OWNER" } });
    expect(built).toEqual({ appIds: [], botIds: [], botUserIds: [], ownerSlackUserId: "U_OWNER" });
  });

  it("returns undefined when no declaration is given", () => {
    expect(slackOwnerBotIdentity({ slackBot: undefined })).toBeUndefined();
  });

  it("carries through declared id lists", () => {
    const built = slackOwnerBotIdentity({
      slackBot: { botUserIds: ["U_OWNER_BOT"], ownerUserId: "U_OWNER" },
    });
    expect(built!.botUserIds).toEqual(["U_OWNER_BOT"]);
  });
});
