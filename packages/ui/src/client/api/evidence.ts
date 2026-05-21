import type { EvidenceTailResponse } from '../../server/evidence.ts';

export async function fetchEvidenceTail(): Promise<EvidenceTailResponse> {
  const res = await fetch('/api/evidence', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/api/evidence returned ${res.status}`);
  }
  return (await res.json()) as EvidenceTailResponse;
}

export type { EvidenceTailResponse, EvidenceTailRow } from '../../server/evidence.ts';
