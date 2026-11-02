import { type PowerActionType, type PowerScope, powerActionSchema } from '@netschool/contracts';
import { useCallback, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { RequireRole } from '../auth/require-role.tsx';
import { isOrgAdmin, useMe } from '../auth/session.tsx';
import { useT } from '../i18n/i18n.tsx';
import { Toolbar } from '../layout/toolbar.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { ChoiceRow, Section } from '../ui/section.tsx';
import { Segmented } from '../ui/segmented.tsx';
import { ActionDetail } from './action-detail.tsx';
import { ActionList } from './action-list.tsx';
import { PowerColumns } from './power-columns.tsx';
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
    <>
      <Toolbar title={t('power.title')} subtitle={t('power.subtitle')}>
        <Segmented
          label={t('power.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'actions', label: t('power.tab.actions') },
            { value: 'schedules', label: t('power.tab.schedules') },
          ]}
        />
      </Toolbar>
      {tab === 'actions' ? <Actions orgWide={orgWide} /> : <Schedules orgWide={orgWide} />}
    </>
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
    <PowerColumns
      form={
        <form
          className="power-form flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (scope) void request.preview(type, scope);
          }}
        >
          <h2 className="font-display text-[15px] font-semibold">{t('power.tab.new')}</h2>
          <TypePicker value={type} onChange={setType} />
          <ScopePicker orgWide={props.orgWide} onChange={onScope} />
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">{t('power.when')}</legend>
            <Section title={t('power.when')}>
              <ChoiceRow
                control={<input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />}
              >
                {t('power.now')}
              </ChoiceRow>
              <ChoiceRow
                control={<input type="radio" name="when" checked={when === 'at'} onChange={() => setWhen('at')} />}
                trailing={
                  when === 'at' && (
                    <Input
                      type="datetime-local"
                      className="w-auto"
                      value={at}
                      onChange={(e) => setAt(e.target.value)}
                      required
                    />
                  )
                }
              >
                {t('power.at')}
              </ChoiceRow>
            </Section>
          </fieldset>
          {request.error && (
            <p className="text-[12px] text-destructive" role="alert">
              {request.error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!scope || (when === 'at' && !at)}>
              {t('power.continue')}
            </Button>
          </div>
        </form>
      }
    >
      {opened ? (
        <ActionDetail id={opened} onBack={() => setOpened(null)} />
      ) : (
        <ActionList key={refresh} onOpen={setOpened} />
      )}
      {request.dialog}
    </PowerColumns>
  );
}
