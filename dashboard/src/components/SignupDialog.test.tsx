import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignupButton } from "@/components/SignupDialog";
import { SIGNUP_URL, looksLikeEmail, signupEnabled, submitSignup } from "@/lib/signup";
import vercelJson from "../../vercel.json?raw";

const URL_ = "https://abc123.lambda-url.us-east-2.on.aws/";
const KEY = "0x4AAAAAAA-test-site-key";
let callbacks: Record<string, (t?: string) => void>;
const turnstile = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() };

beforeEach(() => {
  callbacks = {};
  turnstile.render.mockImplementation((_el: HTMLElement, opts: Record<string, unknown>) => {
    callbacks = { ok: opts.callback as (t?: string) => void, expired: opts["expired-callback"] as () => void };
    return "widget-1";
  });
  window.turnstile = turnstile;
});
afterEach(() => { vi.restoreAllMocks(); delete window.turnstile; });

const open = async () => {
  render(<SignupButton cityId="stockton-ca" cityName="Stockton, CA" url={URL_} siteKey={KEY} />);
  fireEvent.click(screen.getByRole("button", { name: "Get alerts" }));
  await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
};

describe("SignupButton / dialog", () => {
  it("is hidden until the sign-up URL and site key are configured", () => {
    const { container } = render(<SignupButton cityId="stockton-ca" cityName="Stockton, CA" url="" siteKey="" />);
    expect(container).toBeEmptyDOMElement();
    expect(signupEnabled("http://insecure.example", KEY)).toBe(false);
    expect(signupEnabled(URL_, KEY)).toBe(true);
  });

  it("shows the disclaimer, privacy note, glossary terms for the alert types (heat preselected) and renders Turnstile with the signup action", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Email alerts for Stockton, CA" })).toBeInTheDocument();
    expect(document.querySelector("[data-signup-disclaimer]")).toHaveTextContent("Not an official warning service. For emergencies, use weather.gov and your phone's emergency alerts.");
    expect(document.querySelector("[data-signup-privacy]")).toHaveTextContent(/stored only by Amazon SNS/);
    expect(document.querySelectorAll("[data-term]")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Heat alerts" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Flood alerts" })).not.toBeChecked();
    expect(turnstile.render.mock.calls[0][1]).toMatchObject({ sitekey: KEY, action: "signup" });
  });

  it("keeps Sign up disabled until the email looks valid, a type is chosen and the CAPTCHA is solved", async () => {
    await open();
    const submit = screen.getByRole("button", { name: "Sign up" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "me@example.com" } });
    expect(submit).toBeDisabled();                          // no token yet
    act(() => callbacks.ok("token-1"));
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Heat alerts" }));
    expect(submit).toBeDisabled();                          // no category
    expect(screen.getByText("Choose at least one alert type.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Flood alerts" }));
    act(() => callbacks.expired());
    expect(submit).toBeDisabled();                          // expired token
  });

  it("sends one request, shows the server's message, and resets the single-use CAPTCHA", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ message: "Check your inbox to confirm." }), { status: 200 }));
    await open();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " me@example.com " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Flood alerts" }));
    act(() => callbacks.ok("token-1"));
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Check your inbox to confirm."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toEqual({ email: "me@example.com", city: "stockton-ca", categories: ["heat", "flood"], turnstileToken: "token-1" });
    expect(turnstile.reset).toHaveBeenCalledWith("widget-1");
    expect(screen.getByRole("button", { name: "Sign up" })).toBeDisabled();   // needs a fresh token
  });

  it("removes the widget and returns focus to the button on close", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
    expect(screen.queryByRole("heading", { name: /Email alerts/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get alerts" })).toHaveFocus();
  });
});

describe("submitSignup", () => {
  it("shows only the server's message text, capped, and a fallback on network errors", async () => {
    const res = (body: unknown, status: number) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const req = { email: "a@b.co", city: "stockton-ca", categories: ["heat" as const], turnstileToken: "t" };
    expect(await submitSignup(req, { url: URL_, fetchImpl: res({ message: "Too many attempts. Try again later." }, 429) }))
      .toEqual({ ok: false, message: "Too many attempts. Try again later." });
    expect((await submitSignup(req, { url: URL_, fetchImpl: res({ message: "x".repeat(500) }, 400) })).message).toHaveLength(200);
    expect(await submitSignup(req, { url: URL_, fetchImpl: res({ error: { stack: "secret" } }, 500) }))
      .toEqual({ ok: false, message: "Could not reach the sign-up service. Try again later." });
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect((await submitSignup(req, { url: URL_, fetchImpl: offline })).ok).toBe(false);
  });

  it("client-side email check is permissive but catches obvious mistakes", () => {
    expect(looksLikeEmail("me@example.com")).toBe(true);
    for (const bad of ["me", "me@", "me@example", "me @example.com", "<a>@b.co"]) expect(looksLikeEmail(bad)).toBe(false);
  });
});

describe("CSP for the sign-up form (vercel.json)", () => {
  const csp: string = JSON.parse(vercelJson).headers[0].headers
    .find((h: { key: string }) => h.key === "Content-Security-Policy").value;
  const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

  it("allows exactly the Turnstile host for scripts and frames, and nothing broader", () => {
    expect(directive("script-src")).toBe("script-src 'self' https://challenges.cloudflare.com");
    expect(directive("frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(csp).not.toMatch(/\*|'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
    expect(directive("form-action")).toBe("form-action 'none'");
    // the configured sign-up endpoint's exact origin is allowed for fetch (and nothing like *.on.aws)
    expect(signupEnabled()).toBe(true);
    expect(directive("connect-src").split(" ")).toContain(new URL(SIGNUP_URL).origin);
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});
