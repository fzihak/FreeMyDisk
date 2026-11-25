import { create } from "zustand";
import { SupportedLocale, TranslationSchema } from "./types";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ptBR } from "./locales/pt-BR";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { de } from "./locales/de";
import { bn } from "./locales/bn";

const translations: Record<SupportedLocale, TranslationSchema> = {
  en,
  "zh-CN": zhCN,
  es,
  fr,
  "pt-BR": ptBR,
  ja,
  ko,
  de,
  bn,
};

interface I18nState {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: TranslationSchema;
}

const STORAGE_KEY = "freemydisk_locale";

const getSavedLocale = (): SupportedLocale => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as SupportedLocale | null;
    if (saved && saved in translations) {
      return saved;
    }
  } catch {
    // ignore
  }
  return "en";
};

export const useI18nStore = create<I18nState>((set) => ({
  locale: getSavedLocale(),
  setLocale: (locale: SupportedLocale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore
    }
    set({
      locale,
      t: translations[locale] || translations.en,
    });
  },
  t: translations[getSavedLocale()] || translations.en,
}));

export * from "./types";
