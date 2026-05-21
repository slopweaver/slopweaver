import { describe, expect, it } from 'vitest';
import { safeCitationUrl } from './shape-evidence.ts';

describe('safeCitationUrl', () => {
  it('returns null for null input', () => {
    expect(safeCitationUrl(null)).toBe(null);
  });

  it('returns null for empty-string input', () => {
    expect(safeCitationUrl('')).toBe(null);
  });

  it('returns the URL unchanged for an absolute https URL', () => {
    expect(safeCitationUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('returns the URL unchanged for an absolute http URL', () => {
    expect(safeCitationUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('returns null for a malformed URL', () => {
    expect(safeCitationUrl('not a url')).toBe(null);
  });

  it('returns null for a `javascript:` URL (XSS vector)', () => {
    expect(safeCitationUrl('javascript:alert(1)')).toBe(null);
  });

  it('returns null for a `data:` URL', () => {
    expect(safeCitationUrl('data:text/html,<script>alert(1)</script>')).toBe(null);
  });

  it('returns null for a `file:` URL', () => {
    expect(safeCitationUrl('file:///etc/passwd')).toBe(null);
  });

  it('returns null for a `chrome:` URL', () => {
    expect(safeCitationUrl('chrome://settings')).toBe(null);
  });

  it('returns null for an `ftp:` URL', () => {
    expect(safeCitationUrl('ftp://example.com/file')).toBe(null);
  });
});
