import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "@/lib/settings";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { nextAgentRun, resetInterruptedDrafts, scheduledRunDue, startDueRun } from "./schedule";
import { AGENT_MAX_RUNS_PER_DAY, runLimitProblem } from "./runs";

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
const hour = 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase(prisma());
});
afterAll(() => prisma().$disconnect());

describe("the hourly schedule", () => {
  it("runs immediately on first enable, then once an hour regardless of time zone", () => {
    const last = [run("2026-10-20T12:00:00Z")];
    expect(scheduledRunDue(new Date("2026-10-20T12:00:00Z"), 7, "Asia/Kolkata", [])).toBe(true);
    expect(scheduledRunDue(new Date("2026-10-20T12:59:59Z"), 7, "Europe/Berlin", last)).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T13:00:00Z"), 7, "UTC", last)).toBe(true);
  });

  it("shows the next hourly run and rounds overdue work to the next scheduler tick", () => {
    expect(nextAgentRun(new Date("2026-10-20T12:00:30Z"), 7, "UTC", []).toISOString()).toBe("2026-10-20T12:01:00.000Z");
    expect(nextAgentRun(new Date("2026-10-20T12:00:00Z"), 7, "Asia/Kolkata", [run("2026-10-20T11:30:00Z")]).toISOString()).toBe("2026-10-20T12:30:00.000Z");
    expect(nextAgentRun(new Date("2026-10-20T12:45:00Z"), 7, "UTC", [run("2026-10-20T11:30:00Z")]).toISOString()).toBe("2026-10-20T12:45:00.000Z");
  });
});

describe("the hourly and rolling 24-hour limits", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("allows no more than one run an hour, whether scheduled or manual", () => {
    expect(runLimitProblem([], now, { manual: true })).toBeNull();
    expect(runLimitProblem([run("2026-10-20T11:35:00Z")], now, { manual: true })).toBe("The agent ran less than an hour ago. Try again in 35 minutes.");
    expect(runLimitProblem([run("2026-10-20T11:35:00Z")], now, { manual: false })).toBe("The agent ran less than an hour ago. Try again in 35 minutes.");
    expect(runLimitProblem([run("2026-10-20T10:59:00Z", true)], now, { manual: false })).toBeNull();
  });

  it("allows at most 24 runs in a rolling 24-hour window", () => {
    const twentyFour = Array.from({ length: AGENT_MAX_RUNS_PER_DAY }, (_, index) =>
      run(new Date(now.getTime() - index * hour).toISOString()),
    );
    expect(runLimitProblem(twentyFour, now, { manual: false })).toBe(
      "The agent has run 24 times in the past 24 hours, as many as it may. Try again in 1 hour.",
    );
    expect(runLimitProblem(twentyFour, new Date(now.getTime() + 23 * hour + 1), { manual: false })).toBeNull();
    expect(runLimitProblem(twentyFour.slice(0, 23), now, { manual: false })).toBeNull();
  });
});

describe("starting the scheduled hourly run", () => {
  it("starts when enabled and due, reuses the in-flight guard, and waits an hour after the last run", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    const due = new Date("2026-10-20T06:00:00Z");
    expect(await startDueRun(due)).toBeNull();

    await saveSettings({ agentEnabled: true });
    expect(await startDueRun(due)).toBe("agent-job");
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-scan" }), { manual: false }, { key: "agent" });

    vi.mocked(startJob).mockClear();
    await prisma().job.create({ data: { type: "agent-scan", key: "agent", status: "RUNNING", input: { manual: false } } });
    expect(await startDueRun(new Date(due.getTime() + hour))).toBeNull();
    await prisma().job.deleteMany();

    await saveSettings({ agentRuns: [run(due.toISOString())] });
    expect(await startDueRun(new Date(due.getTime() + 59 * 60 * 1000))).toBeNull();
    expect(await startDueRun(new Date(due.getTime() + hour))).toBe("agent-job");
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
