import type { PowerAction } from '@netschool/contracts';

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const ACTION_TONE: Record<PowerAction['status'], Tone> = {
  scheduled: 'info',
  running: 'info',
  completed: 'success',
  cancelled: 'neutral',
  missed: 'warning',
};

export const TARGET_TONE: Record<string, Tone> = {
  pending: 'neutral',
  sent: 'info',
  succeeded: 'success',
  failed: 'danger',
  unknown: 'warning',
  cancelled: 'neutral',
};
