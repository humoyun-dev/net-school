import { type PowerActionType, type PowerScope, powerActionSchema } from '@netschool/contracts';
import { useCallback, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { RequireRole } from '../auth/require-role.tsx';
import { isOrgAdmin, useMe } from '../auth/session.tsx';
import { useT } from '../i18n/i18n.tsx';
import { ActionDetail } from './action-detail.tsx';
import { ActionList } from './action-list.tsx';
import { Schedules } from './schedules.tsx';
import { ScopePicker } from './scope-picker.tsx';
import { TypePicker } from './type-picker.tsx';
import { useConfirmedRequest } from './use-confirmed-request.tsx';

export function PowerPage() {
  return (
    <RequireRole anyOf={['school_admin', 'it_support']}>
      <PowerPanel />
    </RequireRole>
  );
}

function PowerPanel() {
  const t = useT();
  const me = useMe();
  const orgWide = isOrgAdmin(me);
  const [tab, setTab] = useState<'actions' | 'schedules'>('actions');
  return (
    <section>
      <h1>{t('power.title')}</h1>
      <div role="tablist" className="tabs">
        <button type="button" role="tab" aria-selected={tab === 'actions'} onClick={() => setTab('actions')}>
          {t('power.tab.actions')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'schedules'} onClick={() => setTab('schedules')}>
          {t('power.tab.schedules')}
        </button>
      </div>
      {tab === 'actions' ? <Actions orgWide={orgWide} /> : <Schedules orgWide={orgWide} />}
    </section>
  );
}

function Actions(props: { orgWide: boolean }) {
  const api = useApi();
  const t = useT();
  const [type, setType] = useState<PowerActionType>('shutdown');
  const [scope, setScope] = useState<PowerScope | null>(null);
  const [when, setWhen] = useState<'now' | 'at'>('now');
  const [at, setAt] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);
  const onScope = useCallback((s: PowerScope | null) => setScope(s), []);
  const runAt = when === 'at' && at ? new Date(at).toISOString() : undefined;
  const request = useConfirmedRequest(
    async (count, key) => {
      const created = await api.send(
        'POST',
        '/api/v1/power-actions',
        { type, scope, ...(runAt ? { runAt } : {}), confirmDeviceCount: count },
        powerActionSchema,
        { idempotencyKey: key },
      );
      setOpened(created.id);
      return created;
    },
    () => setRefresh((n) => n + 1),
  );

  return (
    <div className="power-columns">
      <form
        className="card power-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (scope) void request.preview(type, scope);
        }}
      >
        <h2>{t('power.tab.new')}</h2>
        <TypePicker value={type} onChange={setType} />
        <ScopePicker orgWide={props.orgWide} onChange={onScope} />
        <fieldset>
          <legend>{t('power.when')}</legend>
          <label className="inline">
            <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />
            {t('power.now')}
          </label>
          <label className="inline">
            <input type="radio" name="when" checked={when === 'at'} onChange={() => setWhen('at')} />
            {t('power.at')}
          </label>
          {when === 'at' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />}
        </fieldset>
        <button type="submit" disabled={!scope || (when === 'at' && !at)}>
          {t('power.continue')}
        </button>
        {request.error && <p className="error">{request.error}</p>}
      </form>
      <div>
        {opened ? (
          <ActionDetail id={opened} onBack={() => setOpened(null)} />
        ) : (
          <ActionList key={refresh} onOpen={setOpened} />
        )}
      </div>
      {request.dialog}
    </div>
  );
}
