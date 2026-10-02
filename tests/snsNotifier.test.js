import { describe, it, expect, vi } from "vitest";
import { PublishCommand } from "@aws-sdk/client-sns";
import { SnsNotifier, messageOf, redact, subjectOf } from "../src/adapters/notifier/snsNotifier.js";

const TOPIC = "arn:aws:sns:us-east-2:123456789012:weather-pipeline-alerts";
const quiet = { notify: vi.fn(async () => {}) };   // stands in for the console notifier
const make = (send, opts = {}) => new SnsNotifier({ topicArn: TOPIC, region: "us-east-2", pipelineName: "us-weather-pipeline", client: { send }, local: quiet, ...opts });

describe("SnsNotifier (mocked AWS SDK client)", () => {
  it("publishes warn/error events to the topic with a clean subject and the details in the body", async () => {
    const send = vi.fn(async () => ({ MessageId: "m-1" }));
    await make(send).notify({ level: "error", title: "Stage 1 forecast failed", message: "3 error(s), batch b-1", data: { mode: "forecast" } });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PublishCommand);
    expect(cmd.input).toMatchObject({ TopicArn: TOPIC, Subject: "[us-weather-pipeline] ERROR: Stage 1 forecast failed" });
    expect(cmd.input.Message).toContain("3 error(s), batch b-1");
    expect(cmd.input.Message).toContain('"mode": "forecast"');
  });

  it("only logs events below SNS_MIN_LEVEL (no email for info)", async () => {
    const send = vi.fn();
    await make(send).notify({ level: "info", title: "Stage 2 done" });
    expect(send).not.toHaveBeenCalled();
    expect(quiet.notify).toHaveBeenCalledWith({ level: "info", title: "Stage 2 done" });
  });

  it("never throws when SNS fails (notifications must not break the pipeline)", async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ThrottledException" }); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(make(send).notify({ level: "warn", title: "Heat alert" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ThrottledException"));
    error.mockRestore();
  });

  it("refuses a missing or malformed topic ARN and an unknown level", () => {
    expect(() => make(vi.fn(), { topicArn: null })).toThrow(/SNS_TOPIC_ARN/);
    expect(() => make(vi.fn(), { topicArn: "arn:aws:s3:::bucket" })).toThrow(/SNS_TOPIC_ARN/);
    expect(() => make(vi.fn(), { minLevel: "debug" })).toThrow(/SNS_MIN_LEVEL/);
  });
});

describe("SNS message formatting", () => {
  it("keeps subjects ASCII, single-line and at most 100 characters", () => {
    expect(subjectOf("p", { level: "warn", title: "Heat → 110°F\nin Phoenix" })).toBe("[p] WARN: Heat - 110 degF in Phoenix");
    const long = subjectOf("us-weather-pipeline", { level: "error", title: "x".repeat(300) });
    expect(long).toHaveLength(100);
    expect(long.endsWith("...")).toBe(true);
  });

  it("redacts credentials from connection strings in titles, messages and data", () => {
    expect(redact("connect mongodb+srv://weather:s3cret@cluster0.example.net/db failed")).toBe("connect mongodb+srv://***:***@cluster0.example.net/db failed");
    const body = messageOf("p", { level: "error", title: "t", message: "redis://u:p@host:6379 down", data: { uri: "mongodb://a:b@h" } }, new Date("2026-10-02T00:00:00Z"));
    expect(body).not.toMatch(/u:p@|a:b@/);
    expect(body).toContain("-- p, error, 2026-10-02T00:00:00.000Z");
  });
});
