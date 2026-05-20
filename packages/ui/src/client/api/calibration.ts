import type { CalibrationResponse } from '../../server/calibration.ts';

export async function fetchCalibration(): Promise<CalibrationResponse> {
  const res = await fetch('/api/calibration', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/api/calibration returned ${res.status}`);
  }
  return (await res.json()) as CalibrationResponse;
}

export type { CalibrationResponse, CalibrationPoint, FrictionTagTally } from '../../server/calibration.ts';
