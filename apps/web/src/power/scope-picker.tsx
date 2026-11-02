import { deviceSchema, type PowerScope, roomSchema, siteSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useT } from '../i18n/i18n.tsx';

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
    <fieldset className="scope-picker">
      <legend>{t('power.scope')}</legend>
      <div className="row">
        {kinds.map((k) => (
          <label key={k} className="inline">
            <input
              type="radio"
              name="scope-kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setChosen([]);
              }}
            />
            {t(`power.scope.${k}`)}
          </label>
        ))}
      </div>
      {(kind === 'rooms' || kind === 'devices') && (
        <label>
          {t('power.site')}
          <select
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
          </select>
        </label>
      )}
      {kind !== 'organization' && (
        <div className="choices">
          {list.map((item) => (
            <label key={item.id} className="inline">
              <input type="checkbox" checked={chosen.includes(item.id)} onChange={() => toggle(item.id)} />
              {item.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
