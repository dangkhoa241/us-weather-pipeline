// Width of a chart's container (ResizeObserver), so SVG text stays at its real pixel size on any screen.
import { useEffect, useState } from "react";

export function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setW(Math.round(el.clientWidth)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
