import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { saveAgentSettings } from "../agent/actions";
import { AgentSection, type AgentSettings } from "./agent-section";

vi.mock("../agent/actions", () => ({ saveAgentSettings: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));

const initial: AgentSettings = {
  enabled: false,
  query: { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
  minScore: 95,
  maxScores: 15,
  maxDrafts: 3,
  autoDraft: true,
};
const countries = [
  { code: "de", name: "Germany" },
  { code: "nl", name: "Netherlands" },
];
const open = (props: Partial<Parameters<typeof AgentSection>[0]> = {}) =>
  render(<AgentSection initial={initial} source="JSEARCH" aiReady countries={countries} {...props} />);

beforeEach(() => vi.clearAllMocks());

describe("Settings → Job agent (E16-7)", () => {
  it("is off until it's turned on, and turns on with the search, saved with it", async () => {
    const user = userEvent.setup();
    open();
    const toggle = screen.getByRole("switch", { name: "Run the job agent" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off. Nothing is searched or scored until it's on.");
    await user.click(toggle);
    expect(saveAgentSettings).toHaveBeenCalledWith({ enabled: true, query: initial.query });
    expect(toggle).toHaveAccessibleDescription("On. One source search every four hours, with automatic resume and cover-letter drafts for 95+ matches.");
  });

  it("needs keywords and a country to turn on", async () => {
    const user = userEvent.setup();
    open({ initial: { ...initial, query: { ...initial.query, keywords: "", country: "" } } });
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    expect(saveAgentSettings).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What")).toHaveAccessibleDescription("Type what the agent should look for.");
    expect(screen.getByLabelText("Country")).toHaveAccessibleDescription("Choose a country.");
    expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false");
  });

  it("saves the search once typing pauses, and the other choices at once", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("What"), " NLP");
    await waitFor(() => expect(saveAgentSettings).toHaveBeenLastCalledWith({ query: { ...initial.query, keywords: "Data scientist NLP" } }), { timeout: 2000 });
    await user.selectOptions(screen.getByLabelText("Minimum score"), "96 of 100");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ minScore: 96 });
    await user.selectOptions(screen.getByLabelText("Postings scored per run"), "20");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ maxScores: 20 });
  });

  it("prepares drafts by default and lets the user turn automatic drafting off", async () => {
    const user = userEvent.setup();
    open();
    const drafts = screen.getByLabelText("Drafts per run, at most");
    expect(drafts).toBeEnabled();
    const toggle = screen.getByRole("switch", { name: "Prepare drafts on its own" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.selectOptions(drafts, "5");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ maxDrafts: 5 });
    await user.click(toggle);
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ autoDraft: false });
    expect(toggle).toHaveAccessibleDescription("Off. You choose which postings get a draft with Prepare draft.");
  });

  it("explains the limits in plain words", () => {
    open();
    expect(screen.getByText(/^One source search every four hours, capped at 180 searches in any rolling 30 days\. Each run scores up to 15 postings\./)).toBeInTheDocument();
  });

  it("points to the source or AI provider while one isn't set up", () => {
    const { unmount } = open({ source: null });
    expect(screen.getByRole("note")).toHaveTextContent("The agent searches the source you choose in Settings → Job search, which is off. Choose one first.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
    unmount();
    open({ aiReady: false });
    expect(screen.getByRole("link", { name: "Settings → AI provider" })).toHaveAttribute("href", "/settings?section=ai");
  });

  it("says it doesn't search the Bundesagentur für Arbeit (#223)", () => {
    open({ source: "ARBEITSAGENTUR" });
    expect(screen.getByRole("note")).toHaveTextContent("The agent doesn't search the Bundesagentur für Arbeit. Choose JSearch, Adzuna or FreeHire in Settings → Job search for it.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
  });

  it("switches back and says why when a change isn't saved", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAgentSettings).mockResolvedValueOnce({ ok: false, error: "Type what the agent should look for before turning it on." });
    open();
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false"));
    expect(toast).toHaveBeenCalledWith("Type what the agent should look for before turning it on.");
  });
});
