// Yumshoq overlay: o'quvchiga qulf sababi va "yumshoq" ekani ko'rsatiladi. Matn faqat textContent bilan qo'yiladi.
const root = document.getElementById('root') as HTMLElement;

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

const strings = await window.netschool.strings();
window.netschool.onStatus((status) => {
  const children = [el('h1', strings.overlayTitle), el('p', strings.overlayNote, 'muted')];
  if (status.overlay.message) children.push(el('p', status.overlay.message, 'teacher'));
  root.replaceChildren(...children);
});
