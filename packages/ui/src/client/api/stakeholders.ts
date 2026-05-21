import type { StakeholdersResponse } from '../../server/stakeholders.ts';

export async function fetchStakeholders(): Promise<StakeholdersResponse> {
  const res = await fetch('/api/stakeholders', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/api/stakeholders returned ${res.status}`);
  }
  return (await res.json()) as StakeholdersResponse;
}

export type { StakeholdersResponse, StakeholderEntry } from '../../server/stakeholders.ts';
