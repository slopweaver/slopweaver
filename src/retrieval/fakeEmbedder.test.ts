import { describe, expect, it } from "vitest";
import { fakeConceptEmbedder } from "./fakeEmbedder.js";
import { cosine } from "./vectorIndex.js";

describe("fakeConceptEmbedder", () => {
  it("embeds same-concept text close and different-concept text apart", async () => {
    const [auth] = await fakeConceptEmbedder.embedDocuments(["login and session token"]);
    const [authQuery] = await fakeConceptEmbedder.embedQuery(["oauth credential"]);
    const [deploy] = await fakeConceptEmbedder.embedDocuments(["release the build pipeline"]);
    expect(cosine({ a: auth!, b: authQuery! })).toBeGreaterThan(0.9);
    expect(cosine({ a: auth!, b: deploy! })).toBeLessThan(0.5);
  });
});
