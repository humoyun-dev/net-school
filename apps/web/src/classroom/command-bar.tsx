import { commandSchema, type IssueCommandRequest } from '@netschool/contracts';
import { useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { useIntent } from '../api/intent.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';

// Hammaga yoki tanlanganlarga: xabar, bloklash, ochish. Har tugma — alohida niyat (o'z Idempotency-Key'i).
export function CommandBar(props: { lessonId: string; selected: string[]; onClearSelection: () => void }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const [text, setText] = useState('');
  const [lockText, setLockText] = useState('');
  const targets = props.selected.length > 0 ? { targetDeviceIds: props.selected } : {};
  const issue = (body: IssueCommandRequest) => (key: string) =>
    api.send('POST', `/api/v1/lessons/${props.lessonId}/commands`, body, commandSchema, { idempotencyKey: key });
  const messageBody: IssueCommandRequest = { type: 'message.show', payload: { text: text.trim() }, ...targets };
  const lockBody: IssueCommandRequest = {
    type: 'overlay.lock',
    payload: lockText.trim() ? { message: lockText.trim() } : {},
    ...targets,
  };
  const unlockBody: IssueCommandRequest = { type: 'overlay.unlock', payload: {}, ...targets };
  const message = useIntent(issue(messageBody));
  const lock = useIntent(issue(lockBody));
  const unlock = useIntent(issue(unlockBody));
  const error = message.error ?? lock.error ?? unlock.error;
  return (
    <section className="card command-bar">
      <p className="scope">
        {props.selected.length > 0 ? t('cmd.scopeSelected', { n: props.selected.length }) : t('cmd.scopeAll')}
        {props.selected.length > 0 && (
          <button type="button" className="link" onClick={props.onClearSelection}>
            {t('grid.clearSelection')}
          </button>
        )}
      </p>
      <div className="row">
        <label className="grow">
          {t('cmd.message')}
          <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!text.trim() || message.pending}
          onClick={async () => {
            if (await message.run(JSON.stringify(messageBody))) setText('');
          }}
        >
          {t('cmd.send')}
        </button>
      </div>
      <div className="row">
        <label className="grow">
          {t('cmd.lockMessage')}
          <input value={lockText} maxLength={200} onChange={(e) => setLockText(e.target.value)} />
        </label>
        <button
          type="button"
          className="danger"
          disabled={lock.pending}
          onClick={() => void lock.run(JSON.stringify(lockBody))}
        >
          {t('cmd.lock')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={unlock.pending}
          onClick={() => void unlock.run(JSON.stringify(unlockBody))}
        >
          {t('cmd.unlock')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
    </section>
  );
}
