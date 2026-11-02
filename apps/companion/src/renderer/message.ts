// O'qituvchi xabari: matn ishonchsiz kirish — faqat textContent.
// Obuna sinxron, birinchi bo'lib qilinadi: main sahifa yuklanishi bilan xabarni yuboradi.
const root = document.getElementById('root') as HTMLElement;
let message: { id: string; text: string } | null = null;
let strings: Awaited<ReturnType<typeof window.netschool.strings>> | null = null;

function render(): void {
  if (!message || !strings) return;
  const { id, text } = message;
  const title = document.createElement('h1');
  title.textContent = strings.messageTitle;
  const body = document.createElement('p');
  body.className = 'text';
  body.textContent = text;
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = strings.messageOk;
  ok.addEventListener('click', () => window.netschool.dismissMessage(id));
  root.replaceChildren(title, body, ok);
}

window.netschool.onMessage((next) => {
  message = next;
  render();
});
strings = await window.netschool.strings();
render();
