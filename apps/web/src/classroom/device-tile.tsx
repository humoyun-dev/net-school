import type { Device } from '@netschool/contracts';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';

export interface TileResult {
  type: 'message.show' | 'overlay.lock' | 'overlay.unlock';
  status: string;
}

export function DeviceTile(props: {
  device: Device;
  frameUrl: string | null;
  help: { id: string } | null;
  result: TileResult | null;
  selected: boolean;
  canCommand: boolean;
  onToggle: () => void;
  onClearHelp: (helpId: string) => void;
  actions?: React.ReactNode;
}) {
  const t = useT();
  const { device, help, result } = props;
  return (
    <article className={`tile${help ? ' tile-help' : ''}${props.selected ? ' tile-selected' : ''}`}>
      <header>
        {props.canCommand && (
          <input
            type="checkbox"
            aria-label={t('grid.select', { name: device.hostname })}
            checked={props.selected}
            onChange={props.onToggle}
          />
        )}
        <strong>{device.hostname}</strong>
      </header>
      <div className="thumb">
        {props.frameUrl ? <img src={props.frameUrl} alt={device.hostname} /> : <span>{t('tile.noFrame')}</span>}
      </div>
      <ul className="badges">
        <li className={`badge presence-${device.companion.presence}`}>{t(`presence.${device.companion.presence}`)}</li>
        <li className={`badge agent-${device.agent}`}>{t(`agent.${device.agent}`)}</li>
      </ul>
      {help && (
        <div className="help">
          <span>✋ {t('help.raised')}</span>
          {props.canCommand && (
            <button type="button" className="secondary" onClick={() => props.onClearHelp(help.id)}>
              {t('help.clear')}
            </button>
          )}
        </div>
      )}
      {result && (
        <p className={`result result-${result.status}`}>
          {t(`cmd.type.${result.type}` as StringKey)}: {t(`target.${result.status}` as StringKey)}
        </p>
      )}
      {props.actions}
    </article>
  );
}
