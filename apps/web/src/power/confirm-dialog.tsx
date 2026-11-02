import type { PowerPreview } from '@netschool/contracts';
import { useState } from 'react';
import { useT } from '../i18n/i18n.tsx';

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
    <div className="modal-backdrop">
      <div className="card modal" role="dialog" aria-label={props.title}>
        <h2>{props.title}</h2>
        {preview.deviceCount === 0 ? (
          <p>{t('power.confirm.none')}</p>
        ) : (
          <ul className="facts">
            <li>
              <strong>{t('power.confirm.count', { n: preview.deviceCount })}</strong>
            </li>
            {preview.unbound > 0 && <li>{t('power.confirm.unbound', { n: preview.unbound })}</li>}
            <li>
              {preview.agentOnline === null || preview.agentOffline === null
                ? t('power.confirm.noMesh')
                : t('power.confirm.agents', { on: preview.agentOnline, off: preview.agentOffline })}
            </li>
          </ul>
        )}
        {many && (
          <label>
            {t('power.confirm.typeCount')}
            <input inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={!ready || props.pending}
            onClick={() => props.onConfirm(preview.deviceCount)}
          >
            {t('common.confirm')}
          </button>
          <button type="button" className="secondary" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
