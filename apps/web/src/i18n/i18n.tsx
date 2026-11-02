import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { ApiFailure } from '../api/client.ts';
import { format, type Locale, pickLocale, type StringKey, strings } from './strings.ts';

const STORAGE_KEY = 'netschool.locale';

interface I18n {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: StringKey, vars?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'uz' || saved === 'ru' || saved === 'en') return saved;
  } catch {
    // localStorage yo'q (maxfiy rejim) — brauzer tili.
  }
  return pickLocale(typeof navigator === 'undefined' ? undefined : navigator.language);
}

export function LocaleProvider(props: { initial?: Locale; children: ReactNode }) {
  const [locale, setState] = useState<Locale>(props.initial ?? initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // saqlanmasa ham joriy sahifada ishlaydi
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, vars) => format(strings[locale][key], vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('LocaleProvider missing');
  return ctx;
}

export function useT(): I18n['t'] {
  return useI18n().t;
}

// Xato → foydalanuvchi matni (kod bo'yicha) va murojaat kodi.
export function useErrorText(): (err: unknown) => string {
  const t = useT();
  return (err) => {
    if (err instanceof ApiFailure) {
      const key = `error.${err.code}` as StringKey;
      const text = key in strings.uz ? t(key) : t('error.internal');
      return err.correlationId ? `${text}. ${t('error.correlation', { id: err.correlationId })}` : text;
    }
    return t('error.network');
  };
}
