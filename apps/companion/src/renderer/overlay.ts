// Overlay: o'quvchiga qulf sababi va darajasi (yumshoq yoki bloklangan) ko'rsatiladi. Matn faqat textContent bilan qo'yiladi.
// Obuna sinxron, birinchi bo'lib qilinadi: main sahifa yuklanishi bilan joriy holatni yuboradi.
import type { AgentStatus } from '../core/agent.ts';

const root = document.getElementById('root') as HTMLElement;
let status: AgentStatus | null = null;
let strings: Awaited<ReturnType<typeof window.netschool.strings>> | null = null;

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(): void {
  if (!status || !strings) return;
  const children = [
    el('h1', strings.overlayTitle),
    el('p', status.overlayEnforcement === 'hard' ? strings.overlayNoteHard : strings.overlayNote, 'muted'),
  ];
  if (status.overlay.message) children.push(el('p', status.overlay.message, 'teacher'));
  root.replaceChildren(...children);
}

window.netschool.onStatus((next) => {
  status = next;
  render();
});
strings = await window.netschool.strings();
render();
