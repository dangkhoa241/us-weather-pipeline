import { describe, expect, it } from "vitest";
import { insideDir } from "../../scripts/insideDir.mjs";

// Plain "/" paths: the helper normalizes them, so the same cases hold on Windows ("\") and Linux CI ("/").
describe("insideDir (static-server path guard in scripts/)", () => {
  it("accepts the folder and paths inside it, with or without a trailing separator", () => {
    expect(insideDir("/app/dist", "/app/dist")).toBe(true);
    expect(insideDir("/app/dist", "/app/dist/index.html")).toBe(true);
    expect(insideDir("/app/dist/", "/app/dist/assets/a.js")).toBe(true);
  });
  it("refuses a sibling folder that shares the prefix, and traversal out of the folder", () => {
    expect(insideDir("/app/dist", "/app/dist-old/secret.txt")).toBe(false);
    expect(insideDir("/app/dist/", "/app/dist-old/secret.txt")).toBe(false);
    expect(insideDir("/app/dist", "/app/dist/../package.json")).toBe(false);
  });
});
