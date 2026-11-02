import { roomSchema, siteSchema } from '@netschool/contracts';
import { createContext, useContext, useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { hasRole, useMe } from '../auth/session.tsx';

const sitesSchema = z.object({ sites: z.array(siteSchema) });
const roomsSchema = z.object({ rooms: z.array(roomSchema) });

export interface SiteRooms {
  site: z.infer<typeof siteSchema>;
  rooms: z.infer<typeof roomSchema>[];
}

// O'qituvchi — o'ziga biriktirilgan xonalar; admin/IT — o'z site'larining hamma xonalari.
export function useMyRooms(): { data: SiteRooms[] | null; error: unknown } {
  const api = useApi();
  const me = useMe();
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
  return { data, error };
}

// Shell bir marta yuklaydi; yon panel va Xonalar sahifasi shu ma'lumotni bo'lishadi.
export const RoomsContext = createContext<{ data: SiteRooms[] | null; error: unknown }>({ data: null, error: null });
export const useRooms = () => useContext(RoomsContext);
