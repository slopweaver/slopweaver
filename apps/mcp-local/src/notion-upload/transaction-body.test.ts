import { describe, expect, it } from 'vitest';
import { buildSaveTransactionsBody } from './transaction-body.ts';

describe('buildSaveTransactionsBody', () => {
  const baseArgs = {
    pageId: '367cd3c7-9a56-8160-bb65-cf3e4e419208',
    spaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    attachmentUrl: 'attachment:11111111-2222-3333-4444-555555555555:photo.png',
    fileUuid: '11111111-2222-3333-4444-555555555555',
    newBlockId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    requestId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    transactionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    nowMs: 1_700_000_000_000,
  };

  it('places the new block update operation first', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const ops = body.transactions[0]?.operations ?? [];
    expect((ops[0] as { command: string }).command).toBe('update');
  });

  it('writes file_ids on the block update args (the broken-image fix)', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const updateOp = body.transactions[0]?.operations[0] as { args: { file_ids: string[] } };
    expect(updateOp.args.file_ids).toEqual([baseArgs.fileUuid]);
  });

  it('points the new image block at the attachment URL twice (properties.source + format.display_source)', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const updateOp = body.transactions[0]?.operations[0] as {
      args: { properties: { source: string[][] }; format: { display_source: string } };
    };
    expect(updateOp.args.properties.source).toEqual([[baseArgs.attachmentUrl]]);
    expect(updateOp.args.format.display_source).toBe(baseArgs.attachmentUrl);
  });

  it('parents the new block under the page', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const updateOp = body.transactions[0]?.operations[0] as {
      args: { parent_id: string; parent_table: string; space_id: string };
    };
    expect(updateOp.args.parent_id).toBe(baseArgs.pageId);
    expect(updateOp.args.parent_table).toBe('block');
    expect(updateOp.args.space_id).toBe(baseArgs.spaceId);
  });

  it('appends the new block to the page content via listAfter', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const listAfterOp = body.transactions[0]?.operations[1] as {
      pointer: { id: string };
      command: string;
      path: string[];
      args: { id: string };
    };
    expect(listAfterOp.pointer.id).toBe(baseArgs.pageId);
    expect(listAfterOp.command).toBe('listAfter');
    expect(listAfterOp.path).toEqual(['content']);
    expect(listAfterOp.args.id).toBe(baseArgs.newBlockId);
  });

  it('updates the page last_edited_time to nowMs', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    const lastEditedOp = body.transactions[0]?.operations[2] as { args: number };
    expect(lastEditedOp.args).toBe(baseArgs.nowMs);
  });

  it('uses the provided requestId and transactionId', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    expect(body.requestId).toBe(baseArgs.requestId);
    expect(body.transactions[0]?.id).toBe(baseArgs.transactionId);
  });

  it('tags the transaction with a SlopWeaver debug.userAction so retries are attributable', () => {
    const body = buildSaveTransactionsBody(baseArgs);
    expect(body.transactions[0]?.debug.userAction).toContain('slopweaver');
  });
});
