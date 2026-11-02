import type { MeResponse } from '@netschool/contracts';
import type { ReactNode } from 'react';
import { useT } from '../i18n/i18n.tsx';
import { hasRole, useMe } from './session.tsx';

type Role = MeResponse['assignments'][number]['role'];

// UI darajasidagi yashirish; haqiqiy tekshiruv serverda (403).
export function RequireRole(props: { anyOf: Role[]; children: ReactNode }) {
  const me = useMe();
  const t = useT();
  if (!hasRole(me, props.anyOf)) return <p className="notice">{t('common.forbidden')}</p>;
  return <>{props.children}</>;
}
