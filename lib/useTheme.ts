"use client";

// Light / dark theme state, persisted to localStorage.
//
// The CSS for both palettes lives in `app/globals.css` (see `:root` and
// `html.light`). This hook just owns the class on <html> and the
// localStorage round-trip. Components don't read the theme value directly —
// they style off the same Tailwind tokens (`bg-panel`, `text-text`, …)
// which resolve through CSS vars to whichever palette is active.

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "g3.theme";
const DEFAULT_THEME: Theme = "dark";

function readSavedTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyToHtml(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "light") root.classList.add("light");
  else root.classList.remove("light");
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  // We read from localStorage in an effect (not initial state) so SSR and
  // first-paint match — there's no theme flash on hydration as long as the
  // initial render uses the default class set on the server.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const saved = readSavedTheme();
    setThemeState(saved);
    applyToHtml(saved);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyToHtml(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, toggle, setTheme };
}
