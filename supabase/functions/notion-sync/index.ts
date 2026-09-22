// notion-sync - spiegelt die Notion-Stammdaten nach Supabase.
//
// Notion bleibt Quelle und Logik. Hier entstehen nur Lesekopien, damit das
// Dashboard Notion, Bolt und Uber nebeneinander zeigen kann. Geschrieben wird
// ausschliesslich in public.fuhrpark und public.notion_fahrer.
//
// public.fahrer bleibt UNBERUEHRT - die fuellt weiterhin der bestehende
// n8n-Workflow. Einzige Ausnahme: fahrer.notion_fahrer_id wird gesetzt, wo sie
// noch leer ist, und zwar durch die RPC notion_zuordnung_aktualisieren().
//
// API-Hinweis: seit Notion-Version 2025-09-03 sind Datenbanken und Datenquellen
// getrennt. /v1/databases/{id}/query ist abgekuendigt, richtig ist
// /v1/data_sources/{id}/query. Deshalb stehen unten Datenquellen-IDs.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTION       = "https://api.notion.com/v1";
const NOTION_VER   = "2026-03-11";

// Datenquellen-IDs der beiden Notion-Datenbanken
const DS_FUHRPARK = "5e514b18-c775-4bfd-8a31-4cfc227d6b2e";
const DS_FAHRER   = "e2102b0d-4248-426e-8011-da3cb895ffd9";

