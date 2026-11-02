import { ChevronRight, DoorOpen } from 'lucide-react';
import { Link } from 'react-router';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { Notice, Toolbar } from '../layout/toolbar.tsx';
import { useRooms } from './use-rooms.ts';

// Xonalar: bino bo'yicha guruhlangan ro'yxat (System Settings uslubi).
export function RoomsPage() {
  const t = useT();
  const errorText = useErrorText();
  const { data, error } = useRooms();
  return (
    <>
      <Toolbar title={t('rooms.title')} subtitle={t('rooms.subtitle')} />
      {error ? (
        <Notice tone="error">{errorText(error)}</Notice>
      ) : !data ? (
        <Notice>{t('common.loading')}</Notice>
      ) : data.length === 0 ? (
        <Notice>{t('rooms.empty')}</Notice>
      ) : (
        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-5 py-6">
          {data.map(({ site, rooms }) => (
            <section key={site.id}>
              <h2 className="mb-1.5 px-3.5 text-[12px] font-semibold text-muted-foreground">{site.name}</h2>
              <ul className="group-box overflow-hidden">
                {rooms.map((r) => (
                  <li key={r.id} className="group-row p-0">
                    <Link
                      to={`/rooms/${r.id}`}
                      state={{ name: r.name }}
                      className="flex min-h-11 flex-1 items-center gap-3 px-3.5 hover:bg-hover"
                    >
                      <span className="grid size-7 place-items-center rounded-[7px] bg-primary/12 text-primary">
                        <DoorOpen className="size-4" />
                      </span>
                      <span className="flex-1 text-[13px] font-medium">{r.name}</span>
                      <ChevronRight aria-hidden className="size-4 text-muted-foreground/70" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
