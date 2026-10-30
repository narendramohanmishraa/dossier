(() => {
  if (window.__dossierAutofillInstalled) return;
  window.__dossierAutofillInstalled = true;

  const normalise = (value) => String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const visible = (element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0;
  };

  const labelText = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    const aria = element.getAttribute("aria-label") || "";
    const placeholder = element.getAttribute("placeholder") || "";
    const nearby = element.closest("label")?.innerText || "";
    return normalise([
      element.name,
      element.id,
      element.getAttribute("autocomplete"),
      aria,
      placeholder,
      labels.join(" "),
      nearby,
    ].join(" "));
  };

  const splitName = (fullName) => {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { first: parts[0] || "", last: "" };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
  };

  const setValue = (element, value) => {
    if (!value || element.disabled || element.readOnly || !visible(element)) return false;
    if (String(element.value || "").trim()) return false;
    if (element.tagName === "SELECT") {
      const option = Array.from(element.options).find((item) => {
        const optionText = normalise(item.textContent);
        const desired = normalise(value);
        return optionText === desired || (desired.length > 2 && optionText.includes(desired));
      });
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(element, option.value);
    } else {
      const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) return false;
      setter.call(element, value);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dataset.dossierAutofilled = "true";
    return true;
  };

  const fieldValue = (element, profile) => {
    const hint = labelText(element);
    const basics = profile.basics || {};
    const name = splitName(basics.name);
    const latest = (profile.experience || [])[0] || {};
    const education = (profile.education || [])[0] || {};
    const supportedControl = element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.tagName === "SELECT";
    if (!supportedControl || element.multiple) return null;
    if (/first name|given name|fname/.test(hint)) return name.first;
    if (/last name|family name|surname|lname/.test(hint)) return name.last;
    if (/full name|your name|candidate name|\bname\b/.test(hint)) return basics.name;
    if (/e mail|email/.test(hint) || element.type === "email") return basics.email;
    if (/phone|mobile|telephone/.test(hint) || element.type === "tel") return basics.phone;
    if (/linkedin/.test(hint)) return basics.linkedin;
    if (/website|portfolio|personal site/.test(hint)) return basics.website;
    if (/city|current location|town/.test(hint)) return basics.city;
    if (/country/.test(hint)) return basics.country;
    if (/headline|professional title|professional headline/.test(hint)) return basics.headline;
    if (/current company|employer name|company name/.test(hint)) return latest.company;
    if (/current job title|current position|job title|professional title/.test(hint)) return latest.role;
    if (/skills|key skills|technical skills/.test(hint)) return (profile.skills || []).join(", ");
    if (/language/.test(hint)) return (profile.languages || []).map((item) => item.name).join(", ");
    if (/highest qualification|degree|education/.test(hint)) return [education.degree, education.school].filter(Boolean).join(" — ");
    if (/professional summary|profile summary|about you|summary/.test(hint)) return basics.summary;
    if (/experience summary|work experience summary/.test(hint)) {
      return (profile.experience || []).map((item) => `${item.role} at ${item.company}\n${item.bullets || ""}`).join("\n\n");
    }
    return null;
  };

  const fill = (profile) => {
    const elements = Array.from(document.querySelectorAll("input:not([type=file]):not([type=hidden]), textarea, select"));
    let count = 0;
    for (const element of elements) {
      if (!visible(element) || element.disabled || element.readOnly || element.dataset.dossierAutofilled) continue;
      if (["checkbox", "radio", "submit", "button", "password", "file", "hidden"].includes((element.type || "").toLowerCase())) continue;
      const value = fieldValue(element, profile);
      if (value && setValue(element, value)) count += 1;
    }
    return count;
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "DOSSIER_AUTOFILL") return;
    try {
      const count = fill(message.profile || {});
      sendResponse({
        count,
        message: count
          ? `Filled ${count} empty field(s). Review every value before continuing.`
          : "No supported empty fields were found. Your form has not been submitted.",
      });
    } catch {
      sendResponse({ count: 0, message: "Autofill failed. Your form has not been submitted." });
    }
    return true;
  });
})();
