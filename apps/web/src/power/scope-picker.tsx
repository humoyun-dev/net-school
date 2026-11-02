import { deviceSchema, type PowerScope, roomSchema, siteSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useT } from '../i18n/i18n.tsx';
import { Field, Select } from '../ui/input.tsx';
import { ChoiceRow, Section } from '../ui/section.tsx';

const sitesSchema = z.object({ sites: z.array(siteSchema) });
const roomsSchema = z.object({ rooms: z.array(roomSchema) });
const devicesSchema = z.object({ devices: z.array(deviceSchema) });

type Kind = PowerScope['kind'];
interface Item {
  id: string;
  name: string;
}

// Ko'lam: butun universitet (faqat org admin), binolar, bitta binodagi xonalar yoki kompyuterlar.
export function ScopePicker(props: { orgWide: boolean; onChange: (scope: PowerScope | null) => void }) {
  const api = useApi();
  const t = useT();
  const [kind, setKind] = useState<Kind>('sites');
  const [sites, setSites] = useState<Item[]>([]);
  const [site, setSite] = useState<string>('');
  const [items, setItems] = useState<Item[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const { onChange } = props;

  useEffect(() => {
    const abort = new AbortController();
    api
      .get('/api/v1/sites', sitesSchema, abort.signal)
      .then((r) => {
        setSites(r.sites);
        setSite((s) => s || (r.sites[0]?.id ?? ''));
      })
      .catch(() => {});
    return () => abort.abort();
  }, [api]);

  useEffect(() => {
    setItems([]);
    if ((kind !== 'rooms' && kind !== 'devices') || !site) return;
    const abort = new AbortController();
    const load =
      kind === 'rooms'
        ? api.get(`/api/v1/sites/${site}/rooms`, roomsSchema, abort.signal).then((r) => r.rooms)
        : api
            .get(`/api/v1/sites/${site}/devices`, devicesSchema, abort.signal)
            .then((r) => r.devices.map((d) => ({ id: d.id, name: d.hostname })));
    load.then(setItems).catch(() => {});
    return () => abort.abort();
  }, [api, kind, site]);

  useEffect(() => {
    if (kind === 'organization') onChange({ kind: 'organization' });
    else if (chosen.length === 0) onChange(null);
    else if (kind === 'sites') onChange({ kind, siteIds: chosen });
    else if (kind === 'rooms') onChange({ kind, roomIds: chosen });
    else onChange({ kind, deviceIds: chosen });
  }, [kind, chosen, onChange]);

  const kinds: Kind[] = props.orgWide ? ['organization', 'sites', 'rooms', 'devices'] : ['sites', 'rooms', 'devices'];
  const list = kind === 'sites' ? sites : items;
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <fieldset className="scope-picker flex flex-col gap-3">
      <legend className="sr-only">{t('power.scope')}</legend>
      <Section title={t('power.scope')}>
        {kinds.map((k) => (
          <ChoiceRow
            key={k}
            control={
              <input
                type="radio"
                name="scope-kind"
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setChosen([]);
                }}
              />
            }
          >
            {t(`power.scope.${k}`)}
          </ChoiceRow>
        ))}
      </Section>
      {(kind === 'rooms' || kind === 'devices') && (
        <Field label={t('power.site')} className="px-3.5">
          <Select
            value={site}
            onChange={(e) => {
              setSite(e.target.value);
              setChosen([]);
            }}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {kind !== 'organization' && list.length > 0 && (
        <div className="choices group-box max-h-64 overflow-y-auto">
          {list.map((item) => (
            <ChoiceRow
              key={item.id}
              control={<input type="checkbox" checked={chosen.includes(item.id)} onChange={() => toggle(item.id)} />}
            >
              {item.name}
            </ChoiceRow>
          ))}
        </div>
      )}
    </fieldset>
  );
}
