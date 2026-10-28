// Spec §9: typed buyruqlar va har qurilma uchun alohida natija.
export type CommandType = 'message.show' | 'overlay.lock' | 'overlay.unlock';

export const COMMAND_CAPABILITY: Record<CommandType, string> = {
  'message.show': 'classroom.message',
  'overlay.lock': 'classroom.overlay',
  'overlay.unlock': 'classroom.overlay',
};

export type TargetStatus = 'pending' | 'sent' | 'acknowledged' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export type FailureReason = 'unsupported' | 'permission_required' | 'error';

export const TERMINAL: ReadonlySet<TargetStatus> = new Set(['succeeded', 'failed', 'expired', 'cancelled']);

export type Gate = { status: 'pending' } | { status: 'failed'; reason: 'unsupported' | 'permission_required' };

// Qurilma capability hisobotidan target'ning boshlang'ich holati.
export function gateTarget(type: CommandType, capabilities: Record<string, { state: string }> | null): Gate {
  const state = capabilities?.[COMMAND_CAPABILITY[type]]?.state;
  if (state === 'available') return { status: 'pending' };
  if (state === 'requires_permission') return { status: 'failed', reason: 'permission_required' };
  return { status: 'failed', reason: 'unsupported' };
}

export type ReceiptStatus = 'acknowledged' | 'succeeded' | 'failed';
export type Transition = { kind: 'apply'; to: TargetStatus } | { kind: 'noop' } | { kind: 'reject' };

// pending → sent → acknowledged → succeeded | failed; terminal holatdan chiqish yo'q.
export function applyReceipt(current: TargetStatus, receipt: ReceiptStatus): Transition {
  if (TERMINAL.has(current)) return current === receipt ? { kind: 'noop' } : { kind: 'reject' };
  if (receipt === 'acknowledged') return current === 'acknowledged' ? { kind: 'noop' } : { kind: 'apply', to: receipt };
  return { kind: 'apply', to: receipt };
}
