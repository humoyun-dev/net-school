import type { Command, EventsResponse, HelpRequest, Lesson, RemoteSession } from '@netschool/contracts';

type TargetStatus = Command['targets'][number]['status'];
const STATUSES: TargetStatus[] = ['pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled'];

// Dars holati (React'siz): events sahifalari shu yerda qo'llanadi. Snapshot (resync) holatni to'liq almashtiradi;
// seq ≤ lastSeq bo'lgan voqea qayta qo'llanmaydi; qo'llash idempotent (snapshot'dan keyingi takror zararsiz).
export interface LessonState {
  cursor: string | null;
  lastSeq: number;
  lesson: Lesson | null;
  commands: Map<string, Command>;
  help: Map<string, { id: string; deviceId: string; raisedAt: string }>;
  remote: Map<string, RemoteSession>;
  // Voqeada faqat id keldi: hook GET /commands/{id} bilan to'ldiradi.
  missingCommands: string[];
  // lesson.started: faol dars qayta o'qiladi.
  needsLesson: boolean;
}

export function emptyLessonState(): LessonState {
  return {
    cursor: null,
    lastSeq: 0,
    lesson: null,
    commands: new Map(),
    help: new Map(),
    remote: new Map(),
    missingCommands: [],
    needsLesson: false,
  };
}

function summarize(targets: Command['targets']): Command['summary'] {
  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TargetStatus, number>;
  for (const t of targets) summary[t.status] += 1;
  return summary;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function applyPage(prev: LessonState, page: EventsResponse): LessonState {
  let s = prev;
  if (page.resync && page.snapshot) {
    const snap = page.snapshot;
    s = {
      ...emptyLessonState(),
      lesson: snap.lesson,
      commands: new Map(snap.commands.map((c) => [c.id, c])),
      help: new Map(
        snap.helpRequests
          .filter((h: HelpRequest) => h.clearedAt === null)
          .map((h) => [h.id, { id: h.id, deviceId: h.deviceId, raisedAt: h.raisedAt }]),
      ),
      remote: new Map(snap.remoteSessions.map((r) => [r.id, r])),
      lastSeq: Number(page.cursor),
    };
  } else {
    s = { ...s, commands: new Map(s.commands), help: new Map(s.help), remote: new Map(s.remote) };
  }
  for (const ev of page.events) {
    const seq = Number(ev.seq);
    if (seq <= s.lastSeq) continue;
    s.lastSeq = seq;
    const d = ev.data;
    switch (ev.type) {
      case 'lesson.started':
        s.needsLesson = true;
        break;
      case 'lesson.ended':
        if (s.lesson && (ev.lessonId === null || ev.lessonId === s.lesson.id)) {
          s.lesson = { ...s.lesson, status: 'ended', endedAt: ev.at };
        }
        s.help.clear();
        break;
      case 'command.created': {
        const commandId = str(d.commandId);
        if (commandId && !s.commands.has(commandId) && !s.missingCommands.includes(commandId)) {
          s.missingCommands = [...s.missingCommands, commandId];
        }
        break;
      }
      case 'command.target_updated': {
        const command = s.commands.get(str(d.commandId) ?? '');
        const deviceId = str(d.deviceId);
        const status = str(d.status) as TargetStatus | null;
        if (command && deviceId && status) {
          const targets = command.targets.map((t) =>
            t.deviceId === deviceId ? { ...t, status, updatedAt: ev.at } : t,
          );
          s.commands.set(command.id, { ...command, targets, summary: summarize(targets) });
        }
        break;
      }
      case 'help_request.raised': {
        const id = str(d.helpRequestId);
        const deviceId = str(d.deviceId);
        if (id && deviceId) s.help.set(id, { id, deviceId, raisedAt: ev.at });
        break;
      }
      case 'help_request.cleared': {
        const id = str(d.helpRequestId);
        if (id) s.help.delete(id);
        break;
      }
      case 'remote_session.opened':
      case 'remote_session.closed':
        // Sessiya tafsiloti viewer paneli orqali; bu yerda faqat yopilganini belgilaymiz.
        if (ev.type === 'remote_session.closed') s.remote.delete(str(d.sessionId) ?? '');
        break;
    }
  }
  return { ...s, cursor: page.cursor };
}

// GET /commands/{id} javobi: to'liq buyruq (summary qayta hisoblanadi).
export function applyCommand(prev: LessonState, command: Command): LessonState {
  const commands = new Map(prev.commands);
  commands.set(command.id, { ...command, summary: summarize(command.targets) });
  return { ...prev, commands, missingCommands: prev.missingCommands.filter((id) => id !== command.id) };
}

// Plitkadagi natija: qurilmaga tegishli eng yangi buyruq (sequence bo'yicha).
export function latestResultFor(
  s: LessonState,
  deviceId: string,
): { commandId: string; type: Command['type']; status: TargetStatus; reason: string | null } | null {
  let best: { seq: bigint; value: ReturnType<typeof latestResultFor> } | null = null;
  for (const c of s.commands.values()) {
    const t = c.targets.find((x) => x.deviceId === deviceId);
    if (!t) continue;
    const seq = BigInt(c.sequence);
    if (!best || seq > best.seq) {
      best = { seq, value: { commandId: c.id, type: c.type, status: t.status, reason: t.reason } };
    }
  }
  return best?.value ?? null;
}
