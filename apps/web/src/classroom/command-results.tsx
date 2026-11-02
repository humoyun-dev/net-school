import type { Command } from '@netschool/contracts';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';

const SHOWN: Command['targets'][number]['status'][] = [
  'succeeded',
  'failed',
  'pending',
  'sent',
  'acknowledged',
  'expired',
  'cancelled',
];

// Oxirgi buyruqlar: har holat soni (umumiy "muvaffaqiyat" yo'q).
export function CommandResults(props: { commands: Command[] }) {
  const t = useT();
  const recent = [...props.commands].sort((a, b) => (BigInt(b.sequence) > BigInt(a.sequence) ? 1 : -1)).slice(0, 5);
  if (recent.length === 0) return null;
  return (
    <section className="card">
      <h2>{t('cmd.results')}</h2>
      <ul className="results">
        {recent.map((c) => (
          <li key={c.id}>
            <strong>{t(`cmd.type.${c.type}` as StringKey)}</strong>{' '}
            {SHOWN.filter((s) => (c.summary[s] ?? 0) > 0).map((s) => (
              <span key={s} className={`count result-${s}`}>
                {t(`target.${s}` as StringKey)}: {c.summary[s]}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
