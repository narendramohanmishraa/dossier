import { expect, test } from "@playwright/test";

import { fakeJobSearches, resetData, sql } from "./support";

// The job agent end to end: one India-wide provider request, source-backed
// leadership listings, one automatic tailored draft, review and approval,
// duplicate suppression and the four-hour run guard.
test.beforeAll(resetData);
test.afterAll(async () => {
  await sql(`DELETE FROM "Setting" WHERE key LIKE 'agent%'`);
  await sql(`DELETE FROM "AgentCandidate"`);
});

const card = (page: import("@playwright/test").Page, title: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: title }) });

test("finds ultra-close India roles, drafts automatically and never submits applications", async ({ page }) => {
  await page.goto("/settings?section=agent");
  await page.getByLabel("What").fill("Head of IT OR IT Delivery Manager OR CTO");
  await page.getByLabel("Country").selectOption("in");
  await page.getByLabel("Drafts per run, at most").selectOption("1");
  await page.getByRole("switch", { name: "Run the job agent" }).click();
  await expect(page.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("All changes saved")).toBeVisible();

  const searches = await fakeJobSearches();
  await page.getByRole("link", { name: "Agent", exact: true }).click();
  await expect(page).toHaveURL("/agent");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText(/2 new postings are waiting for a look\./).first()).toBeVisible({ timeout: 30_000 });
  expect(await fakeJobSearches()).toBe(searches + 1);

  // The best 95+ match is drafted in its own background job and waits for review.
  const drafts = page.getByRole("region", { name: "Drafts to review" });
  await expect(drafts.getByRole("heading", { level: 3, name: "Head of IT" })).toBeVisible({ timeout: 60_000 });

  const scored = page.getByRole("region", { name: "Scored postings" });
  await expect(scored.getByRole("heading", { level: 3 })).toHaveText(["IT Delivery Manager"]);
  await expect(card(page, "IT Delivery Manager").getByRole("img", { name: "Score 97 of 100" })).toBeVisible();

  // CTO is source-backed but scores below 95, so it is not surfaced at all.
  await expect(page.getByRole("heading", { level: 3, name: "CTO" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /below your minimum score/ })).toHaveCount(0);
  const [draft] = await sql<{ id: string }>(`SELECT id FROM "Application" WHERE origin = 'AGENT'`);
  await expect(drafts.getByRole("link", { name: "Review draft" })).toHaveAttribute("href", `/applications/${draft.id}`);

  await page.goto("/applications?view=table");
  await expect(page.locator(`a[href="/applications/${draft.id}"]`)).toHaveCount(0);
  await page.goto(`/applications/${draft.id}`);
  await expect(page.getByRole("link", { name: "From the job agent · waiting for review" })).toHaveAttribute("href", "/agent");

  // Approval only turns it into a normal Draft application. It does not send it.
  await page.goto("/agent");
  await card(page, "Head of IT").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Added to Applications as a draft. Nothing has been sent.")).toBeVisible();
  await page.goto("/applications?view=table");
  await expect(page.locator(`a[href="/applications/${draft.id}"]`).first()).toBeVisible();
  expect(await sql(`SELECT status, "awaitingReview" FROM "Application" WHERE id = $1`, [draft.id])).toEqual([
    { status: "DRAFT", awaitingReview: false },
  ]);

  // Dismiss the other qualifying match.
  await page.goto("/agent");
  await card(page, "IT Delivery Manager").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Dismissed. It won't come back.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "IT Delivery Manager" })).toHaveCount(0);

  // A later scan uses one request, but never re-queues approved or dismissed jobs.
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  await sql(`UPDATE "Setting" SET value = $1 WHERE key = 'agentRuns'`, [JSON.stringify([{ at: fiveHoursAgo, manual: true, message: null }])]);
  await page.reload();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("No new postings this time.").first()).toBeVisible({ timeout: 30_000 });
  expect(await fakeJobSearches()).toBe(searches + 1); // Dossier serves the repeated query from its 30-minute cache

  // Manual scans share the four-hour gap with scheduled scans.
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await sql(`UPDATE "Setting" SET value = $1 WHERE key = 'agentRuns'`, [JSON.stringify([{ at: threeHoursAgo, manual: true, message: null }])]);
  await page.reload();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("The agent runs once every four hours. Try again in 1 hour.")).toBeVisible();
});
