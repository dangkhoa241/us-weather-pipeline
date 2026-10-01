// Theme toggle: System → Light → Dark. Follows the system until the user picks one.
import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { getThemePref, setThemePref, type ThemePref } from "@/lib/theme";

const NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemePref, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const Icon = pref === "dark" ? Moon : pref === "light" ? Sun : Monitor;
  return (
    <button type="button" aria-label={`${LABEL[pref]} (click for ${LABEL[NEXT[pref]].toLowerCase()})`} title={LABEL[pref]}
      className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm hover:text-foreground"
      onClick={() => { const next = NEXT[pref]; setThemePref(next); setPref(next); }}>
      <Icon className="size-3.5" aria-hidden />
      {pref === "system" ? "System" : pref === "light" ? "Light" : "Dark"}
    </button>
  );
}
