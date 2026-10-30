import "server-only";

import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import type { AgentRun } from "@/lib/settings";

import { AGENT_JOB_KEY, agentScanJob } from "./jobs";
import { agentSetupProblem } from "./run";
import { AGENT_MAX_RUNS_PER_MONTH, AGENT_SCAN_INTERVAL_MS, runLimitProblem, runsInPastMonth } from "./runs";

// The agent checks every minute and starts a scan once every four hours after the
// previous run. This timer lives in the app process, so Dossier must run as a
// single instance per database (the same constraint as its other schedulers).

const CHECK_MS = 60 * 1000;

/**
 * Whether a four-hour scan is due. The legacy hour/time-zone parameters remain
 * accepted so existing callers and old settings do not break.
 */
export function scheduledRunDue(now: Date, _hour: number, _timeZone: string, runs: readonly AgentRun[]): boolean {
  const last = runs[0];
  return !last || now.getTime() - Date.parse(last.at) >= AGENT_SCAN_INTERVAL_MS;
}

/** The next run, or the first time a slot leaves the rolling 30-day budget. */
export function nextAgentRun(now: Date, _hour: number, _timeZone: string, runs: readonly AgentRun[]): Date {
  const recent = runsInPastMonth(runs, now);
  const last = runs[0];
  const intervalReadyAt = last ? Date.parse(last.at) + AGENT_SCAN_INTERVAL_MS : now.getTime();
  if (recent.length >= AGENT_MAX_RUNS_PER_MONTH) {
    const oldest = Math.min(...recent.map((run) => Date.parse(run.at)));
    const budgetReadyAt = oldest + 30 * 24 * 60 * 60 * 1000;
    return new Date(Math.max(budgetReadyAt, intervalReadyAt));
  }
  const due = intervalReadyAt;
  return new Date(due > now.getTime() ? due : Math.ceil(now.getTime() / CHECK_MS) * CHECK_MS);
}

/** Starts the next four-hour scan when the agent is on and no scan is in flight. */
export async function startDueRun(now = new Date()): Promise<string | null> {
  const settings = await loadSettings();
  if (!settings.agentEnabled) return null;
  if (await agentSetupProblem(settings.agentQuery)) return null;
  if (runLimitProblem(settings.agentRuns, now, { manual: false })) return null;
  if (!scheduledRunDue(now, settings.agentHour, "UTC", settings.agentRuns)) return null;
  if ((await findUnfinishedJobs(AGENT_JOB_KEY)).length > 0) return null;
  return startJob(agentScanJob, { manual: false }, { key: AGENT_JOB_KEY });
}

/** After a restart, a candidate left DRAFTING has no job to finish it. */
export async function resetInterruptedDrafts(): Promise<number> {
  const { count } = await prisma.agentCandidate.updateMany({
    where: { status: AgentCandidateStatus.DRAFTING },
    data: { status: AgentCandidateStatus.SCORED, error: "Drafting was interrupted. Try again." },
  });
  return count;
}

const globalForAgent = globalThis as unknown as { agentTimer?: ReturnType<typeof setInterval> };

/** Starts the timer, once per process (dev reloads keep the one they have). */
export function startAgentSchedule(): void {
  if (globalForAgent.agentTimer) return;
  void resetInterruptedDrafts().catch((error: unknown) => logServerError("job agent", error));
  const check = () => void startDueRun().catch((error: unknown) => logServerError("job agent schedule", error));
  globalForAgent.agentTimer = setInterval(check, CHECK_MS);
  // Do not keep the process alive just for this.
  globalForAgent.agentTimer.unref?.();
  check();
}
