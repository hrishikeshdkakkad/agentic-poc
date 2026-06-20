"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "vault-theme";

/** Runs before paint (injected in <head>) so there's no flash of the wrong theme.
 * Also primes ag-grid's mode attribute so grids render correctly on frame one. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  KEY,
)})||'dark';var d=document.documentElement;d.dataset.theme=t;d.dataset.agThemeMode=t;d.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

type Ctx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };
const ThemeContext = createContext<Ctx>({ theme: "dark", setTheme: () => {}, toggle: () => {} });

const listeners = new Set<() => void>();

function normalizeTheme(value: string | undefined): Theme {
  return value === "light" ? "light" : "dark";
}

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return normalizeTheme(document.documentElement.dataset.theme);
}

function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitTheme() {
  listeners.forEach((listener) => listener());
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore<Theme>(subscribeTheme, readTheme, () => "dark");

  const setTheme = useCallback((t: Theme) => {
    const d = document.documentElement;
    d.dataset.theme = t;
    d.dataset.agThemeMode = t;
    d.style.colorScheme = t;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode — non-fatal */
    }
    emitTheme();
  }, []);

  const toggle = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
