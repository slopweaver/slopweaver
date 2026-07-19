/**
 * The cursor-paging loop reimplemented across the Linear, Notion, and Slack connectors — "fetch a page,
 * accumulate its items, follow `nextCursor`, stop when it's absent or empty". A higher-order async
 * combinator: the effectful `fetchPage` seam is injected, so the loop's stop semantics are tested with a
 * plain fake page list (no mocks, no network).
 *
 * Source-specific stop logic (Notion's `since` cutoff) stays at the call-site: the adapter returns
 * `nextCursor: undefined` when it wants to stop, and this loop just honours that.
 */

/** One page from a cursor-paged endpoint: its items plus the cursor for the next page (absent ⇒ last). */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

/**
 * Walk every page from `firstCursor` onward, concatenating items in page order. Stops when a page returns
 * an absent or empty `nextCursor` — the union of the connectors' two stop styles (`=== undefined` and
 * `.length > 0`), so neither can paginate forever or drop a page.
 *
 * @param fetchPage the effectful page fetch (`cursor` is `undefined` for the first page)
 * @param firstCursor the cursor to start from (defaults to `undefined` ⇒ first page)
 * @returns every item across all pages, in order
 */
export async function collectCursorPages<T>({
  fetchPage,
  firstCursor = undefined,
}: {
  fetchPage: (args: { cursor: string | undefined }) => Promise<CursorPage<T>>;
  firstCursor?: string | undefined;
}): Promise<readonly T[]> {
  const items: T[] = [];
  let cursor = firstCursor;
  do {
    const page = await fetchPage({ cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);
  return items;
}
