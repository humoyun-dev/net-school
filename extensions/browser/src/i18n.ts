// Bloklangan sahifa matni (uz/ru/en), brauzer tiliga ko'ra; standart — o'zbekcha.
const TEXT = {
  uz: { title: 'Sayt cheklangan', body: "O'qituvchi yoki IT admin bu saytni cheklagan." },
  ru: { title: 'Сайт ограничен', body: 'Учитель или IT-администратор ограничил этот сайт.' },
  en: { title: 'Site restricted', body: 'Your teacher or IT admin has restricted this site.' },
} as const;

export function blockedText(language: string): { title: string; body: string } {
  const lang = language.toLowerCase().slice(0, 2);
  return lang === 'ru' || lang === 'en' ? TEXT[lang] : TEXT.uz;
}
