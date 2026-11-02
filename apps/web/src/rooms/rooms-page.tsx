import { roomSchema, siteSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { hasRole, useMe } from '../auth/session.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';

const sitesSchema = z.object({ sites: z.array(siteSchema) });
const roomsSchema = z.object({ rooms: z.array(roomSchema) });

interface SiteRooms {
  site: z.infer<typeof siteSchema>;
  rooms: z.infer<typeof roomSchema>[];
}

// O'qituvchi — o'ziga biriktirilgan xonalar; admin/IT — o'z site'larining hamma xonalari.
export function RoomsPage() {
  const api = useApi();
  const me = useMe();
  const t = useT();
  const errorText = useErrorText();
  const [data, setData] = useState<SiteRooms[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      try {
        const { sites } = await api.get('/api/v1/sites', sitesSchema, abort.signal);
        const staff = hasRole(me, ['school_admin', 'it_support']);
        const out: SiteRooms[] = [];
        for (const site of sites) {
          const { rooms } = await api.get(`/api/v1/sites/${site.id}/rooms`, roomsSchema, abort.signal).catch(() => ({
            rooms: [],
          }));
          const mine = staff ? rooms : rooms.filter((r) => me.roomIds.includes(r.id));
          if (mine.length > 0) out.push({ site, rooms: mine });
        }
        setData(out);
      } catch (err) {
        if (!abort.signal.aborted) setError(err);
      }
    })();
    return () => abort.abort();
  }, [api, me]);

  if (error) return <p className="error">{errorText(error)}</p>;
  if (!data) return <p className="notice">{t('common.loading')}</p>;
  if (data.length === 0) return <p className="notice">{t('rooms.empty')}</p>;
  return (
    <section>
      <h1>{t('rooms.title')}</h1>
      {data.map(({ site, rooms }) => (
        <div key={site.id} className="card site">
          <h2>{site.name}</h2>
          <ul className="room-list">
            {rooms.map((r) => (
              <li key={r.id}>
                <Link to={`/rooms/${r.id}`} state={{ name: r.name }}>
                  {r.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
