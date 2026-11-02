import type { AgentStatus } from '../core/agent.ts';

const root = document.getElementById('root') as HTMLElement;
let last: AgentStatus | null = null;
let notice = '';

// Obuna sinxron, birinchi bo'lib qilinadi: main sahifa yuklanishi bilan joriy holatni yuboradi. Matnlar keyin keladi.
let rendering: (() => void) | null = null;
window.netschool.onStatus((status) => {
  last = status;
  rendering?.();
});
const strings = await window.netschool.strings();

const HUB_TEXT = {
  connecting: strings.hubConnecting,
  online: strings.hubOnline,
  offline: strings.hubOffline,
  tls_error: strings.hubTlsError,
  rejected: strings.hubRejected,
} as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
    notice = '';
  } catch {
    notice = strings.helpFailed;
  }
  render();
}

function render(): void {
  const status = last;
  const nodes: HTMLElement[] = [el('h1', strings.statusTitle)];
  if (!status) {
    nodes.push(el('p', strings.notEnrolled));
    root.replaceChildren(...nodes);
    return;
  }
  const hub = el('div', '', 'row');
  hub.append(el('span', '', `dot ${status.hub}`), el('span', HUB_TEXT[status.hub]));
  nodes.push(hub);
  if (status.hub !== 'online' && status.lastSeenAt !== null) {
    nodes.push(el('p', `${strings.hubLastSeen}: ${new Date(status.lastSeenAt).toLocaleTimeString()}`, 'muted'));
  }
  nodes.push(el('p', status.lessonId ? strings.lessonActive : strings.lessonNone));
  if (status.thumbnails === 'on' && status.hub === 'online') nodes.push(el('p', strings.thumbnailsOn, 'muted'));
  if (status.thumbnails === 'requires_permission') nodes.push(el('p', strings.thumbnailsNeedPermission, 'muted'));
  if (status.thumbnails === 'unsupported') nodes.push(el('p', strings.thumbnailsUnsupported, 'muted'));
  if (status.lessonId) {
    if (status.help) {
      nodes.push(el('p', strings.helpSent));
      const cancel = el('button', strings.helpWithdraw);
      cancel.addEventListener('click', () => void run(() => window.netschool.withdrawHelp()));
      nodes.push(cancel);
    } else {
      const ask = el('button', strings.helpRaise, 'primary');
      ask.addEventListener('click', () => void run(() => window.netschool.raiseHelp()));
      nodes.push(ask);
    }
  }
  if (notice) nodes.push(el('p', notice, 'muted'));
  root.replaceChildren(...nodes);
}

rendering = render;
render();
