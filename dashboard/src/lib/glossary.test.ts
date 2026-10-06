import { describe, expect, it } from "vitest";
import { GLOSSARY, isGlossaryKey } from "@/lib/glossary";
import { MODELS } from "@/lib/models";
import { REPLAY_MODEL_IDS } from "@/lib/replay";

describe("glossary", () => {
  it("has a full name for every model in the model config (a new model can't ship without one)", () => {
    const missing = MODELS.filter((m) => !isGlossaryKey(m.name)).map((m) => `${m.id} (${m.name})`);
    expect(missing).toEqual([]);
    for (const id of REPLAY_MODEL_IDS) expect(isGlossaryKey(MODELS.find((m) => m.id === id)!.name)).toBe(true);
  });

  it("gives every term a full name and a one-line explanation", () => {
    for (const [term, e] of Object.entries(GLOSSARY)) {
      expect(e.full.length, term).toBeGreaterThan(1);
      expect(e.text.length, term).toBeGreaterThan(10);
      expect(e.text, term).not.toMatch(/\n/);
    }
  });

  it("stays neutral: no explanation ranks the models", () => {
    for (const [term, e] of Object.entries(GLOSSARY)) {
      if (term === "Best match") continue;   // "best" is part of Open-Meteo's own name for it
      expect(`${e.full} ${e.text}`, term).not.toMatch(/\b(best|most accurate|worst|better|superior)\b/i);
    }
  });

  it("only knows its own keys", () => {
    expect(isGlossaryKey("ECMWF")).toBe(true);
    expect(isGlossaryKey("toString")).toBe(false);
    expect(isGlossaryKey("__proto__")).toBe(false);
  });
});
