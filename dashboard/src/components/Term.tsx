// A glossary term with a tooltip: <abbr> with a dotted underline, focusable, described by its tooltip
// (aria-describedby). Opens on mouse hover, keyboard focus and tap; closes on Escape, blur or mouse leave.
// The tooltip is portaled to <body> with fixed positioning, so cards with overflow-hidden never clip it.
// Colors: popover tokens (light ~18:1, dark ~15:1 text contrast).
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

type Props = { k: GlossaryKey; children?: ReactNode; className?: string };
const WIDTH = 288;

export function Term({ k, children, className = "" }: Props) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const entry = GLOSSARY[k];

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  useEffect(() => {   // Escape also closes a tooltip opened by hover (focus may be elsewhere)
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  return (
    <>
      <abbr ref={ref} tabIndex={0} aria-describedby={id} data-term={k}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (document.activeElement !== ref.current) setOpen(false); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
        className={`cursor-help underline decoration-dotted decoration-1 underline-offset-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
        {children ?? k}
      </abbr>
      {createPortal(
        <span id={id} role="tooltip" hidden={!open} data-term-tooltip={k}
          className={`pointer-events-none fixed z-50 ${open ? "block" : "hidden"} rounded-md border bg-popover px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-popover-foreground shadow-md`}
          style={{ top: pos.top, left: pos.left, maxWidth: WIDTH }}>
          <span className="block font-semibold">{entry.full}<span className="sr-only">:</span></span>{" "}
          <span className="block">{entry.text}</span>
        </span>,
        document.body,
      )}
    </>
  );
}
