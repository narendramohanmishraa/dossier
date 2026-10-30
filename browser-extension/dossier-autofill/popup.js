/* global chrome */
const fileInput = document.getElementById("profile-file");
const fillButton = document.getElementById("fill");
const applyButton = document.getElementById("apply");
const clearButton = document.getElementById("clear");
const state = document.getElementById("profile-state");
const result = document.getElementById("result");
const review = document.getElementById("review");
const fieldsList = document.getElementById("fields");
const portal = document.getElementById("portal");

let previewTabId = null;
let previewTabUrl = "";
let previewFields = [];

function validProfile(value) {
  return Boolean(
    value &&
    value.format === "dossier-autofill-profile" &&
    value.version === 1 &&
    value.basics &&
    typeof value.basics.name === "string"
  );
}

function clearPreview() {
  previewTabId = null;
  previewTabUrl = "";
  previewFields = [];
  fieldsList.replaceChildren();
  review.hidden = true;
  applyButton.disabled = true;
  portal.textContent = "";
}

async function getProfile() {
  const { dossierProfile } = await chrome.storage.local.get("dossierProfile");
  if (!validProfile(dossierProfile)) throw new Error("Import your Dossier profile first.");
  return dossierProfile;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    throw new Error("Open an employer application page first.");
  }
  return tab;
}

async function preparePage(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
}

function renderPreview(fields) {
  fieldsList.replaceChildren();
  for (const field of fields) {
    const label = document.createElement("label");
    label.className = "field";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = field.id;
    checkbox.checked = true;
    checkbox.addEventListener("change", updateApplyState);

    const copy = document.createElement("span");
    copy.className = "field-copy";

    const title = document.createElement("span");
    title.className = "field-label";
    title.textContent = field.label || "Application field";

    const value = document.createElement("span");
    value.className = "field-value";
    value.textContent = field.value || "";

    copy.append(title, value);
    label.append(checkbox, copy);
    fieldsList.append(label);
  }
  updateApplyState();
}

function updateApplyState() {
  const count = fieldsList.querySelectorAll('input[type="checkbox"]:checked').length;
  applyButton.disabled = count === 0 || previewTabId === null;
  applyButton.textContent = count ? `Fill ${count} selected field(s)` : "Select fields to fill";
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
  clearPreview();
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
  clearPreview();
  fillButton.disabled = true;
  try {
    const profile = await getProfile();
    const tab = await getActiveTab();
    await preparePage(tab);
    const response = await chrome.tabs.sendMessage(tab.id, { type: "DOSSIER_PREVIEW", profile });
    previewTabId = tab.id;
    previewTabUrl = tab.url;
    previewFields = Array.isArray(response?.fields) ? response.fields : [];
    portal.textContent = response?.portal || "Application page";
    renderPreview(previewFields);
    review.hidden = previewFields.length === 0;
    result.textContent = response?.message || "Review the fields before filling.";
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Could not inspect this page.";
  } finally {
    fillButton.disabled = false;
  }
});

applyButton.addEventListener("click", async () => {
  result.textContent = "";
  applyButton.disabled = true;
  try {
    const profile = await getProfile();
    const tab = await chrome.tabs.get(previewTabId);
    if (tab.url !== previewTabUrl) {
      clearPreview();
      throw new Error("This page has changed. Review the fields again before filling.");
    }

    const fieldIds = Array.from(fieldsList.querySelectorAll('input[type="checkbox"]:checked'))
      .map((checkbox) => checkbox.value);
    if (!fieldIds.length) throw new Error("Select at least one field to fill.");

    await preparePage(tab);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "DOSSIER_APPLY",
      profile,
      fieldIds,
    });
    result.textContent = response?.message || "Selected fields processed. Review the form.";
    clearPreview();
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Could not fill the selected fields.";
    updateApplyState();
  }
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("dossierProfile");
  clearPreview();
  await refresh();
  result.textContent = "Stored profile cleared from this browser.";
});

void refresh();
