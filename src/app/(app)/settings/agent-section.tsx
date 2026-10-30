"use client";

import Link from "next/link";
import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { useAutosave } from "@/hooks/use-autosave";
import type { Country } from "@/lib/job-search/countries";
import { searchHref, type JobSource, type SearchQuery } from "@/lib/job-search/search";

import { saveAgentSettings } from "../agent/actions";
import { RemoteOnlyField, SearchFields, type SearchFieldErrors } from "../jobs/search-fields";
import { SettingsSectionIntro } from "./settings-screen";

export type AgentSettings = {
  enabled: boolean;
  query: SearchQuery;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
};

const MIN_SCORES = [95, 96, 97, 98, 99, 100];
const SCORE_COUNTS = Array.from({ length: 30 }, (_, index) => index + 1);
const DRAFT_COUNTS = Array.from({ length: 11 }, (_, index) => index);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Settings → Job agent (E16-7): whether it runs, the search it runs,
 * and how much a run may do. Each change saves at once; the search
 * once typing pauses.
 */
export function AgentSection({
  initial,
  source,
  aiReady,
  countries,
}: {
  initial: AgentSettings;
  /** The source in Settings → Job search; null while job search is off. */
  source: JobSource | null;
  aiReady: boolean;
  countries: readonly Country[];
}) {
  const track = useTrackSave();
  const [settings, setSettings] = useState(initial);
  const [errors, setErrors] = useState<SearchFieldErrors>({});

  const change = (next: Partial<AgentSettings>) => {
    const previous = settings;
    setSettings({ ...settings, ...next });
    void track(saveAgentSettings(next)).then((result) => {
      if (!toastResult(result).ok) setSettings(previous);
    });
  };
  const { flush } = useAutosave(settings.query, (query) => track(saveAgentSettings({ query })));
  const setQuery = (patch: Partial<SearchQuery>) => {
    setErrors({});
    setSettings((current) => ({ ...current, query: { ...current.query, ...patch } }));
  };

  const turnOn = (on: boolean) => {
    if (on) {
      const problems = {
        keywords: settings.query.keywords.trim() ? undefined : "Type what the agent should look for.",
        country: settings.query.country ? undefined : "Choose a country.",
      };
      setErrors(problems);
      if (problems.keywords || problems.country) return;
      // With it, so a search started from Find jobs is saved too.
      return change({ enabled: true, query: settings.query, minScore: Math.max(95, settings.minScore), autoDraft: true });
    }
    change({ enabled: false });
  };

  return (
    <>
      <SettingsSectionIntro title="Job agent">
        Every four hours it searches across India, keeps only source-backed target-role listings, and scores them against your profile. Only 95/100+ matches enter the review queue. It never submits applications.
      </SettingsSectionIntro>

      {source === "ARBEITSAGENTUR" ? (
        // It searches on its own, which the BA's terms forbid most clearly (#223).
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          The agent doesn&apos;t search the Bundesagentur für Arbeit. Choose JSearch, Adzuna or FreeHire in{" "}
          <Link href="/settings?section=jobs" className="font-medium text-warning underline underline-offset-2">
            Settings → Job search
          </Link>{" "}
          for it.
        </p>
      ) : (!source || !aiReady) && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          {!source ? "The agent searches the source you choose in " : "The agent scores postings with the AI provider in "}
          <Link href={!source ? "/settings?section=jobs" : "/settings?section=ai"} className="font-medium text-warning underline underline-offset-2">
            {!source ? "Settings → Job search" : "Settings → AI provider"}
          </Link>
          {!source ? ", which is off. Choose one first." : ", which isn't set up yet. Choose one first."}
        </p>
      )}

      <Card padding="none" className="px-7 py-4">
        <Toggle
          label="Run the job agent"
          description={settings.enabled ? "On. One source search every four hours, with automatic resume and cover-letter drafts for 95+ matches." : "Off. Nothing is searched or scored until it is on."}
          checked={settings.enabled}
          onCheckedChange={turnOn}
        />
      </Card>

      <Card padding="none" className="flex flex-col gap-4 px-7 py-[26px]">
        <div className="flex flex-col gap-1">
          <h3 className="text-field font-medium">What it looks for</h3>
          <p className="text-meta text-muted">
            The same search as in{" "}
            <Link href={searchHref(settings.query)} className="font-medium text-ink underline underline-offset-2">
              Find jobs
            </Link>
            , through the source in Settings → Job search. Postings you saved, dismissed or applied for there are left out.
          </p>
        </div>
        <p className="text-meta text-muted">Each scan makes one India-wide source query to protect the request budget. Provider ranking determines which remote and city-based listings appear; coverage is not exhaustive city-by-city.</p>
        <p className="text-meta text-muted">The four-hour schedule uses at most 180 source requests in any rolling 30 days, leaving a 20-request reserve against a 200/month plan. Manual scans count against the same budget.</p>
        <div className="grid grid-cols-1 items-start gap-x-4 gap-y-4 sm:grid-cols-2" onBlur={flush}>
          <SearchFields value={settings.query} onChange={setQuery} source={source} countries={countries} errors={errors} />
          <div className="sm:col-span-2">
            <RemoteOnlyField value={settings.query} onChange={setQuery} source={source} />
          </div>
        </div>
      </Card>

      <Card padding="none" className="grid gap-x-[18px] gap-y-5 px-7 py-[26px] sm:grid-cols-2">
        <Select
          label="Minimum score"
          hint="Postings scored lower stay out of the queue."
          value={String(settings.minScore)}
          onChange={(event) => change({ minScore: Number(event.target.value) })}
        >
          {[...new Set([...MIN_SCORES, settings.minScore])].sort((a, b) => a - b).map((score) => (
            <option key={score} value={score}>
              {score} of 100
            </option>
          ))}
        </Select>
        <Select label="Postings scored per run" value={String(settings.maxScores)} onChange={(event) => change({ maxScores: Number(event.target.value) })}>
          {SCORE_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </Select>
        <Select
          label="Drafts per run, at most"
          value={String(settings.maxDrafts)}
          disabled={!settings.autoDraft}
          hint={settings.autoDraft ? undefined : "Turn on Prepare drafts on its own first"}
          onChange={(event) => change({ maxDrafts: Number(event.target.value) })}
        >
          {DRAFT_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </Select>
        <Toggle
          className="sm:col-span-2"
          label="Prepare drafts on its own"
          description={
            settings.autoDraft
              ? `For the best new postings of each run, up to ${plural(settings.maxDrafts, "draft", "drafts")}: a tailored resume and cover letter, waiting for your review.`
              : "Off. You choose which postings get a draft with Prepare draft."
          }
          checked={settings.autoDraft}
          onCheckedChange={(autoDraft) => change({ autoDraft })}
        />
      </Card>

      <p className="text-meta text-muted">
        One India-wide source search runs every four hours, with a hard cap of 180 searches in any rolling 30 days. Each run scores up to {plural(settings.maxScores, "posting", "postings")}
        {settings.autoDraft ? ` and prepares up to ${plural(settings.maxDrafts, "draft", "drafts")}` : ""}. Scoring and drafts go to your AI provider with your profile, as a new application does; the job source only gets the search.
      </p>
    </>
  );
}
