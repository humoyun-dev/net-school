import { lessonPolicyResponseSchema, policyVersionSchema } from '@netschool/contracts';
import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { parsePatterns } from '../policies/patterns.ts';
import { Button } from '../ui/button.tsx';
import { Field, inputClass } from '../ui/input.tsx';

type Mode = 'off' | 'allowlist' | 'blocklist';
const MODES: Mode[] = ['off', 'allowlist', 'blocklist'];

// Dars web siyosati (o'qituvchi): o'chiq / faqat shu saytlar / shu saytlar bloklangan. Bazaviy blok doim ustun
// (hub va extension tomonida); bu yerda faqat dars qatlami versiyalanadi.
export function WebPolicyControl(props: { lessonId: string }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('off');
  const [text, setText] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    api
      .get(`/api/v1/lessons/${props.lessonId}/policy`, lessonPolicyResponseSchema, abort.signal)
      .then((r) => {
        const doc = r.current?.document as { web?: { mode?: Mode; patterns?: string[] } } | undefined;
        setVersion(r.current?.version ?? 0);
        setMode(doc?.web?.mode ?? 'off');
        setText((doc?.web?.patterns ?? []).join('\n'));
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [api, open, props.lessonId]);

  const save = async () => {
    const parsed = parsePatterns(text);
    if (parsed.invalid !== null) {
      setError(t('policy.invalidPattern', { p: parsed.invalid }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = await api.send(
        'PUT',
        `/api/v1/lessons/${props.lessonId}/policy`,
        { schemaVersion: 1, web: { mode, patterns: parsed.patterns } },
        policyVersionSchema,
        { headers: { 'if-match': String(version) } },
      );
      setVersion(saved.version);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiFailure && err.code === 'conflict' ? t('policy.conflict') : errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative">
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Globe />
        {t('policy.web')}
      </Button>
      {open && (
        <form
          className="absolute right-0 z-20 mt-2 flex w-[320px] flex-col gap-3 rounded-[12px] bg-card p-4 text-foreground shadow-window ring-[0.5px] ring-black/10"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="flex flex-col gap-1.5">
            <legend className="field-label mb-1">{t('policy.web.mode')}</legend>
            {MODES.map((m) => (
              <label key={m} className="flex items-center gap-2 text-[13px]">
                <input type="radio" name="web-mode" checked={mode === m} onChange={() => setMode(m)} />
                {t(`policy.web.mode.${m}`)}
              </label>
            ))}
          </fieldset>
          {mode !== 'off' && (
            <Field label={t('policy.web.patterns')}>
              <textarea
                className={`${inputClass} h-28 py-1.5 font-mono`}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          )}
          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {t('policy.save')}
          </Button>
        </form>
      )}
    </div>
  );
}
