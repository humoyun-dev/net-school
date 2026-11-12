import { blockedText } from './i18n.ts';

const text = blockedText(chrome.i18n.getUILanguage());
document.title = text.title;
const h1 = document.querySelector('h1');
const p = document.querySelector('p');
if (h1) h1.textContent = text.title;
if (p) p.textContent = text.body;
