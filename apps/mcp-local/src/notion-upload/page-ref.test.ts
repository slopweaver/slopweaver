import { describe, expect, it } from 'vitest';
import { extractFileUuid, normalisePageRef } from './page-ref.ts';

describe('normalisePageRef', () => {
  it('passes a dashed UUID through unchanged', () => {
    const r = normalisePageRef({ pageRef: '367cd3c7-9a56-8160-bb65-cf3e4e419208' });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe('367cd3c7-9a56-8160-bb65-cf3e4e419208');
  });

  it('inserts dashes into a 32-hex undashed string', () => {
    const r = normalisePageRef({ pageRef: '367cd3c79a568160bb65cf3e4e419208' });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe('367cd3c7-9a56-8160-bb65-cf3e4e419208');
  });

  it('extracts the trailing 32-hex from a notion.so URL', () => {
    const r = normalisePageRef({
      pageRef: 'https://www.notion.so/acme/Page-Title-367cd3c79a568160bb65cf3e4e419208',
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe('367cd3c7-9a56-8160-bb65-cf3e4e419208');
  });

  it('rejects an input with fewer than 32 hex chars', () => {
    const r = normalisePageRef({ pageRef: 'not-a-uuid-1234' });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.code).toBe('NOTION_INVALID_PAGE_REF');
      expect(r.error.pageRef).toBe('not-a-uuid-1234');
    }
  });

  it('rejects an empty string', () => {
    const r = normalisePageRef({ pageRef: '' });
    expect(r.isErr()).toBe(true);
  });

  it('is case-insensitive', () => {
    const r = normalisePageRef({ pageRef: '367CD3C7-9A56-8160-BB65-CF3E4E419208' });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe('367cd3c7-9a56-8160-bb65-cf3e4e419208');
  });
});

describe('extractFileUuid', () => {
  it('parses a standard attachment URL', () => {
    expect(
      extractFileUuid({
        attachmentUrl: 'attachment:11111111-2222-3333-4444-555555555555:screenshot.png',
      }),
    ).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('handles filenames that contain colons', () => {
    expect(
      extractFileUuid({
        attachmentUrl: 'attachment:11111111-2222-3333-4444-555555555555:scope:tag:file.png',
      }),
    ).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('returns null when the scheme prefix is wrong', () => {
    expect(extractFileUuid({ attachmentUrl: 'image:11111111-2222:file.png' })).toBeNull();
  });

  it('returns null when there are fewer than three colon-separated segments', () => {
    expect(extractFileUuid({ attachmentUrl: 'attachment:11111111' })).toBeNull();
  });

  it('returns null when the uuid segment is empty', () => {
    expect(extractFileUuid({ attachmentUrl: 'attachment::file.png' })).toBeNull();
  });
});
