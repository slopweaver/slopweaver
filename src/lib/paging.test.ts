import { describe, expect, it } from "vitest";
import { type CursorPage, collectCursorPages } from "./paging.js";

/** A plain fake page source (no mocks): serves the queued pages in order, recording the cursors it saw. */
function fakePages<T>({ pages }: { pages: readonly CursorPage<T>[] }): {
  fetchPage: (args: { cursor: string | undefined }) => Promise<CursorPage<T>>;
  seenCursors: (string | undefined)[];
} {
  const seenCursors: (string | undefined)[] = [];
  let call = 0;
  return {
    fetchPage: ({ cursor }) => {
      seenCursors.push(cursor);
      const page = pages[call]!;
      call += 1;
      return Promise.resolve(page);
    },
    seenCursors,
  };
}

describe("collectCursorPages", () => {
  it("returns a single page's items when there is no next cursor", async () => {
    const { fetchPage } = fakePages({ pages: [{ items: ["a", "b"], nextCursor: undefined }] });
    expect(await collectCursorPages({ fetchPage })).toEqual(["a", "b"]);
  });

  it("concatenates multiple pages in order and stops at a missing cursor", async () => {
    const { fetchPage } = fakePages({
      pages: [
        { items: [1, 2], nextCursor: "c1" },
        { items: [3, 4], nextCursor: undefined },
      ],
    });
    expect(await collectCursorPages({ fetchPage })).toEqual([1, 2, 3, 4]);
  });

  it("stops on an empty-string cursor", async () => {
    const { fetchPage } = fakePages({
      pages: [
        { items: ["x"], nextCursor: "" },
        { items: ["should-not-fetch"], nextCursor: undefined },
      ],
    });
    expect(await collectCursorPages({ fetchPage })).toEqual(["x"]);
  });

  it("passes undefined for the first fetch and the prior cursor thereafter", async () => {
    const { fetchPage, seenCursors } = fakePages({
      pages: [
        { items: [1], nextCursor: "next-1" },
        { items: [2], nextCursor: undefined },
      ],
    });
    await collectCursorPages({ fetchPage });
    expect(seenCursors).toEqual([undefined, "next-1"]);
  });

  it("starts from an explicit firstCursor", async () => {
    const { fetchPage, seenCursors } = fakePages({ pages: [{ items: [1], nextCursor: undefined }] });
    await collectCursorPages({ fetchPage, firstCursor: "seed" });
    expect(seenCursors).toEqual(["seed"]);
  });
});