const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
               "Content-Type": "application/json" };

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, {
    ...init, headers: { ...kopf, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (name: string, args: unknown = {}) =>
  db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

async function upsert(tabelle: string, konflikt: string, zeilen: unknown[]) {
  for (let i = 0; i < zeilen.length; i += 500) {
    await db(`${tabelle}?on_conflict=${konflikt}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(zeilen.slice(i, i + 500)),
    });
  }
}

class ZugangUngueltig extends Error {}

// ---------- Notion ----------
async function alleSeiten(token: string, dataSource: string) {
  const seiten: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {          // bis 10.000 Zeilen
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION}/data_sources/${dataSource}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 401) throw new ZugangUngueltig("Notion-Token abgelehnt (401)");
    if (r.status === 404) {
      throw new ZugangUngueltig(
        `Datenquelle ${dataSource} nicht gefunden (404) - in Notion unter "Connections" fuer die Integration freigeben?`);
    }
    if (!r.ok) throw new Error(`Notion ${r.status}: ${text.slice(0, 400)}`);
    const j = JSON.parse(text);
    seiten.push(...(j.results ?? []));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  return seiten;
}

// ---------- Eigenschaftswerte auslesen ----------
// Formen laut Notion-Referenz: jeder Typ legt seinen Wert unter einem eigenen
// Schluessel ab, benannt wie der Typ selbst.
const prop = (s: any, name: string) => s?.properties?.[name];

function text(s: any, name: string): string | null {
  const p = prop(s, name);
  if (!p) return null;
  const arr = p.title ?? p.rich_text;
  if (Array.isArray(arr)) {
    const t = arr.map((x: any) => x.plain_text ?? x.text?.content ?? "").join("").trim();
    return t || null;
  }
  if (typeof p.phone_number === "string") return p.phone_number.trim() || null;
  if (typeof p.email === "string") return p.email.trim() || null;
  if (typeof p.url === "string") return p.url.trim() || null;
  return null;
}
const zahl = (s: any, name: string) => {
  const p = prop(s, name);
  return p && typeof p.number === "number" ? p.number : null;
};
const auswahl = (s: any, name: string) => prop(s, name)?.select?.name ?? null;
const mehrfach = (s: any, name: string) => {
  const p = prop(s, name);
  return Array.isArray(p?.multi_select) && p.multi_select.length
    ? p.multi_select.map((x: any) => x.name) : null;
};
const datum = (s: any, name: string) => prop(s, name)?.date?.start?.slice(0, 10) ?? null;
const haken = (s: any, name: string) => {
  const p = prop(s, name);
  return typeof p?.checkbox === "boolean" ? p.checkbox : null;
};
// "Fahrer ID" ist in der Oberflaeche eine auto-increment-ID, in der API unique_id.
const nummer = (s: any, name: string) => {
  const p = prop(s, name);
  if (p?.unique_id && typeof p.unique_id.number === "number") return p.unique_id.number;
  if (typeof p?.number === "number") return p.number;
  return null;
};

Deno.serve(async (req) => {
  let lauf: any = null;
  try {
    const body = req.headers.get("content-length") === "0"
      ? {} : await req.json().catch(() => ({}));
    const nurTest = body.test === true;

    const [v] = await db("verbindungen?anbieter=eq.notion&status=eq.aktiv&select=id,firma&limit=1");
    if (!v) throw new Error("Keine aktive Notion-Verbindung. Token fehlt noch - " +
                           "scripts/notion-token-speichern.js ausfuehren.");

    [lauf] = await db("sync_runs", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ verbindung_id: v.id, status: "laeuft" }),
    });

    const zugang = await rpc("verbindung_zugang", { p_verbindung_id: v.id });
    const token = zugang?.token;
    if (!token) throw new Error("Kein 'token' im Vault-Eintrag");
    const jetzt = new Date().toISOString();

    // --- Fuhrpark ---
    const fp = await alleSeiten(token, DS_FUHRPARK);
    const fpZeilen = fp.map((s) => {
      const kz = text(s, "Kennzeichen");
      if (!kz) return null;
      const modelle = mehrfach(s, "Modell");
      return {
        kennzeichen: kz,
        modell: modelle ? modelle.join(", ") : null,
        firma: auswahl(s, "FA."),
        pauschale: zahl(s, "Pauschale "),        // Achtung: Leerzeichen am Ende
        pauschal_modell: auswahl(s, "Pauschal Modell"),
        eigentuemer: mehrfach(s, "Eigentümer"),
        vin: text(s, "Fahrgestellnummer"),
        kilometerstand: text(s, "Kilometerstand"),
        ablauf_pickerl: datum(s, "Ablauf Pickerl"),
        polizze: text(s, "Polizze"),
        versicherung_monatlich: text(s, "Versicherung monatlich"),
        taxameter: mehrfach(s, "Taxameter"),
        bolt_werbung: haken(s, "BOLT WERBUNG"),
        dashcam: haken(s, "Dashcam"),
      };
    }).filter(Boolean) as any[];

    // Der Primaerschluessel kennzeichen_key entsteht aus public.kennzeichen_key().
    // Diese Normalisierung darf es nur EINMAL geben - deshalb schreibt eine RPC,
    // nicht dieser Code. Sonst wuerden zwei Fassungen auseinanderlaufen.
    let fpGeschrieben = 0;
    if (fpZeilen.length && !nurTest) {
      fpGeschrieben = await rpc("fuhrpark_ersetzen", { p_zeilen: fpZeilen });
    }

    // --- Fahrer ---
    const fa = await alleSeiten(token, DS_FAHRER);
    const faZeilen = fa.map((s) => ({
      notion_page_id: s.id,
      notion_fahrer_id: nummer(s, "Fahrer ID"),
      name: text(s, "Vor- Nachname"),
      telefon: text(s, "Telefon"),
      email: text(s, "Email"),
      status: auswahl(s, "Status"),
      firma: auswahl(s, "FA."),
      roh: { eigenschaften: Object.keys(s.properties ?? {}) },
      sync_run_id: lauf.id,
      aktualisiert_am: jetzt,
    }));
    if (faZeilen.length && !nurTest) {
      await upsert("notion_fahrer", "notion_page_id", faZeilen);
    }

    // --- Zuordnungen nachziehen (ruehrt nie an bestehende Werte) ---
    const zuordnung = nurTest ? null : await rpc("notion_zuordnung_aktualisieren");

    await db(`sync_runs?id=eq.${lauf.id}`, { method: "PATCH", body: JSON.stringify({
      ende: new Date().toISOString(), anzahl: fpZeilen.length + faZeilen.length,
      status: "ok", fehler: nurTest ? "nur Verbindungstest" : null }) });
    await db(`verbindungen?id=eq.${v.id}`, { method: "PATCH", body: JSON.stringify({
      letzter_abruf: new Date().toISOString(), letzter_fehler: null }) });

    return new Response(JSON.stringify({
      test: nurTest,
      fuhrpark_gelesen: fpZeilen.length, fuhrpark_geschrieben: fpGeschrieben,
      fahrer_gelesen: faZeilen.length,
      zuordnung,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const ungueltig = e instanceof ZugangUngueltig;
    const meldung = (ungueltig ? "zugang_ungueltig: " : "") + String(e).slice(0, 900);
    const jetzt = new Date().toISOString();
    if (lauf) {
      await db(`sync_runs?id=eq.${lauf.id}`, { method: "PATCH", body: JSON.stringify({
        ende: jetzt, status: "fehler", fehler: meldung }) }).catch(() => {});
    }
    await db("verbindungen?anbieter=eq.notion", { method: "PATCH", body: JSON.stringify({
      letzter_abruf: jetzt, letzter_fehler: meldung }) }).catch(() => {});
    return new Response(JSON.stringify({ fehler: meldung }), {
      status: 500, headers: { "Content-Type": "application/json" } });
  }
});
