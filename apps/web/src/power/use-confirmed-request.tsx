import { type PowerActionType, type PowerPreview, type PowerScope, powerPreviewSchema } from '@netschool/contracts';
import { useRef, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { createIntent } from '../api/intent.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';

// Preview → tasdiq oynasi → yuborish. 409 confirmation_required: son o'zgargan — preview yangilanadi, qayta yoziladi.
export function useConfirmedRequest(submit: (count: number, key: string) => Promise<unknown>, onDone: () => void) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const [open, setOpen] = useState<{ type: PowerActionType; scope: PowerScope; preview: PowerPreview } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const countRef = useRef(0);
  // Bitta tasdiq oynasi — bitta niyat: tarmoq xatosidan keyin qayta bosish o'sha Idempotency-Key bilan.
  const intent = useRef(createIntent<unknown>((key) => submitRef.current(countRef.current, key)));

  async function preview(type: PowerActionType, scope: PowerScope) {
    setError(null);
    try {
      const p = await api.send('POST', '/api/v1/power-actions/preview', { type, scope }, powerPreviewSchema);
      intent.current = createIntent<unknown>((key) => submitRef.current(countRef.current, key));
      setOpen({ type, scope, preview: p });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function confirm(count: number) {
    if (!open) return;
    setPending(true);
    setError(null);
    countRef.current = count;
    try {
      await intent.current.run();
      setOpen(null);
      onDone();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'confirmation_required') {
        await preview(open.type, open.scope);
        setError(t('error.confirmation_required'));
      } else {
        setError(errorText(err));
      }
    } finally {
      setPending(false);
    }
  }

  const dialog = open ? (
    <ConfirmDialog
      title={t('power.confirm.title', { type: t(`power.type.${open.type}`) })}
      preview={open.preview}
      pending={pending}
      error={error}
      onConfirm={(count) => void confirm(count)}
      onCancel={() => setOpen(null)}
    />
  ) : null;
  return { preview, dialog, error: open ? null : error };
}
