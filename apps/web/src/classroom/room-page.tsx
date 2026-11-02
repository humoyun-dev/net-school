import { lessonSchema } from '@netschool/contracts';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useApi } from '../api/api-context.tsx';
import { useIntent } from '../api/intent.ts';
import { hasRole, useMe } from '../auth/session.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { CommandBar } from './command-bar.tsx';
import { CommandResults } from './command-results.tsx';
import { DeviceTile } from './device-tile.tsx';
import { latestResultFor } from './lesson-state.ts';
import { ThumbnailFeed } from './thumbnail-feed.ts';
import { useRoomDevices } from './use-devices.ts';
import { useLessonEvents } from './use-events.ts';

export type FeedFactory = (
  lessonId: string,
  onFrame: (deviceId: string, url: string) => void,
  accept: (deviceId: string) => boolean,
) => { close(): void };

const defaultFeed: FeedFactory = (lessonId, onFrame, accept) =>
  new ThumbnailFeed(`${location.origin.replace(/^http/, 'ws')}/api/v1/lessons/${lessonId}/thumbnails/stream`, onFrame, {
    accept,
    onUnauthenticated: () => location.assign(`/login?next=${encodeURIComponent(location.pathname)}`),
  });

export function RoomPage(props: {
  createFeed?: FeedFactory;
  renderActions?: (deviceId: string, lessonId: string, hostname: string) => ReactNode;
}) {
  const { roomId = '' } = useParams();
  const roomName = (useLocation().state as { name?: string } | null)?.name;
  const api = useApi();
  const me = useMe();
  const t = useT();
  const errorText = useErrorText();
  const [state, update] = useLessonEvents(roomId);
  const devices = useRoomDevices(roomId);
  const [selected, setSelected] = useState<string[]>([]);
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(45);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const lesson = state.lesson?.status === 'active' ? state.lesson : null;
  const members = useMemo(() => new Set(lesson?.deviceIds ?? []), [lesson?.deviceIds]);
  const membersRef = useRef(members);
  membersRef.current = members;
  const canCommand = !!lesson && (lesson.teacherUserId === me.user.id || hasRole(me, ['school_admin']));
  const createFeed = props.createFeed ?? defaultFeed;

  const lessonId = lesson?.id ?? null;
  useEffect(() => {
    if (!lessonId || !canCommand) return;
    const feed = createFeed(
      lessonId,
      (deviceId, url) => setFrames((f) => ({ ...f, [deviceId]: url })),
      (deviceId) => membersRef.current.has(deviceId),
    );
    return () => {
      feed.close();
      setFrames({});
    };
  }, [lessonId, canCommand, createFeed]);

  const start = useIntent(async (key) => {
    const body = { ...(title.trim() ? { title: title.trim() } : {}), durationMinutes: duration };
    const started = await api.send('POST', `/api/v1/rooms/${roomId}/lessons`, body, lessonSchema, {
      idempotencyKey: key,
    });
    update((s) => ({ ...s, lesson: started }));
    return started;
  });
  const end = useIntent(async (key) => {
    if (!lesson) return null;
    const ended = await api.send('POST', `/api/v1/lessons/${lesson.id}/end`, undefined, lessonSchema, {
      idempotencyKey: key,
    });
    update((s) => ({ ...s, lesson: ended }));
    setConfirmEnd(false);
    return ended;
  });
  const clearHelp = (helpId: string) =>
    api
      .send('DELETE', `/api/v1/help-requests/${helpId}`, undefined, null)
      .then(() =>
        update((s) => {
          const help = new Map(s.help);
          help.delete(helpId);
          return { ...s, help };
        }),
      )
      .catch(() => {});

  const shown = lesson ? devices.filter((d) => members.has(d.id)) : devices;
  const helpByDevice = new Map([...state.help.values()].map((h) => [h.deviceId, h]));

  return (
    <section className="room">
      <header className="room-head">
        <Link to="/rooms">{t('room.back')}</Link>
        <h1>{roomName ?? t('room.title')}</h1>
        {lesson && <span className="lesson-title">{lesson.title}</span>}
        <span className="spacer" />
        {lesson && canCommand && !confirmEnd && (
          <button type="button" className="secondary" onClick={() => setConfirmEnd(true)}>
            {t('lesson.end')}
          </button>
        )}
        {lesson && confirmEnd && (
          <>
            <button type="button" className="danger" disabled={end.pending} onClick={() => void end.run()}>
              {t('lesson.endConfirm')}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmEnd(false)}>
              {t('common.cancel')}
            </button>
          </>
        )}
      </header>

      {!lesson && (
        <form
          className="card start-lesson"
          onSubmit={(e) => {
            e.preventDefault();
            void start.run();
          }}
        >
          <p>{state.lesson?.status === 'ended' ? t('lesson.ended') : t('lesson.none')}</p>
          <label>
            {t('lesson.titleLabel')}
            <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            {t('lesson.duration')}
            <input
              type="number"
              min={5}
              max={480}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
          <button type="submit" disabled={start.pending}>
            {t('lesson.start')}
          </button>
          {start.error ? (
            <p className="error" role="alert">
              {errorText(start.error)}
            </p>
          ) : null}
        </form>
      )}

      {lesson && !canCommand && <p className="notice">{t('lesson.otherTeacher')}</p>}
      {lesson && canCommand && (
        <CommandBar lessonId={lesson.id} selected={selected} onClearSelection={() => setSelected([])} />
      )}
      {end.error ? (
        <p className="error" role="alert">
          {errorText(end.error)}
        </p>
      ) : null}

      {lesson && shown.length === 0 && <p className="notice">{t('grid.empty')}</p>}
      <div className="grid">
        {shown.map((d) => {
          const result = latestResultFor(state, d.id);
          return (
            <DeviceTile
              key={d.id}
              device={d}
              frameUrl={frames[d.id] ?? null}
              help={lesson ? (helpByDevice.get(d.id) ?? null) : null}
              result={result ? { type: result.type, status: result.status } : null}
              selected={selected.includes(d.id)}
              canCommand={canCommand}
              onToggle={() => setSelected((s) => (s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id]))}
              onClearHelp={clearHelp}
              actions={lesson && canCommand ? props.renderActions?.(d.id, lesson.id, d.hostname) : null}
            />
          );
        })}
      </div>
      {lesson && <CommandResults commands={[...state.commands.values()]} />}
    </section>
  );
}
