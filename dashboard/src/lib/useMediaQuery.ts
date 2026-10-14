// A CSS media query as React state (e.g. reduced motion, desktop width). `fallback` is used where matchMedia is missing.
import { useEffect, useState } from "react";

const query = (q: string) => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q) : null);

export function useMediaQuery(q: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => query(q)?.matches ?? fallback);
  useEffect(() => {
    const m = query(q);
    if (!m) return;
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return matches;
}
