import type { PowerActionType } from '@netschool/contracts';
import { useT } from '../i18n/i18n.tsx';

const TYPES: PowerActionType[] = ['shutdown', 'reboot', 'sleep', 'wake'];

export function TypePicker(props: { value: PowerActionType; onChange: (t: PowerActionType) => void }) {
  const t = useT();
  return (
    <label>
      {t('power.type')}
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as PowerActionType)}>
        {TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`power.type.${type}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
