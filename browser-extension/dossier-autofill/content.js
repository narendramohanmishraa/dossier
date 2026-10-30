/* global chrome */
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

  const textById = (id) => {
    const node = document.getElementById(id);
    return node?.innerText || node?.textContent || "";
  };

  // ATSs often keep their useful field identifiers in data-* attributes.
  const fieldHint = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map(textById);
    const attributes = [
      "autocomplete",
      "aria-label",
      "placeholder",
      "name",
      "id",
      "data-automation-id",
      "data-testid",
      "data-test",
      "data-qa",
      "data-field",
      "data-field-name",
      "data-automation",
    ].map((name) => element.getAttribute(name) || "");
    const nearby = element.closest("label")?.innerText || "";
    return normalise([...attributes, ...labels, ...labelledBy, nearby].join(" "));
  };

  const fieldLabel = (element) => {
    const explicit = element.labels?.[0]?.innerText ||
      element.getAttribute("aria-label") ||
      (element.getAttribute("aria-labelledby") || "").split(/\s+/).map(textById).join(" ") ||
      element.getAttribute("placeholder");
    return String(explicit || element.name || element.id || "Application field").trim().slice(0, 120);
  };

  const splitName = (fullName) => {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { first: parts[0] || "", last: "" };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
  };

  const supportedControl = (element) => {
    if (element.multiple) return false;
    if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
    if (element.tagName !== "INPUT") return false;
    return ["", "text", "email", "tel", "url", "search"].includes((element.type || "").toLowerCase());
  };

  // Never infer answers to legal, demographic, identity or eligibility questions.
  const sensitiveHint = /gender|ethnic|race|disabilit|veteran|military|pronoun|preferred name|nickname|date of birth|birth date|\bdob\b|\bage\b|social security|national id|passport|citizenship|nationality|work authori[sz]|right to work|visa|sponsor|criminal|conviction|salary|compensation|expected pay|notice period|religion|marital status|sexual orientation|equal employment|\beeo\b|legal acknowledgement|privacy consent|terms and conditions/;

  const fieldValue = (element, profile) => {
    const hint = fieldHint(element);
    if (!hint || sensitiveHint.test(hint)) return null;

    const basics = profile.basics || {};
    const name = splitName(basics.name);
    const latest = (profile.experience || [])[0] || {};
    const education = (profile.education || [])[0] || {};

    if (/first name|given name|fname|first name|firstname|legalnamesection first/.test(hint)) return name.first;
    if (/last name|family name|surname|lname|lastname|legalnamesection last/.test(hint)) return name.last;
    if (/full name|your name|candidate name|legal name/.test(hint) || /\bname\b/.test(hint)) return basics.name;
    if (/e mail|email/.test(hint) || element.type === "email") return basics.email;
    if (/phone|mobile|telephone/.test(hint) || element.type === "tel") return basics.phone;
    if (/linkedin/.test(hint)) return basics.linkedin;
    if (/portfolio|personal website|website|personal site/.test(hint)) return basics.website;
    if (/current city|current location|city|town/.test(hint)) return basics.city;
    if (/current country|country name|country of residence/.test(hint)) return basics.country;
    if (/professional headline|headline/.test(hint)) return basics.headline;
    if (/current company|current employer|present employer|current organisation|current organization/.test(hint)) return latest.company;
    if (/current job title|current position|current role|current title/.test(hint)) return latest.role;
    if (/key skills|technical skills|skills/.test(hint)) return (profile.skills || []).join(", ");
    if (/spoken languages|languages|language skills/.test(hint)) {
      return (profile.languages || []).map((item) => item.name).join(", ");
    }
    if (/highest qualification|highest education|degree|education details/.test(hint)) {
      return [education.degree, education.school].filter(Boolean).join(" — ");
    }
    if (/professional summary|profile summary|about you|career summary/.test(hint)) return basics.summary;
    if (/experience summary|work experience summary|employment history summary/.test(hint)) {
      return (profile.experience || [])
        .map((item) => `${item.role} at ${item.company}\n${item.bullets || ""}`)
        .join("\n\n");
    }
    return null;
  };

  const selectOption = (element, value) => {
    const desired = normalise(value);
    if (!desired) return null;
    const matches = Array.from(element.options).filter((option) => {
      const label = normalise(option.textContent);
      return label === desired || (desired.length > 2 && label.includes(desired));
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const preview = (profile) => {
    const elements = Array.from(document.querySelectorAll("input, textarea, select"));
    const fields = [];
    let index = 0;

    for (const element of elements) {
      if (!supportedControl(element) || !visible(element) || element.disabled || element.readOnly) continue;
      if (String(element.value || "").trim() || element.dataset.dossierAutofilled) continue;
      const value = fieldValue(element, profile);
      if (!value || !String(value).trim()) continue;

      let displayValue = String(value);
      if (element.tagName === "SELECT") {
        const option = selectOption(element, value);
        if (!option) continue;
        displayValue = String(option.textContent || option.label || value).trim();
      }

      const id = element.dataset.dossierAutofillId || `field-${++index}`;
      element.dataset.dossierAutofillId = id;
      fields.push({
        id,
        label: fieldLabel(element),
        value: displayValue,
        kind: element.tagName.toLowerCase(),
      });
    }

    return {
      fields,
      portal: detectPortal(),
      message: fields.length
        ? `Found ${fields.length} supported empty field(s). Review and select what to fill.`
        : "No supported empty fields were found. Your form has not been changed.",
    };
  };

  const setValue = (element, value) => {
    if (!value || element.disabled || element.readOnly || !visible(element)) return false;
    if (String(element.value || "").trim()) return false;

    if (element.tagName === "SELECT") {
      const option = selectOption(element, value);
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

  const apply = (profile, ids) => {
    const selected = new Set(Array.isArray(ids) ? ids.map(String) : []);
    const elements = Array.from(document.querySelectorAll("[data-dossier-autofill-id]"));
    let count = 0;

    for (const element of elements) {
      if (!selected.has(element.dataset.dossierAutofillId) || !supportedControl(element)) continue;
      const value = fieldValue(element, profile);
      if (value && setValue(element, value)) count += 1;
    }

    return {
      count,
      message: count
        ? `Filled ${count} selected field(s). Review every answer before continuing. Nothing was submitted.`
        : "No selected fields were filled. The page has not been submitted.",
    };
  };

  const detectPortal = () => {
    const host = location.hostname.toLowerCase();
    if (host.includes("greenhouse")) return "Greenhouse";
    if (host.includes("lever.co")) return "Lever";
    if (host.includes("myworkdayjobs") || host.includes("workday")) return "Workday";
    if (host.includes("ashby")) return "Ashby";
    if (host.includes("smartrecruiters")) return "SmartRecruiters";
    if (host.includes("icims")) return "iCIMS";
    if (host.includes("workable")) return "Workable";
    return "Standard application form";
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "DOSSIER_PREVIEW") {
        sendResponse(preview(message.profile || {}));
      } else if (message?.type === "DOSSIER_APPLY") {
        sendResponse(apply(message.profile || {}, message.fieldIds || []));
      }
    } catch {
      sendResponse({
        fields: [],
        count: 0,
        message: "Autofill could not inspect this page. No application was submitted.",
      });
    }
    return true;
  });
})();
