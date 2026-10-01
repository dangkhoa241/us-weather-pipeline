// Light/dark theme. Default: follow the system; the toggle stores an explicit choice in localStorage (per browser).
// The `.dark` class on <html> switches the CSS variables (index.css), which every chart and the map use.
import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "uwp-theme";
const media = () => (typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null);

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && Boolean(media()?.matches));
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  window.dispatchEvent(new Event("themechange"));
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* storage blocked: the choice lasts for this page only */ }
  applyTheme(pref);
}

/** Apply the stored choice and follow system changes while the choice is "system". */
export function startTheme() {
  applyTheme(getThemePref());
  media()?.addEventListener?.("change", () => { if (getThemePref() === "system") applyTheme("system"); });
}

const readVar = (name: string) => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/** Current value of a CSS color variable, updated on theme changes (for libraries that need real colors). */
export function useCssVar(name: string, fallback: string) {
  const [value, setValue] = useState(() => readVar(name) || fallback);
  useEffect(() => {
    const update = () => setValue(readVar(name) || fallback);
    update();
    window.addEventListener("themechange", update);
    return () => window.removeEventListener("themechange", update);
  }, [name, fallback]);
  return value;
}
