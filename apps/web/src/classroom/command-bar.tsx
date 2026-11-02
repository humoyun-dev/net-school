import { commandSchema, type IssueCommandRequest } from '@netschool/contracts';
import { Lock, LockOpen, Send, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { useIntent } from '../api/intent.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { Button } from '../ui/button.tsx';
import { cn } from '../ui/cn.ts';
import { inputClass } from '../ui/input.tsx';
import { Tooltip } from '../ui/tooltip.tsx';

// "Dock": sahna pastida suzib turadigan buyruqlar paneli. Hammaga yoki tanlanganlarga: xabar, bloklash, ochish.
// Har tugma — alohida niyat (o'z Idempotency-Key'i).
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
  const sendMessage = async () => {
    if (text.trim() && (await message.run(JSON.stringify(messageBody)))) setText('');
  };
  const scoped = props.selected.length > 0;
  return (
    <section className="command-bar sticky bottom-4 z-10 mx-auto mt-8 w-full max-w-[920px]">
      {error ? (
        <p className="mb-2 rounded-[8px] bg-destructive px-3 py-1.5 text-center text-[12px] text-white" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-[16px] bg-card/85 p-2 shadow-window ring-[0.5px] ring-black/10 backdrop-blur-2xl dark:ring-white/10">
        <div
          className={cn(
            'scope flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium',
            scoped ? 'bg-primary text-primary-foreground' : 'bg-hover text-foreground',
          )}
        >
          <Users className="size-3.5" />
          {scoped ? t('cmd.scopeSelected', { n: props.selected.length }) : t('cmd.scopeAll')}
          {scoped && (
            <button
              type="button"
              aria-label={t('grid.clearSelection')}
              onClick={props.onClearSelection}
              className="-mr-1 grid size-5 place-items-center rounded-full hover:bg-white/20"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <form
          className="flex min-w-[220px] flex-[3] items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
        >
          <input
            aria-label={t('cmd.message')}
            placeholder={t('cmd.messagePlaceholder')}
            className={inputClass}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
          <Tooltip label={t('cmd.send')}>
            <Button type="submit" size="icon" aria-label={t('cmd.send')} disabled={!text.trim() || message.pending}>
              <Send />
            </Button>
          </Tooltip>
        </form>
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-separator sm:block" />
        <div className="flex min-w-[260px] flex-[2] items-center gap-1.5">
          <input
            aria-label={t('cmd.lockMessage')}
            placeholder={t('cmd.lockPlaceholder')}
            className={inputClass}
            value={lockText}
            maxLength={200}
            onChange={(e) => setLockText(e.target.value)}
          />
          <Button variant="destructive" disabled={lock.pending} onClick={() => void lock.run(JSON.stringify(lockBody))}>
            <Lock />
            {t('cmd.lock')}
          </Button>
          <Button
            variant="secondary"
            disabled={unlock.pending}
            onClick={() => void unlock.run(JSON.stringify(unlockBody))}
          >
            <LockOpen />
            {t('cmd.unlock')}
          </Button>
        </div>
      </div>
    </section>
  );
}
