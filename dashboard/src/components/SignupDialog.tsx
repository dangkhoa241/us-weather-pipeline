// "Get alerts" button + sign-up form for one city (docs/analysis/email-signups.md, section 9). A native <dialog>
// (focus trap, Escape, ::backdrop) with: email, alert-type checkboxes (glossary tooltips), the Turnstile widget (loaded
// only when the dialog opens), privacy note and disclaimer. The answer is shown inline (role="status"), never alert().
// Hidden unless the sign-up URL and Turnstile site key are configured (vite.config.ts).
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { DISCLAIMER } from "@alerts";
import { Term } from "@/components/Term";
import {
  CATEGORIES, PRIVACY_NOTE, SIGNUP_URL, TURNSTILE_SITE_KEY, loadTurnstile, looksLikeEmail, signupEnabled, submitSignup, type Category,
} from "@/lib/signup";

type Props = { cityId: string; cityName: string; url?: string; siteKey?: string };

export function SignupButton({ cityId, cityName, url = SIGNUP_URL, siteKey = TURNSTILE_SITE_KEY }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!signupEnabled(url, siteKey)) return null;
  return (
    <>
      <button ref={button} type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} data-signup-open
        className="rounded-md border px-2.5 py-1 text-sm font-medium shadow-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Get alerts
      </button>
      {open && <SignupDialog cityId={cityId} cityName={cityName} url={url} siteKey={siteKey} onClose={() => { setOpen(false); button.current?.focus(); }} />}
    </>
  );
}

function SignupDialog({ cityId, cityName, url, siteKey, onClose }: Required<Props> & { onClose: () => void }) {
  const ids = { title: useId(), email: useId(), note: useId() };
  const dialog = useRef<HTMLDialogElement>(null);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [email, setEmail] = useState("");
  const [categories, setCategories] = useState<Category[]>(["heat"]);
  const [token, setToken] = useState("");
  const [captchaError, setCaptchaError] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d = dialog.current!;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    let cancelled = false;
    loadTurnstile().then((ts) => {
      if (cancelled || !widget.current) return;
      widgetId.current = ts.render(widget.current, {
        sitekey: siteKey, action: "signup", theme: "auto", size: "flexible",
        callback: (t: string) => setToken(t), "expired-callback": () => setToken(""), "error-callback": () => setToken(""),
      });
    }).catch(() => { if (!cancelled) setCaptchaError(true); });
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
    };
  }, [siteKey]);

  const toggle = (c: Category) => setCategories((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const emailOk = looksLikeEmail(email);
  const canSend = emailOk && categories.length > 0 && token !== "" && !sending;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setStatus(null);
    const res = await submitSignup({ email, city: cityId, categories, turnstileToken: token }, { url });
    setStatus({ ok: res.ok, text: res.message });
    setSending(false);
    setToken("");   // tokens are single-use
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }

  return (
    <dialog ref={dialog} aria-labelledby={ids.title} onClose={onClose} data-signup-dialog
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border bg-card p-5 text-card-foreground shadow-lg backdrop:bg-black/40">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <h2 id={ids.title} className="text-lg font-semibold">Email alerts for {cityName}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted">×</button>
        </div>
        <p className="rounded-md border-l-4 border-amber-500 bg-muted/50 p-2 text-sm" data-signup-disclaimer>{DISCLAIMER}</p>

        <label className="flex flex-col gap-1 text-sm" htmlFor={ids.email}>
          Email
          <input id={ids.email} type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)}
            aria-invalid={email !== "" && !emailOk} className="rounded-md border bg-background px-2 py-1.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>

        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1 font-medium">Alert types</legend>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {CATEGORIES.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input type="checkbox" name="category" value={c.id} checked={categories.includes(c.id)} onChange={() => toggle(c.id)} />
                <Term k={c.term} />
              </label>
            ))}
          </div>
          {categories.length === 0 && <span className="text-xs text-destructive">Choose at least one alert type.</span>}
        </fieldset>

        <div ref={widget} data-turnstile className="min-h-[65px]" />
        {captchaError && <p className="text-sm text-destructive">The verification widget could not load. Try again later.</p>}

        <p id={ids.note} className="text-xs text-muted-foreground" data-signup-privacy>{PRIVACY_NOTE}</p>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={!canSend} aria-describedby={ids.note}
            className="rounded-md bg-cta px-3 py-1.5 text-sm font-medium text-cta-foreground shadow-sm hover:bg-cta-hover disabled:cursor-not-allowed disabled:opacity-50">
            {sending ? "Sending…" : "Sign up"}
          </button>
          <p role="status" aria-live="polite" className={`text-sm ${status && !status.ok ? "text-destructive" : ""}`} data-signup-status>{status?.text ?? ""}</p>
        </div>
      </form>
    </dialog>
  );
}
