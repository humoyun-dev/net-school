import {
  baselinePolicyResponseSchema,
  type PolicyVersion,
  policyVersionSchema,
  policyVersionsResponseSchema,
  siteSchema,
} from '@netschool/contracts';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { RequireRole } from '../auth/require-role.tsx';
import { isOrgAdmin, useMe } from '../auth/session.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { Toolbar } from '../layout/toolbar.tsx';
import { Button } from '../ui/button.tsx';
import { Field, inputClass, Select } from '../ui/input.tsx';
import { Section } from '../ui/section.tsx';
import { parsePatterns } from './patterns.ts';

const sitesSchema = z.object({ sites: z.array(siteSchema) });

type Effective = z.infer<typeof baselinePolicyResponseSchema>['effective'];
interface Form {
  blocked: string;
  managed: boolean;
  incognito: boolean;
  devTools: boolean;
  standardUser: boolean;
  blockAppInstall: boolean;
  lockWallpaper: boolean;
}

// Hujjat (faqat shu ko'lamning o'zi) → forma; meros qolgan qiymatlar alohida "amaldagi" ro'yxatda ko'rinadi.
function formOf(doc: unknown): Form {
  const d = (doc ?? {}) as {
    web?: { blocked?: string[] };
    browser?: { managed?: boolean; incognito?: string; devTools?: string };
    os?: { standardUser?: boolean; blockAppInstall?: boolean; lockWallpaper?: boolean };
  };
  return {
    blocked: (d.web?.blocked ?? []).join('\n'),
    managed: d.browser?.managed === true,
    incognito: d.browser?.incognito === 'disabled',
    devTools: d.browser?.devTools === 'disabled',
    standardUser: d.os?.standardUser === true,
    blockAppInstall: d.os?.blockAppInstall === true,
    lockWallpaper: d.os?.lockWallpaper === true,
  };
}

export function PoliciesPage() {
  return (
    <RequireRole anyOf={['school_admin', 'it_support']}>
      <PoliciesPanel />
    </RequireRole>
  );
}

function PoliciesPanel() {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const me = useMe();
  const orgWide = isOrgAdmin(me);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [current, setCurrent] = useState<PolicyVersion | null>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [form, setForm] = useState<Form>(formOf(null));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const query = siteId ? `?siteId=${siteId}` : '';

  useEffect(() => {
    const abort = new AbortController();
    api
      .get('/api/v1/sites', sitesSchema, abort.signal)
      .then((r) => {
        setSites(r.sites);
        if (!orgWide) setSiteId((s) => s ?? r.sites[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [api, orgWide]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!orgWide && siteId === null) return;
      const [base, list] = await Promise.all([
        api.get(`/api/v1/policies/baseline${query}`, baselinePolicyResponseSchema, signal),
        api.get(`/api/v1/policies/baseline/versions${query}`, policyVersionsResponseSchema, signal),
      ]);
      setCurrent(base.current);
      setEffective(base.effective);
      setForm(formOf(base.current?.document));
      setVersions(list.versions);
    },
    [api, query, orgWide, siteId],
  );
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal).catch(() => undefined);
    return () => abort.abort();
  }, [load]);

  const fail = (err: unknown) => {
    const conflict = err instanceof ApiFailure && err.code === 'conflict';
    setMessage({ tone: 'error', text: conflict ? t('policy.conflict') : errorText(err) });
  };

  const save = async () => {
    const parsed = parsePatterns(form.blocked);
    if (parsed.invalid !== null) {
      setMessage({ tone: 'error', text: t('policy.invalidPattern', { p: parsed.invalid }) });
      return;
    }
    const body = {
      schemaVersion: 1,
      web: { blocked: parsed.patterns },
      browser: {
        managed: form.managed,
        incognito: form.incognito ? 'disabled' : 'allowed',
        devTools: form.devTools ? 'disabled' : 'allowed',
      },
      os: { standardUser: form.standardUser, blockAppInstall: form.blockAppInstall, lockWallpaper: form.lockWallpaper },
    };
    setPending(true);
    try {
      const saved = await api.send('PUT', `/api/v1/policies/baseline${query}`, body, policyVersionSchema, {
        headers: { 'if-match': String(current?.version ?? 0) },
      });
      setMessage({ tone: 'ok', text: t('policy.saved', { v: saved.version }) });
      setCurrent(saved);
      await load().catch(() => undefined);
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  const restore = async (v: PolicyVersion) => {
    setPending(true);
    try {
      const saved = await api.send(
        'POST',
        `/api/v1/policies/baseline/versions/${v.id}/restore`,
        undefined,
        policyVersionSchema,
        {
          headers: { 'if-match': String(current?.version ?? 0) },
        },
      );
      setMessage({ tone: 'ok', text: t('policy.saved', { v: saved.version }) });
      await load().catch(() => undefined);
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  const check = (key: keyof Form, label: string) => (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={form[key] as boolean}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
      />
      {label}
    </label>
  );

  return (
    <>
      <Toolbar title={t('policy.title')} subtitle={t('policy.subtitle')}>
        <Select
          aria-label={t('policy.scope')}
          value={siteId ?? ''}
          onChange={(e) => {
            setMessage(null);
            setSiteId(e.target.value === '' ? null : e.target.value);
          }}
        >
          {orgWide && <option value="">{t('policy.scope.org')}</option>}
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Toolbar>
      <div className="mx-auto grid w-full max-w-[920px] gap-5 p-5 md:grid-cols-[1fr_260px]">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Section title={t('policy.web')}>
            <Field label={t('policy.blocked')}>
              <textarea
                className={`${inputClass} h-32 py-1.5 font-mono`}
                value={form.blocked}
                onChange={(e) => setForm((f) => ({ ...f, blocked: e.target.value }))}
              />
            </Field>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('policy.blockedHint')}</p>
          </Section>
          <Section title={t('policy.browser')}>
            <div className="flex flex-col gap-2">
              {check('managed', t('policy.managed'))}
              {check('incognito', t('policy.incognito'))}
              {check('devTools', t('policy.devTools'))}
            </div>
          </Section>
          <Section title={t('policy.os')}>
            <p className="mb-2 text-[11px] text-muted-foreground">{t('policy.osHint')}</p>
            <div className="flex flex-col gap-2">
              {check('standardUser', t('policy.os.standardUser'))}
              {check('blockAppInstall', t('policy.os.blockAppInstall'))}
              {check('lockWallpaper', t('policy.os.lockWallpaper'))}
            </div>
          </Section>
          {message ? (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={message.tone === 'error' ? 'text-[12px] text-destructive' : 'text-[12px] text-success'}
            >
              {message.text}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="self-start">
            {t('policy.save')}
          </Button>
        </form>
        <aside className="flex flex-col gap-5">
          {effective && siteId !== null && (
            <Section title={t('policy.effective')}>
              <ul className="text-[12px] text-muted-foreground">
                {effective.web.blocked.map((p) => (
                  <li key={p} className="font-mono">
                    {p}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={t('policy.versions')}>
            {versions.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">{t('policy.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="tabular">
                      v{v.version} · {new Date(v.createdAt).toLocaleString()}
                      {v.restoredFrom ? ` · ${t('policy.restoredFrom')}` : ''}
                    </span>
                    {v.version !== current?.version && (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => void restore(v)}>
                        {t('policy.restore', { v: v.version })}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </>
  );
}
