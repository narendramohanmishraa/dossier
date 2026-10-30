/* global chrome */
const fileInput = document.getElementById("profile-file");
const fillButton = document.getElementById("fill");
const clearButton = document.getElementById("clear");
const state = document.getElementById("profile-state");
const result = document.getElementById("result");

function validProfile(value) {
  return Boolean(
    value &&
    value.format === "dossier-autofill-profile" &&
    value.version === 1 &&
    value.basics &&
    typeof value.basics.name === "string"
  );
}

async function refresh() {
  const { dossierProfile } = await chrome.storage.local.get("dossierProfile");
  const ready = validProfile(dossierProfile);
  fillButton.disabled = !ready;
  clearButton.disabled = !ready;
  state.textContent = ready
    ? `Profile loaded: ${dossierProfile.basics.name || "Unnamed"}`
    : "No profile loaded.";
}

fileInput.addEventListener("change", async () => {
  result.textContent = "";
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const profile = JSON.parse(await file.text());
    if (!validProfile(profile)) throw new Error("This is not a supported Dossier Autofill profile.");
    await chrome.storage.local.set({ dossierProfile: profile });
    await refresh();
    result.textContent = "Profile imported into this browser.";
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Could not import that file.";
  } finally {
    fileInput.value = "";
  }
});

fillButton.addEventListener("click", async () => {
  result.textContent = "";
  try {
    const { dossierProfile } = await chrome.storage.local.get("dossierProfile");
    if (!validProfile(dossierProfile)) throw new Error("Import your Dossier profile first.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open the employer application page first.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "DOSSIER_AUTOFILL", profile: dossierProfile });
    result.textContent = response?.message || "No supported empty fields were found.";
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Could not fill this page.";
  }
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("dossierProfile");
  await refresh();
  result.textContent = "Stored profile cleared from this browser.";
});

void refresh();
