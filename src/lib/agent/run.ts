import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { isAiConfigured } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { scorePosting } from "@/lib/ai/tasks";
import { searchPostings } from "@/lib/job-search";
import { credentialsFor, loadJobSearchConfig, requestContext } from "@/lib/job-search/config";
import { JobSearchError } from "@/lib/job-search/errors";
import { postingKey, postingText, safeLink, type FoundPosting, type SearchQuery } from "@/lib/job-search/search";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { saveScore } from "@/lib/posting-scores";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";

import { agentDedupeKey, candidateData } from "./candidates";
import { agentDraftJob, draftJobKey } from "./draft";
import { recordRunEnd, recordRunStart, runLimitProblem } from "./runs";

// One run of the job agent (E16-3): the configured searches, the postings seen before
// dropped, and a score for the newest of the rest. It never sends anything.
// Adapted from avinashbatchala's fork of Dossier.

export const agentScanResultSchema = z.object({
  /** Postings the source returned. */
  found: z.number().int().min(0),
  /** Of those, the ones not seen before. */
  fresh: z.number().int().min(0),
  scored: z.number().int().min(0),
  drafted: z.number().int().min(0),
  /** Found but seen before: saved, dismissed or applied for in Find jobs, or a candidate already. */
  skipped: z.number().int().min(0),
  /** What to tell the user. */
  message: z.string(),
});
export type AgentScanResult = z.infer<typeof agentScanResultSchema>;

const stopped = (message: string): AgentScanResult => ({ found: 0, fresh: 0, scored: 0, drafted: 0, skipped: 0, message });

/** Whether a search is complete enough to run: keywords and a country. */
export const agentQueryReady = (query: SearchQuery) => Boolean(query.keywords.trim() && query.country);

/**
 * One source request per scan: custom searches and the default India-wide search
 * both remain a single query to keep the monthly provider budget predictable.
 */
export function agentSearchQueries(query: SearchQuery): SearchQuery[] {
  // One broad India-wide source query keeps the default plan below 200/month.
  return [query];
}

/**
 * Keep only source-backed postings that look like one of the target roles.
 * This proves the source supplied a company, description and HTTPS link; it
 * does not prove the employer has not since closed the vacancy.
 */
export function isQualifiedAgentPosting(posting: FoundPosting): boolean {
  const title = posting.title.trim();
  const company = posting.company.trim();
  const description = posting.description.trim();
  const url = safeLink(posting.url);
  if (!title || !company || description.length < 80 || !url || !url.startsWith("https://")) return false;

  const seniorTechnologyRole =
    /\b(head of (?:it|technology|information technology)|avp\s*[-–]?\s*(?:it|technology)|chief technology officer|cto|it delivery manager|delivery manager[ -]it|digital transformation (?:head|director|lead)|head of digital transformation)\b/i.test(title);
  const fintechProductRole =
    /\bproduct manager\b/i.test(title) &&
    /fintech|financial technology|bfs[iy]|nbfc|banking|lending|digital lending|loan|payments|financial services/i.test([title, company, description].join(" "));
  return seniorTechnologyRole || fintechProductRole;
}

