---
description: Upload a local PNG/JPEG to a Notion page using the user's logged-in browser session cookies (`token_v2`, optional `notion_user_id`). Image renders inline at full resolution. No integration token. No SlopWeaver-side credential storage.
argument-hint: <image-path> [page-id-or-url] [-- optional annotation prompt]
---

This skill writes a screenshot or diagram into a Notion page. It runs the same 3-call sequence the Notion web client uses:

1. `POST /api/v3/loadPageChunk` — discover the target page's `space_id`.
2. `POST /api/v3/getUploadFileUrl` — request a signed S3 PUT URL + attachment record.
3. `PUT <signedPutUrl>` — store the bytes in Notion's S3 bucket.
4. `POST /api/v3/saveTransactionsFanout` — create a new image block on the page, linked to the uploaded file via `file_ids`.

The critical non-obvious bit: `file_ids: [<uuid>]` on the block update args. Without it, Notion renders a broken-image SVG even though the upload succeeded. The SlopWeaver binary handles that.

## Prereqs

- Playwright MCP attached to Claude Code, with a Chrome profile that's logged in to Notion.
- `slopweaver` on the PATH.

## Steps

### 1. (Optional) annotate the image first

If `$ARGUMENTS` contains `-- "<annotation prompt>"`, run the image through `slopweaver annotate-image` first per the `slack-image-draft` skill's step 0. Use the `.annot.png` for the upload.

### 2. Extract the `token_v2` cookie

Drive Playwright at a logged-in Notion tab. Run `browser_evaluate` with this script to extract the cookie and (optional but recommended) the user id:

```js
() => {
  const cookies = document.cookie.split('; ').reduce((acc, c) => {
    const i = c.indexOf('=');
    if (i > 0) acc[c.slice(0, i)] = c.slice(i + 1);
    return acc;
  }, {});
  return { token_v2: cookies.token_v2 ?? null, notion_user_id: cookies.notion_user_id ?? null };
}
```

If `token_v2` comes back `null`, the Playwright profile is not logged in. Navigate to `https://www.notion.so/` and let SSO settle, then re-run the script.

### 3. Resolve the page

If the user gave a page id or URL in `$ARGUMENTS`, normalise it to a dashed UUID (the binary accepts dashed, undashed, or full URL; this is just for the report). If no page was given, pick the user's default findings doc and ask whether to confirm.

### 4. Upload

```bash
slopweaver notion-upload-image \
  --page "<page-id-or-url>" \
  --image "<image-path>" \
  --token-v2 "<token-from-step-2>" \
  [--user-id "<user-id-from-step-2>"]
```

The binary reads `NOTION_TOKEN_V2`, `NOTION_USER_ID`, and `SLOPWEAVER_NOTION_API_BASE` from the environment when the flags are absent.

On success it prints:

```
notion-upload-image: ok block=<block-uuid> file=<file-uuid> page=<page-url> input=<page-ref-as-given>
```

### 5. Verify

Optionally call the Playwright MCP `browser_navigate` on the page URL, then `browser_evaluate` to grep for the block id. If the block renders an `img` with `naturalWidth > 50` and no `.photoExclamation` icon, the upload worked.

## Failure modes

- `NOTION_INVALID_PAGE_REF` (exit 2): the page id couldn't be parsed. Pass either a dashed UUID, a 32-hex string, or a notion.so URL.
- `NOTION_LOAD_CHUNK_FAILED` with HTTP 401: token_v2 expired. Re-extract from a fresh Notion tab.
- `NOTION_LOAD_CHUNK_FAILED` with "space_id not found": the page id is wrong, or the token doesn't have access to that page.
- `NOTION_UPLOAD_URL_FAILED`: rare; usually a stale token or a workspace-tier-specific bucket policy. Re-extract and retry.
- `NOTION_BYTES_UPLOAD_FAILED`: the signed PUT to Notion's S3 was rejected. Often transient; retry once. If persistent, the signedPutUrl might have expired (they're short-lived).
- `NOTION_SAVE_TRANSACTIONS_FAILED`: the block-creation call failed. The image bytes are uploaded but no block points at them. Re-running the skill creates a fresh block and orphans the previous file.

## Notes

- The 3-call sequence matches what the Notion web client does. Nothing here exploits an undocumented API. `token_v2` is a workspace user cookie; the user is acting as themselves.
- The skill never reads cookies directly from disk. The user's browser supplies them via Playwright `browser_evaluate`, then SlopWeaver consumes them.
- `file_ids` is the load-bearing field. The binary always sets it; this is documented in the `transaction-body.test.ts` test "writes file_ids on the block update args (the broken-image fix)".
