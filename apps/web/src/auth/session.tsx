import { type MeResponse, meResponseSchema } from '@netschool/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';

type Role = MeResponse['assignments'][number]['role'];

interface Session {
  me: MeResponse | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider(props: { children: ReactNode }) {
  const api = useApi();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.get('/api/v1/me', meResponseSchema));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [api]);
  const logout = useCallback(async () => {
    await api.send('POST', '/api/v1/auth/logout', undefined, null).catch(() => {});
    setMe(null);
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <SessionContext.Provider value={{ me, loading, refresh, logout }}>{props.children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}

export function useMe(): MeResponse {
  const { me } = useSession();
  if (!me) throw new Error('not signed in');
  return me;
}

export const hasRole = (me: MeResponse, roles: Role[]) => me.assignments.some((a) => roles.includes(a.role));
export const isOrgAdmin = (me: MeResponse) =>
  me.assignments.some((a) => a.role === 'school_admin' && a.siteId === null);

// Testlar uchun: tayyor `me` bilan sessiya (API so'rovisiz).
export function SessionContextForTest(props: { me: MeResponse; children: ReactNode }) {
  const value: Session = { me: props.me, loading: false, refresh: async () => {}, logout: async () => {} };
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