/** Why the agent can't run at all, in words, or null when it's set up. */
export async function agentSetupProblem(query: SearchQuery): Promise<string | null> {
  if (!query.keywords.trim()) return "Add what to look for in Settings → Job agent first.";
  if (!query.country) return "Choose a country for the search in Settings → Job agent first.";
  if (!(await isAiConfigured())) return "Choose an AI provider in Settings → AI provider first.";
  const config = await loadJobSearchConfig();
  if (!config.source) return "Choose a job source in Settings → Job search first.";
  // It searches on its own, which the BA's terms forbid most clearly (#223).
  if (config.source === "ARBEITSAGENTUR") return "The job agent doesn't search the Bundesagentur für Arbeit. Choose JSearch, Adzuna or FreeHire in Settings → Job search for it.";
  try {
    credentialsFor(config, config.source);
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
  return null;
}

/** The postings from a page that are new to the agent: not saved, dismissed or applied for, and not a candidate already. */
export async function newPostings(postings: readonly FoundPosting[]): Promise<FoundPosting[]> {
  const states = await postingStates(postings);
  const unseen = postings.filter((posting) => {
    const state = states.get(postingKey(posting));
    return !state?.saved && !state?.dismissed && !state?.applicationId;
  });
  const keys = unseen.map(agentDedupeKey);
  const known = await prisma.agentCandidate.findMany({
    where: { OR: [...unseen.map(({ source, externalId }) => ({ source, externalId })), { dedupeKey: { in: keys } }] },
    select: { source: true, externalId: true, dedupeKey: true },
  });
  const seen = new Set(known.flatMap((candidate) => [postingKey(candidate), candidate.dedupeKey]));
  // The same job twice in one page counts once too.
  return unseen.filter((posting, index) => {
    const fresh = !seen.has(postingKey(posting)) && !seen.has(keys[index]);
    seen.add(keys[index]);
    return fresh;
  });
}

const newestFirst = (a: FoundPosting, b: FoundPosting) => (b.postedAt ? Date.parse(b.postedAt) : 0) - (a.postedAt ? Date.parse(a.postedAt) : 0);

/**
 * One run: one India-wide source page, then a
 * score for the newest new postings, up to agentMaxScores. Each is kept as a
 * candidate, so it doesn't come back; one below agentMinScore stays out of
 * the queue. With auto-draft on, the best of them get a draft each, up to
 * agentMaxDrafts, each its own job. A scheduled run does nothing while the
 * agent is off.
 */
export async function runAgentScan({ manual }: { manual: boolean }, context: JobContext, now = new Date()): Promise<AgentScanResult> {
  const settings = await loadSettings();
  if (!settings.agentEnabled && !manual) return stopped("The job agent is off.");
  const setup = await agentSetupProblem(settings.agentQuery);
  if (setup) return stopped(setup);
  const limit = runLimitProblem(settings.agentRuns, now, { manual: false });
  if (limit) return stopped(limit);

  const run = await recordRunStart(now, manual);
  const finish = async (result: AgentScanResult) => {
    await recordRunEnd(run, result.message);
    return result;
  };

  await context.step("Searching for new postings");
  const config = await loadJobSearchConfig();
  const source = config.source!;
  let postings: FoundPosting[];
  try {
    // One first-page India-wide or custom search: at most six scheduled scans per day, capped at 180/month.
    const credentials = credentialsFor(config, source);
    const request = requestContext(source);
    const [query] = agentSearchQueries(settings.agentQuery);
    const page = await searchPostings(source, credentials, query, null, request);
    postings = page.postings.filter(isQualifiedAgentPosting);
  } catch (error) {
    if (error instanceof JobSearchError) return finish(stopped(error.message));
    throw error;
  }

  const fresh = await newPostings(postings);
  const counts = { found: postings.length, fresh: fresh.length, skipped: postings.length - fresh.length, drafted: 0 };
  if (fresh.length === 0) return finish({ ...counts, scored: 0, message: postings.length === 0 ? "The search found no postings this time." : "No new postings this time." });

  const toScore = fresh.toSorted(newestFirst).slice(0, settings.agentMaxScores);
  await context.step(`Scoring ${toScore.length} ${toScore.length === 1 ? "posting" : "postings"}`);
  const [provider, options, profile] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile()]);
  let scored = 0;
  let queued = 0;
  const kept: string[] = [];
  let problem: string | null = null;
  for (const posting of toScore) {
    if (context.signal.aborted) break;
    try {
      const { data, promptVersion } = await scorePosting(
        provider,
        { posting: postingText(posting), title: posting.title, company: posting.company, place: posting.place, remote: posting.remote, salary: posting.salary, profile },
        { ...options, signal: context.signal },
      );
      const candidate = await prisma.agentCandidate.create({ data: candidateData(posting, data), select: { id: true } });
      // Find jobs shows it too (#208).
      await saveScore(posting, data, promptVersion);
      kept.push(candidate.id);
      scored += 1;
      if (data.score >= settings.agentMinScore) queued += 1;
    } catch (error) {
      // Another run kept it first: it's seen either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      // One posting that fails doesn't stop the rest.
      if (error instanceof AiError) problem = error.message;
      else if (!context.signal.aborted) logServerError("job agent scoring", error);
    }
  }

  // Auto-draft: the best ultra-close matches from this run, one job each.
  let drafted = 0;
  if (settings.agentAutoDraft && settings.agentMaxDrafts > 0 && !context.signal.aborted) {
    const best = await prisma.agentCandidate.findMany({
      where: { id: { in: kept }, status: AgentCandidateStatus.SCORED, score: { gte: settings.agentMinScore } },
      orderBy: { score: "desc" },
      take: settings.agentMaxDrafts,
      select: { id: true },
    });
    for (const { id } of best) await startJob(agentDraftJob, { candidateId: id }, { key: draftJobKey(id) });
    drafted = best.length;
  }

  const waiting = `${queued} new ${queued === 1 ? "posting is" : "postings are"} waiting for a look.`;
  const message =
    scored === 0
      ? (problem ?? "No postings could be scored this time.")
      : queued === 0
        ? `Scored ${scored} new ${scored === 1 ? "posting" : "postings"}; none reached your minimum score of ${settings.agentMinScore}.`
        : drafted > 0
          ? `${waiting} Preparing ${drafted === 1 ? "a draft for the best one" : `drafts for the best ${drafted}`}.`
          : waiting;
  return finish({ ...counts, scored, drafted, message });
}
