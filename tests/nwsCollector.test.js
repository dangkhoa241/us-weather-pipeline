import { describe, it, expect, vi, beforeEach } from "vitest";
import { GetParameterCommand } from "@aws-sdk/client-ssm";

// The Stage 1 jobs and index setup are tested elsewhere; here only the Lambda wiring around them.
vi.mock("../src/stage1/runMode.js", () => ({
  runMode: vi.fn(async (mode) => ({ status: "success", etl_batch_id: `stage1-${mode}-1`, rows_fetched: 3, error_count: 0 })),
}));
vi.mock("../src/collections.js", async (importOriginal) => ({ ...(await importOriginal()), ensureCollections: vi.fn(async () => {}) }));

const { runMode } = await import("../src/stage1/runMode.js");
const { createHandler } = await import("../src/lambda/nwsCollector.js");
const { getSecureParameter } = await import("../src/lambda/ssmParameter.js");

const PARAM = "/weather-pipeline/atlas-mongo-uri";
const URI = "mongodb+srv://collector:s3cret@cluster0.example.mongodb.net";

const fakeStore = () => ({ connect: vi.fn(async () => {}), close: vi.fn(async () => {}) });
const fakeNotifier = () => ({ notify: vi.fn(async () => {}) });

function setup({ store = fakeStore(), getParameter = vi.fn(async () => URI) } = {}) {
  const notifier = fakeNotifier();
  const makeStore = vi.fn(() => store);
  const handler = createHandler({ getParameter, makeStore, makeNotifier: () => notifier });
  return { handler, store, notifier, makeStore, getParameter };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getSecureParameter (mocked SSM client)", () => {
  it("reads a SecureString with decryption", async () => {
    const send = vi.fn(async () => ({ Parameter: { Value: URI } }));
    await expect(getSecureParameter(PARAM, { client: { send } })).resolves.toBe(URI);
    const [cmd] = send.mock.calls[0];
    expect(cmd).toBeInstanceOf(GetParameterCommand);
    expect(cmd.input).toEqual({ Name: PARAM, WithDecryption: true });
  });

  it("refuses names outside /weather-pipeline/ without calling AWS", async () => {
    const send = vi.fn();
    for (const name of [undefined, "", "/other/secret", "weather-pipeline/x"]) {
      await expect(getSecureParameter(name, { client: { send } })).rejects.toThrow(/\/weather-pipeline\//);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("fails on an empty parameter", async () => {
    const send = vi.fn(async () => ({ Parameter: {} }));
    await expect(getSecureParameter(PARAM, { client: { send } })).rejects.toThrow(/empty/);
  });
});

describe("NWS collector Lambda handler", () => {
  it("runs the mode against the store built from the SSM URI, and closes the store", async () => {
    const { handler, store, makeStore, notifier } = setup();
    const res = await handler({ mode: "forecast" });
    expect(res).toEqual({ mode: "forecast", status: "success", etl_batch_id: "stage1-forecast-1", rows_fetched: 3, error_count: 0 });
    expect(makeStore).toHaveBeenCalledWith(URI);
    expect(runMode).toHaveBeenCalledWith("forecast", store, notifier, { publicAlerts: null });   // subscriber emails: alerts mode only
    expect(store.connect).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("reads SSM once per container (cold start), not on every run", async () => {
    const { handler, getParameter } = setup();
    await handler({ mode: "alerts" });
    await handler({ mode: "forecast" });
    expect(getParameter).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown mode with an error alert and no AWS or database call", async () => {
    const { handler, getParameter, makeStore, notifier } = setup();
    const res = await handler({ mode: "history" });
    expect(res.status).toBe("failed");
    expect(getParameter).not.toHaveBeenCalled();
    expect(makeStore).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });

  it("on failure: does not throw (no Lambda retries), alerts once without the password, closes, re-reads SSM next time", async () => {
    const store = fakeStore();
    store.connect.mockRejectedValueOnce(new Error(`connect failed for ${URI}`));
    const { handler, notifier, getParameter } = setup({ store });

    const res = await handler({ mode: "alerts" });
    expect(res).toEqual({ mode: "alerts", status: "failed" });
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const event = notifier.notify.mock.calls[0][0];
    expect(event).toMatchObject({ level: "error", title: "Lambda NWS alerts failed" });
    expect(event.message).not.toContain(":s3cret@");
    expect(console.error.mock.calls.flat().join(" ")).not.toContain(":s3cret@");

    await handler({ mode: "alerts" });
    expect(getParameter).toHaveBeenCalledTimes(2);
  });

  it("reports an SSM failure as a failed run", async () => {
    const getParameter = vi.fn(async () => { throw new Error("AccessDeniedException"); });
    const { handler, notifier, makeStore } = setup({ getParameter });
    await expect(handler({ mode: "forecast" })).resolves.toEqual({ mode: "forecast", status: "failed" });
    expect(makeStore).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ message: "AccessDeniedException" }));
  });
});
