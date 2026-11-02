import { commandSchema, eventsResponseSchema, lessonSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { ApiFailure } from '../api/client.ts';
import { applyCommand, applyPage, emptyLessonState, type LessonState } from './lesson-state.ts';

const activeLessonSchema = z.object({ lesson: lessonSchema.nullable() });

// Xona voqealari: snapshot + long-poll (wait=25). Xato → 1–30 s backoff. Sahifadan chiqilganda bekor bo'ladi.
export function useLessonEvents(roomId: string): [LessonState, (fn: (s: LessonState) => LessonState) => void] {
  const api = useApi();
  const [state, setState] = useState<LessonState>(emptyLessonState);

  useEffect(() => {
    const abort = new AbortController();
    let local = emptyLessonState();
    const commit = (next: LessonState) => {
      local = next;
      setState(next);
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        abort.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
      });
    (async () => {
      let backoff = 1_000;
      while (!abort.signal.aborted) {
        try {
          const after = local.cursor === null ? '' : `&after=${local.cursor}&wait=25`;
          const page = await api.get(
            `/api/v1/events?roomId=${encodeURIComponent(roomId)}${after}`,
            eventsResponseSchema,
            abort.signal,
          );
          let next = applyPage(local, page);
          for (const commandId of next.missingCommands) {
            next = applyCommand(next, await api.get(`/api/v1/commands/${commandId}`, commandSchema, abort.signal));
          }
          if (next.needsLesson) {
            const { lesson } = await api.get(
              `/api/v1/rooms/${roomId}/lessons/active`,
              activeLessonSchema,
              abort.signal,
            );
            next = { ...next, lesson, needsLesson: false };
          }
          commit(next);
          backoff = 1_000;
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof ApiFailure && err.status === 401) return;
          await sleep(backoff);
          backoff = Math.min(30_000, backoff * 2);
        }
      }
    })();
    return () => abort.abort();
  }, [api, roomId]);

  return [state, (fn) => setState((s) => fn(s))];
}
