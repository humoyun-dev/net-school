import { type PowerActionType, type PowerSchedule, type PowerScope, powerScheduleSchema } from '@netschool/contracts';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
import { Notice } from '../layout/toolbar.tsx';
import { Button } from '../ui/button.tsx';
import { cn } from '../ui/cn.ts';
import { Input } from '../ui/input.tsx';
import { Section } from '../ui/section.tsx';
import { Tooltip } from '../ui/tooltip.tsx';
import { TYPE_ICON } from './action-list.tsx';
import { PowerColumns } from './power-columns.tsx';
import { ScopePicker } from './scope-picker.tsx';
import { TypePicker } from './type-picker.tsx';
import { useConfirmedRequest } from './use-confirmed-request.tsx';

const listSchema = z.object({ schedules: z.array(powerScheduleSchema) });
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Schedules(props: { orgWide: boolean }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const [list, setList] = useState<PowerSchedule[]>([]);
  const [type, setType] = useState<PowerActionType>('shutdown');
  const [scope, setScope] = useState<PowerScope | null>(null);
  const [days, setDays] = useState<number[]>([]);
  const [time, setTime] = useState('19:00');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [error, setError] = useState<unknown>(null);
  const onScope = useCallback((s: PowerScope | null) => setScope(s), []);

  const load = useCallback(
    () =>
      api
        .get('/api/v1/power-schedules', listSchema)
        .then((r) => setList(r.schedules))
        .catch(() => {}),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const request = useConfirmedRequest(
    (count, key) =>
      api.send(
        'POST',
        '/api/v1/power-schedules',
        { type, scope, rule: { daysOfWeek: [...days].sort(), timeOfDay: time, timezone }, confirmDeviceCount: count },
        powerScheduleSchema,
        { idempotencyKey: key },
      ),
    () => void load(),
  );

  const change = async (s: PowerSchedule, body: unknown, method: 'PATCH' | 'DELETE') => {
    try {
      await api.send(method, `/api/v1/power-schedules/${s.id}`, body, method === 'PATCH' ? powerScheduleSchema : null);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <PowerColumns
      form={
        <form
          className="power-form flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (scope && days.length > 0) void request.preview(type, scope);
          }}
        >
          <TypePicker value={type} onChange={setType} />
          <ScopePicker orgWide={props.orgWide} onChange={onScope} />
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 px-3.5 text-[12px] font-semibold text-muted-foreground">{t('power.days')}</legend>
            <div className="grid grid-cols-7 gap-1">
              {DAYS.map((d) => {
                const on = days.includes(d);
                return (
                  <label
                    key={d}
                    className={cn(
                      'flex h-7 cursor-default items-center justify-center gap-1 rounded-full px-1 text-[12px] font-medium ring-[0.5px] ring-control-border',
                      on ? 'bg-primary text-primary-foreground ring-primary' : 'bg-control',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))}
                    />
                    {t(`power.day.${d}` as StringKey)}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <Section>
            <label className="group-row">
              <span className="flex-1 text-[13px]">{t('power.time')}</span>
              <Input
                type="time"
                className="tabular w-auto"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </label>
            <label className="group-row">
              <span className="flex-1 text-[13px]">{t('power.timezone')}</span>
              <Input className="w-48" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
            </label>
          </Section>
          {request.error && (
            <p className="text-[12px] text-destructive" role="alert">
              {request.error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!scope || days.length === 0}>
              {t('power.continue')}
            </Button>
          </div>
        </form>
      }
    >
      {error ? (
        <p className="mb-3 text-[12px] text-destructive" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {list.length === 0 ? (
        <div className="group-box">
          <Notice>{t('power.schedules.empty')}</Notice>
        </div>
      ) : (
        <ul className="action-list group-box overflow-hidden">
          {list.map((s) => {
            const Icon = TYPE_ICON[s.type];
            return (
              <li key={s.id} className="schedule group-row flex-wrap py-2.5">
                <span className="grid size-7 place-items-center rounded-[7px] bg-primary/12 text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <strong className="text-[13px] font-medium">{t(`power.type.${s.type}`)}</strong>
                  <span className="tabular text-[12px] text-muted-foreground">
                    {s.rule.daysOfWeek.map((d) => t(`power.day.${d}` as StringKey)).join(', ')} {s.rule.timeOfDay} (
                    {s.rule.timezone})
                  </span>
                  {s.nextRunAt && (
                    <span className="tabular text-[11px] text-muted-foreground">
                      {t('power.schedule.next', { at: new Date(s.nextRunAt).toLocaleString() })}
                    </span>
                  )}
                </span>
                <label className="flex items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => void change(s, { enabled: !s.enabled }, 'PATCH')}
                  />
                  {t('power.schedule.enabled')}
                </label>
                <Tooltip label={t('power.schedule.delete')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('power.schedule.delete')}
                    className="text-destructive"
                    onClick={() => void change(s, undefined, 'DELETE')}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
      {request.dialog}
    </PowerColumns>
  );
}
