/**
 * Notion image-upload flow types. Mirror the 3-call sequence Notion's
 * own web client uses to attach an image to a page block:
 *
 *   1. loadPageChunk    -> discover the page's space_id
 *   2. getUploadFileUrl -> S3 signedPutUrl + attachment URL
 *   3. PUT bytes        -> stores bytes in Notion's S3 bucket
 *   4. saveTransactionsFanout -> creates the image block, appends to page
 *
 * The caller supplies the `token_v2` cookie (and optionally the
 * `notion_user_id` cookie). This module never reads cookies or any
 * other credential store.
 */

export type NotionUploadConfig = {
  /** `token_v2` cookie value from a logged-in Notion browser session. Required. */
  readonly tokenV2: string;
  /** `notion_user_id` cookie value, surfaced as the X-Notion-Active-User-Header. Optional but recommended. */
  readonly userId?: string;
  /** Override the API base for tests. Defaults to `https://www.notion.so`. */
  readonly apiBaseUrl?: string;
};

export type UploadImageArgs = {
  readonly config: NotionUploadConfig;
  /** Page UUID (dashed or undashed) or a notion.so page URL. */
  readonly pageRef: string;
  /** Absolute path to the source PNG / JPEG. */
  readonly imagePath: string;
};

export type UploadImageResult = {
  /** UUID of the newly-created image block. */
  readonly blockId: string;
  /** Notion `attachment:<uuid>:<filename>` URL the block points at. */
  readonly attachmentUrl: string;
  /** The Notion file UUID extracted from `attachmentUrl`. */
  readonly fileUuid: string;
  /** Page URL the caller can open to confirm the image rendered. */
  readonly pageUrl: string;
};
