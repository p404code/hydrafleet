// Fuhrpark <-> Notion: „Fahrer aktuell“ lesen und zurückschreiben (Autoliste, Spec 2026-11-01-autoliste-design.md).
// Reine Logik ohne Netz/DB – die Edge Functions geben fetch-Aufrufe als deps hinein. Tests: scripts/test-fuhrpark-logik.mjs

export const ohneStriche = (id: unknown) => String(id ?? "").replace(/-/g, "").toLowerCase();

// Notion-Relation „Fahrer aktuell“ einer Fuhrpark-Seite -> Fahrer-Nr. (unbekannte Seiten fallen weg)
export function fahrerIdsAusRelation(seite: any, nrJePageId: Map<string, number>): number[] {
  const rel = seite?.properties?.["Fahrer aktuell"]?.relation;
  if (!Array.isArray(rel)) return [];
  const out: number[] = [];
  for (const r of rel) {
    const nr = nrJePageId.get(ohneStriche(r?.id));
    if (nr != null && !out.includes(nr)) out.push(nr);
  }
  return out;
}

export const relationBody = (pageIds: string[]) =>
  ({ properties: { "Fahrer aktuell": { relation: pageIds.map((id) => ({ id })) } } });

type Soll = { kennzeichen_key: string; notion_page_id: string | null; page_ids: string[] | null };
type Deps = {
  soll: (keys: string[] | null) => Promise<Soll[]>;
  patch: (pageId: string, body: unknown) => Promise<{ ok: boolean; status: number; text: string }>;
  erledigt: (key: string) => Promise<void>;
};

// Setzt in Notion „Fahrer aktuell“ der offenen Autos. Erfolg -> aus fuhrpark_notion_offen streichen,
// Fehler -> bleibt offen (notion-sync versucht es beim nächsten Lauf wieder). Bricht nie ab.
export async function notionNachziehen(keys: string[] | null, deps: Deps) {
  const ok: string[] = [];
  const fehler: { key: string; text: string }[] = [];
  for (const z of await deps.soll(keys)) {
    if (!z.notion_page_id) { fehler.push({ key: z.kennzeichen_key, text: "keine Notion-Seite bekannt" }); continue; }
    try {
      const r = await deps.patch(z.notion_page_id, relationBody(z.page_ids ?? []));
      if (r.ok) { await deps.erledigt(z.kennzeichen_key); ok.push(z.kennzeichen_key); }
      else fehler.push({ key: z.kennzeichen_key, text: `Notion ${r.status}: ${String(r.text).slice(0, 200)}` });
    } catch (e) {
      fehler.push({ key: z.kennzeichen_key, text: String(e).slice(0, 200) });
    }
  }
  return { ok, fehler };
}
