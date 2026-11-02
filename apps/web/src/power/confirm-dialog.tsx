import type { PowerPreview } from '@netschool/contracts';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n/i18n.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog.tsx';
import { Field, Input } from '../ui/input.tsx';

// Ko'p qurilmali amal: admin sonni qo'lda yozadi, faqat aynan teng bo'lsa tasdiqlash yoqiladi (spec §7.1).
export function ConfirmDialog(props: {
  title: string;
  preview: PowerPreview;
  pending: boolean;
  error: string | null;
  onConfirm: (count: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const { preview } = props;
  // Son o'zgarsa (409 confirmation_required) yozilgani tozalanadi: admin yangi sonni qayta yozadi.
  const [seen, setSeen] = useState(preview);
  if (seen !== preview) {
    setSeen(preview);
    setTyped('');
  }
  const many = preview.deviceCount > 1;
  const ready = preview.deviceCount > 0 && (!many || typed.trim() === String(preview.deviceCount));
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent aria-describedby={undefined} className="modal flex flex-col items-center text-center">
        <span className="grid size-12 place-items-center rounded-[12px] bg-warning/16 text-warning">
          <TriangleAlert className="size-6" />
        </span>
        <DialogTitle className="mt-3">{props.title}</DialogTitle>
        {preview.deviceCount === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">{t('power.confirm.none')}</p>
        ) : (
          <ul className="facts mt-2 flex flex-col gap-0.5 text-[13px]">
            <li>
              <strong className="tabular font-semibold">{t('power.confirm.count', { n: preview.deviceCount })}</strong>
            </li>
            {preview.unbound > 0 && (
              <li className="text-muted-foreground">{t('power.confirm.unbound', { n: preview.unbound })}</li>
            )}
            <li className="text-muted-foreground">
              {preview.agentOnline === null || preview.agentOffline === null
                ? t('power.confirm.noMesh')
                : t('power.confirm.agents', { on: preview.agentOnline, off: preview.agentOffline })}
            </li>
          </ul>
        )}
        {many && (
          <Field label={t('power.confirm.typeCount')} className="mt-4 w-full text-left">
            <Input inputMode="numeric" className="tabular" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        )}
        {props.error && (
          <p className="mt-3 text-[12px] text-destructive" role="alert">
            {props.error}
          </p>
        )}
        <DialogFooter className="w-full">
          <Button variant="secondary" className="flex-1" onClick={props.onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            disabled={!ready || props.pending}
            onClick={() => props.onConfirm(preview.deviceCount)}
          >
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
