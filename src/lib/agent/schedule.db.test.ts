import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "@/lib/settings";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { nextAgentRun, resetInterruptedDrafts, scheduledRunDue, startDueRun } from "./schedule";
import { AGENT_MAX_RUNS_PER_MONTH, AGENT_SCAN_INTERVAL_MS, runLimitProblem } from "./runs";

vi.mock("./run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run")>()),
  agentSetupProblem: async () => null,
}));

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "agent-job"),
}));

const prisma = () => db.client!;
const run = (at: string, manual = false): AgentRun => ({ at, manual, message: null });
const FOUR_HOURS = 4 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase(prisma());
});
afterAll(() => prisma().$disconnect());

describe("the four-hour schedule", () => {
  it("runs immediately on first enable, then only after four hours", () => {
    const last = [run("2026-10-20T12:00:00Z")];
    expect(AGENT_SCAN_INTERVAL_MS).toBe(FOUR_HOURS);
    expect(scheduledRunDue(new Date("2026-10-20T12:00:00Z"), 7, "Asia/Kolkata", [])).toBe(true);
    expect(scheduledRunDue(new Date("2026-10-20T15:59:59Z"), 7, "Europe/Berlin", last)).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T16:00:00Z"), 7, "UTC", last)).toBe(true);
  });

  it("shows the next four-hour run and the next free monthly budget slot", () => {
    const now = new Date("2026-10-20T12:00:30Z");
    expect(nextAgentRun(now, 7, "UTC", []).toISOString()).toBe("2026-10-20T12:01:00.000Z");
    expect(nextAgentRun(new Date("2026-10-20T12:00:00Z"), 7, "Asia/Kolkata", [run("2026-10-20T11:30:00Z")]).toISOString()).toBe("2026-10-20T15:30:00.000Z");

    const fullMonth = Array.from({ length: AGENT_MAX_RUNS_PER_MONTH }, (_, index) =>
      run(new Date(now.getTime() - index * AGENT_SCAN_INTERVAL_MS).toISOString()),
    );
    expect(nextAgentRun(now, 7, "UTC", fullMonth).toISOString()).toBe(new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString());
  });
});

describe("the monthly source-request budget and spacing", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("allows no more than one source request every four hours, whether scheduled or manual", () => {
    expect(runLimitProblem([], now, { manual: true })).toBeNull();
    expect(runLimitProblem([run("2026-10-20T08:25:00Z")], now, { manual: true })).toBe("The agent runs once every four hours. Try again in 25 minutes.");
    expect(runLimitProblem([run("2026-10-20T08:25:00Z")], now, { manual: false })).toBe("The agent runs once every four hours. Try again in 25 minutes.");
    expect(runLimitProblem([run("2026-10-20T07:59:00Z", true)], now, { manual: false })).toBeNull();
  });

  it("allows at most 180 searches in a rolling 30-day window", () => {
    const oneEighty = Array.from({ length: AGENT_MAX_RUNS_PER_MONTH }, (_, index) =>
      run(new Date(now.getTime() - index * FOUR_HOURS).toISOString()),
    );
    expect(runLimitProblem(oneEighty, now, { manual: false })).toBe(
      "The agent reached its 180-search rolling 30-day budget. Try again in 4 hours.",
    );
    expect(runLimitProblem(oneEighty, new Date(now.getTime() + FOUR_HOURS + 1), { manual: false })).toBeNull();
    const oneSeventyNine = Array.from({ length: AGENT_MAX_RUNS_PER_MONTH - 1 }, (_, index) =>
      run(new Date(now.getTime() - FOUR_HOURS - 1 - index * FOUR_HOURS).toISOString()),
    );
    expect(runLimitProblem(oneSeventyNine, now, { manual: false })).toBeNull();
  });
});

describe("starting the scheduled four-hour scan", () => {
  it("starts when enabled and due, reuses the in-flight guard, and respects the four-hour gap", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    const due = new Date("2026-10-20T06:00:00Z");
    expect(await startDueRun(due)).toBeNull();

    await saveSettings({ agentEnabled: true });
    expect(await startDueRun(due)).toBe("agent-job");
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-scan" }), { manual: false }, { key: "agent" });

    vi.mocked(startJob).mockClear();
    await prisma().job.create({ data: { type: "agent-scan", key: "agent", status: "RUNNING", input: { manual: false } } });
    expect(await startDueRun(new Date(due.getTime() + FOUR_HOURS))).toBeNull();
    await prisma().job.deleteMany();

    await saveSettings({ agentRuns: [run(due.toISOString())] });
    expect(await startDueRun(new Date(due.getTime() + FOUR_HOURS - 1))).toBeNull();
    expect(await startDueRun(new Date(due.getTime() + FOUR_HOURS))).toBe("agent-job");
    expect(startJob).toHaveBeenCalledTimes(1);
  });

  it("sends drafts a restart interrupted back to the queue, saying so", async () => {
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "job-1", dedupeKey: "k1", status: "DRAFTING" } });
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "job-2", dedupeKey: "k2", status: "DRAFTED" } });
    expect(await resetInterruptedDrafts()).toBe(1);
    expect(await prisma().agentCandidate.findMany({ orderBy: { externalId: "asc" }, select: { status: true, error: true } })).toEqual([
      { status: "SCORED", error: "Drafting was interrupted. Try again." },
      { status: "DRAFTED", error: null },
    ]);
  });
});
