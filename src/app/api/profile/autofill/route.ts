import { loadProfile } from "@/lib/profile-data";
import { route } from "@/lib/route";

/**
 * Download a reduced, local-only profile for the Dossier Autofill extension.
 * Sensitive/private fields (DOB, home address, references, facts and photos)
 * are deliberately excluded.
 */
export const GET = route(async () => {
  const profile = await loadProfile();
  const data = {
    format: "dossier-autofill-profile",
    version: 1,
    exportedAt: new Date().toISOString(),
    basics: {
      name: profile.basics.name,
      headline: profile.basics.headline,
      email: profile.basics.email,
      phone: profile.basics.phone,
      website: profile.basics.website,
      linkedin: profile.basics.linkedin,
      city: profile.basics.city,
      country: profile.basics.country,
      summary: profile.basics.summary,
    },
    skills: profile.skills.map((item) => item.name),
    languages: profile.languages.map((item) => ({ name: item.name, level: item.level })),
    experience: profile.experience.map((item) => ({
      role: item.role,
      company: item.company,
      location: item.location,
      bullets: item.bullets,
      startYear: item.startYear,
      startMonth: item.startMonth,
      endYear: item.endYear,
      endMonth: item.endMonth,
      current: item.current,
    })),
    education: profile.education.map((item) => ({
      degree: item.degree,
      school: item.school,
      notes: item.notes,
      startYear: item.startYear,
      endYear: item.endYear,
    })),
  };
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="dossier-autofill-profile-${date}.json"`,
      "cache-control": "private, no-store",
    },
  });
});
