import { createContext, type ReactNode, useContext } from 'react';
import type { Api } from './client.ts';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider(props: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={props.api}>{props.children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiProvider missing');
  return api;
}
