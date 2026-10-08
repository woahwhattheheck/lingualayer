"use client";

import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "lingualayer-theme";

type Theme = "light" | "dark";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const storedTheme = getStoredTheme();
    const initialTheme = storedTheme ?? getSystemTheme();

    applyTheme(initialTheme);
    setTheme(initialTheme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = (event: MediaQueryListEvent) => {
      if (getStoredTheme()) return;

      const nextTheme: Theme = event.matches ? "dark" : "light";
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };

    mediaQuery.addEventListener("change", handleSystemChange);
    return () => mediaQuery.removeEventListener("change", handleSystemChange);
  }, []);

  const darkMode = theme === "dark";
  const label = theme
    ? `Switch to ${darkMode ? "light" : "dark"} theme`
    : "Toggle color theme";

  const handleToggle = () => {
    const currentTheme = theme ?? getSystemTheme();
    const nextTheme: Theme = currentTheme === "dark" ? "light" : "dark";

    applyTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The visual preference still applies for this session if storage is unavailable.
    }
    setTheme(nextTheme);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      aria-pressed={darkMode}
      title={label}
      onClick={handleToggle}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {darkMode ? "☀" : "☾"}
      </span>
      <span className="theme-toggle-text">
        {theme ? (darkMode ? "Light" : "Dark") : "Theme"}
      </span>
    </button>
  );
}
