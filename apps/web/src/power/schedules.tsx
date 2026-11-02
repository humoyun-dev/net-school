import { type PowerActionType, type PowerSchedule, type PowerScope, powerScheduleSchema } from '@netschool/contracts';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
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
    <section className="power-columns">
      <form
        className="card power-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (scope && days.length > 0) void request.preview(type, scope);
        }}
      >
        <TypePicker value={type} onChange={setType} />
        <ScopePicker orgWide={props.orgWide} onChange={onScope} />
        <fieldset>
          <legend>{t('power.days')}</legend>
          <div className="row">
            {DAYS.map((d) => (
              <label key={d} className="inline">
                <input
                  type="checkbox"
                  checked={days.includes(d)}
                  onChange={() => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))}
                />
                {t(`power.day.${d}` as StringKey)}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          {t('power.time')}
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
        <label>
          {t('power.timezone')}
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </label>
        <button type="submit" disabled={!scope || days.length === 0}>
          {t('power.continue')}
        </button>
        {request.error && <p className="error">{request.error}</p>}
      </form>
      <div className="card">
        {error ? <p className="error">{errorText(error)}</p> : null}
        {list.length === 0 && <p className="notice">{t('power.schedules.empty')}</p>}
        <ul className="action-list">
          {list.map((s) => (
            <li key={s.id} className="schedule">
              <strong>{t(`power.type.${s.type}`)}</strong>
              <span>
                {s.rule.daysOfWeek.map((d) => t(`power.day.${d}` as StringKey)).join(', ')} {s.rule.timeOfDay} (
                {s.rule.timezone})
              </span>
              {s.nextRunAt && (
                <span className="muted">
                  {t('power.schedule.next', { at: new Date(s.nextRunAt).toLocaleString() })}
                </span>
              )}
              <label className="inline">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => void change(s, { enabled: !s.enabled }, 'PATCH')}
                />
                {t('power.schedule.enabled')}
              </label>
              <button type="button" className="secondary" onClick={() => void change(s, undefined, 'DELETE')}>
                {t('power.schedule.delete')}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {request.dialog}
    </section>
  );
}
