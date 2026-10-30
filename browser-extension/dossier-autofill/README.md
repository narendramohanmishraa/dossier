# Dossier Autofill (Chrome / Edge)

A local browser helper for common job application forms. It imports a reduced profile export from your signed-in Dossier instance, fills empty fields on the active employer page, and **never submits the application**.

## Install

1. Open Dossier and sign in.
2. Go to **Profile** and choose **Download autofill profile**. The export intentionally excludes date of birth, home address, references, private facts, profile photo and API keys.
3. Download or clone this repository so the `browser-extension/dossier-autofill` folder is available locally.
4. In Chrome, open `chrome://extensions`. In Edge, open `edge://extensions`.
5. Turn on **Developer mode**, choose **Load unpacked**, and select the `dossier-autofill` folder.
6. Click the Dossier Autofill extension icon, import the downloaded JSON profile, then choose **Fill this page** on an employer application form.

## Safety and limitations

- The extension requests access to the active tab only when you press **Fill this page**. It does not request blanket access to every website.
- The profile is stored in this browser's local extension storage. Use it only on a trusted, personal browser profile; clear it in the extension when no longer needed.
- It fills supported, visible, empty text fields, textareas and matching select controls. Labels and field names vary, so review every populated field.
- It does not overwrite existing answers, tick legal declarations, enter passwords, choose demographic answers, attach files, click Continue, or submit an application.
- Attach the tailored resume and cover-letter PDFs yourself through the employer's upload control, then review and submit yourself.
- Multi-step forms may require opening each step and pressing **Fill this page** again. Some portals use custom controls or shadow DOM and may not be supported.
- The extension does not verify that a vacancy is still open. Always confirm the original job link and employer application page.

This is a convenience tool, not a guarantee of compatibility with every Applicant Tracking System (ATS).
