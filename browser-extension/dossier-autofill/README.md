# Dossier Autofill (Chrome / Edge)

A local browser extension for job application forms. It imports a reduced profile export from your signed-in Dossier instance, previews the fields it can recognise on the active employer page, and fills only the fields you select. It **never submits the application**.

## Install

1. Open Dossier and sign in.
2. Go to **Profile** and choose **Download autofill profile**. The export intentionally excludes date of birth, home address, references, private facts, profile photo and API keys.
3. Download this repository, then locate `browser-extension/dossier-autofill`.
4. In Chrome, open `chrome://extensions`. In Edge, open `edge://extensions`.
5. Turn on **Developer mode**, choose **Load unpacked**, and select the `dossier-autofill` folder.
6. Click the Dossier Autofill extension icon, import the downloaded JSON profile, then choose **Review fields on this page** on an employer application form.
7. Review the detected values, uncheck any field you do not want to populate, and click **Fill selected fields**.
8. Check every answer. Attach the tailored resume and cover-letter PDFs yourself, then continue and submit on the employer's website.

## Portal recognition

The extension recognises common application pages on Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS and Workable to label the page in the review panel. It uses visible labels, accessible names, placeholders, autocomplete values and common ATS data attributes to match standard profile fields. This is best-effort field recognition, not a guaranteed integration with every portal or custom form.

## Safety and limitations

- The extension asks for access to the active tab only when you click **Review fields on this page**. It does not request blanket access to every website.
- The profile is stored in this browser's local extension storage. Use it only on a trusted, personal browser profile; clear it in the extension when no longer needed.
- It fills only visible, empty text fields, textareas and unambiguous matching select controls. It previews values first and changes only the fields you select.
- It does not overwrite existing answers, tick legal declarations, enter passwords, choose demographic or eligibility answers, answer salary or notice-period questions, attach files, click Continue, or submit an application.
- Multi-step forms may require opening each step and clicking **Review fields on this page** again. Custom controls, shadow DOM, cross-origin frames and portals with unusual field markup may not be supported.
- The extension does not verify that a vacancy is still open. Always confirm the original job link and employer application page.

This is a convenience tool, not a guarantee of compatibility with every Applicant Tracking System (ATS).
