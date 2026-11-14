import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { interpolate, lookupMessage } from "./translate";
import { EMBEDDED_EN } from "./embedded-en";
import { getAdminSsrPayload, initialJson } from "../ssr-data";

export const ADMIN_UI_LOCALES = ["en", "nl", "de", "fr", "es", "pl", "uk", "ru"] as const;
export type AdminUiLocale = (typeof ADMIN_UI_LOCALES)[number];

type Messages = Record<string, string>;

interface I18nContextValue {
  locale: AdminUiLocale;
  setLocale: (locale: AdminUiLocale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  loading: boolean;
}

const STORAGE_KEY = "jf_admin_locale";

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLocale(): AdminUiLocale {
  const ssrLocale = getAdminSsrPayload()?.locale;
  if (ssrLocale && (ADMIN_UI_LOCALES as readonly string[]).includes(ssrLocale)) {
    return ssrLocale as AdminUiLocale;
  }
  const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  if (stored && (ADMIN_UI_LOCALES as readonly string[]).includes(stored)) {
    return stored as AdminUiLocale;
  }
  const browser = typeof navigator === "undefined" ? "en" : navigator.language.split("-")[0];
  if ((ADMIN_UI_LOCALES as readonly string[]).includes(browser)) {
    return browser as AdminUiLocale;
  }
  return "en";
}

async function fetchCatalog(locale: string): Promise<Messages> {
  try {
    const res = await fetch(`/api/i18n/${locale}`, { cache: "no-store" });
    if (!res.ok) return locale === "en" ? EMBEDDED_EN : {};
    const data = (await res.json()) as { messages?: Messages };
    return data.messages ?? (locale === "en" ? EMBEDDED_EN : {});
  } catch {
    return locale === "en" ? EMBEDDED_EN : {};
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const initialLocale = detectInitialLocale();
  const initialPrimary = initialJson<{ messages?: Messages }>(
    `/api/i18n/${initialLocale}`,
  )?.messages;
  const initialFallback = initialJson<{ messages?: Messages }>("/api/i18n/en")?.messages;
  const [locale, setLocaleState] = useState<AdminUiLocale>(initialLocale);
  const [messages, setMessages] = useState<Messages>(initialPrimary ?? {});
  const [fallback, setFallback] = useState<Messages>(initialFallback ?? EMBEDDED_EN);
  const [loading, setLoading] = useState(!initialPrimary);

  useEffect(() => {
    let cancelled = false;
    if (!initialJson(`/api/i18n/${locale}`)) setLoading(true);

    Promise.all([
      fetchCatalog(locale),
      locale === "en" ? Promise.resolve(EMBEDDED_EN) : fetchCatalog("en"),
    ])
      .then(([primary, en]) => {
        if (cancelled) return;
        setMessages(primary);
        setFallback(en);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((next: AdminUiLocale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
    fetch("/api/languages/preference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    }).catch(() => null);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const msg =
        lookupMessage(messages, key, locale, vars) ??
        lookupMessage(fallback, key, "en", vars) ??
        lookupMessage(EMBEDDED_EN, key, "en", vars) ??
        key;
      return interpolate(msg, vars);
    },
    [messages, fallback, locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t, loading }), [locale, setLocale, t, loading]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx;
}
