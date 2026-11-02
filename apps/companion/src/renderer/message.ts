// O'qituvchi xabari: matn ishonchsiz kirish — faqat textContent.
const root = document.getElementById('root') as HTMLElement;
const strings = await window.netschool.strings();

window.netschool.onMessage(({ id, text }) => {
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
});
