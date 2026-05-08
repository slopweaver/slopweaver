import type { DiagnosticsResponse } from '../../server/types.ts';

export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await fetch('/api/diagnostics', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/api/diagnostics returned ${res.status}`);
  }
  return (await res.json()) as DiagnosticsResponse;
}

export type { DiagnosticsResponse, EnvCheck, IntegrationStatus } from '../../server/types.ts';
