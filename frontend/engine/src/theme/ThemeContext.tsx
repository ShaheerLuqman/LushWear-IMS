// Light/dark theme, backed by the same localStorage key the pre-paint inline
// script in index.html already reads before React mounts.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const THEME_STORAGE_KEY = 'lushwear-theme';
export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() used outside <ThemeProvider>');
  return ctx;
}

function applyThemeToDom(theme: Theme) {
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  // AG Grid ships its own dark theme; swapping the container class picks up all of its
  // internals (menus, popups, chart panels) rather than only the vars this app overrides.
  document.querySelectorAll('.grid-container').forEach((el) => {
    el.classList.toggle('ag-theme-alpine-dark', dark);
    el.classList.toggle('ag-theme-alpine', !dark);
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(THEME_STORAGE_KEY) as Theme) || 'light');

  useEffect(() => {
    applyThemeToDom(theme);
  }, [theme]);

  function setTheme(next: Theme) {
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* ignore */ }
    setThemeState(next);
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
