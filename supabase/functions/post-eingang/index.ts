// post-eingang - nimmt ein Behoerden-PDF an (USP-Skript auf taxi oder Upload im Buero),
// legt es in Bucket 'post' ab, liest es mit Claude aus und prueft das Ergebnis.
// Schreibt nur post_eingang und storage 'post'. Spec: docs/superpowers/specs/2026-09-28-post-strafen-design.md
import { type Auslese, fristErgaenzen, pruefeAuslese } from "../_shared/post-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
// Aufruf aus dem Dashboard (Browser): CORS wie fahrer-zugang, sonst scheitert schon die Vorabfrage.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-post-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS" };
const antwort = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (n: string, a: unknown) => db(`rpc/${n}`, { method: "POST", body: JSON.stringify(a) });

async function geheimnis(anbieter: string): Promise<Record<string, string>> {
  const [v] = await db(`verbindungen?anbieter=eq.${anbieter}&status=eq.aktiv&select=id`);
  if (!v) throw new Error(`keine aktive Verbindung '${anbieter}'`);
  return await rpc("verbindung_zugang", { p_verbindung_id: v.id });
}

function rolle(req: Request): "buero" | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")));
    return ["admin", "user"].includes(p.app_metadata?.app_role) ? "buero" : null;
  } catch { return null; }
}

async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64(b: Uint8Array) {
  let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const WERKZEUG = {
  name: "auslese",
  description: "Strukturierte Daten aus einem oesterreichischen Behoerdenschreiben an die Hydrafleet KG.",
  input_schema: {
    type: "object",
    properties: {
      art: { type: "string", enum: ["lenkererhebung", "strafverfuegung", "anonymverfuegung", "zahlungsaufforderung", "mahnung", "sonstige"],
        description: "VStVF 37 / 'Lenkererhebung' / 'Aufforderung zur Bekanntgabe des Lenkers' = lenkererhebung; VStVF 47 = strafverfuegung; VStVF 64 = anonymverfuegung; VStVF 57 = zahlungsaufforderung; VStVF 38a oder Mahnung zu einer Verkehrsstrafe = mahnung; alles andere (WKO, OeGK, Gericht, Steuer) = sonstige" },
      gz: { type: ["string", "null"], description: "Geschaeftszahl exakt wie im Dokument, z.B. MA67/266700676804/2026 oder VStV/926301390535/2026" },
      behoerde: { type: ["string", "null"] },
      kennzeichen: { type: ["string", "null"], description: "Kennzeichen exakt wie im Dokument, z.B. W-1234TX" },
      tatzeit: { type: ["string", "null"], description: "ISO 8601 mit Offset Europe/Vienna, z.B. 2026-09-14T17:32:00+02:00" },
      tatort: { type: ["string", "null"] },
      delikt: { type: ["string", "null"], description: "kurz, z.B. 'Parken ohne Parkschein'" },
      betrag: { type: ["number", "null"], description: "zu zahlender Betrag in Euro" },
      frist: { type: ["string", "null"], description: "Antwort-/Zahlungsfrist als YYYY-MM-DD" },
      antwort_email: { type: ["string", "null"], description: "E-Mail-Adresse der Behoerde fuer die Antwort, exakt wie im Dokument" },
      volltext: { type: "string", description: "vollstaendiger Text des Dokuments" },
    },
    required: ["art", "gz", "behoerde", "kennzeichen", "tatzeit", "tatort", "delikt", "betrag", "frist", "antwort_email", "volltext"],
  },
};

async function auslesen(pdf: Uint8Array): Promise<Auslese> {
  const { api_key } = await geheimnis("anthropic");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 8000,
      tools: [WERKZEUG], tool_choice: { type: "tool", name: "auslese" },
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(pdf) } },
        { type: "text", text: "Lies dieses Schreiben aus. Nichts erfinden: was nicht im Dokument steht, ist null." },
      ] }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const t = (j.content ?? []).find((c: any) => c.type === "tool_use");
  if (!t) throw new Error("Anthropic lieferte kein Ergebnis");
  return t.input as Auslese;
}

async function verarbeiten(id: string, pdf: Uint8Array, zugestelltAm: string | null) {
  try {
    const a = await auslesen(pdf);
    const gruende = pruefeAuslese(a, zugestelltAm);
    const vorschlag = a.kennzeichen && a.art !== "lenkererhebung" && a.art !== "sonstige"
      ? await rpc("post_fahrer_vorschlag", { p_kennzeichen: a.kennzeichen }) : null;
    const kk = a.kennzeichen ? await rpc("kennzeichen_key", { t: a.kennzeichen }) : null;
    // "Neu auslesen" darf Entscheidungen des Bueros nicht ueberschreiben: freigegebener Fahrer
    // bleibt, beantwortet/freigegeben/erledigt bleibt.
    const [vorher] = await db(`post_eingang?id=eq.${id}&select=status,freigegeben_am`);
    const patch: Record<string, unknown> = {
      art: a.art, gz: a.gz, behoerde: a.behoerde, kennzeichen: a.kennzeichen, kennzeichen_key: kk,
      tatzeit: a.tatzeit, tatort: a.tatort, delikt: a.delikt, betrag: a.betrag,
      frist: fristErgaenzen(a.art, a.frist, zugestelltAm),
      antwort_email: a.antwort_email?.trim().toLowerCase() ?? null, volltext: a.volltext, auslese_roh: a,
      pruef_grund: gruende.length ? gruende.join("; ") : null,
    };
    if (!vorher?.freigegeben_am) { patch.fahrer_vorschlag_id = vorschlag; patch.fahrer_id = vorschlag; }
    if (!["beantwortet", "freigegeben", "erledigt"].includes(vorher?.status)) patch.status = gruende.length ? "pruefen" : "offen";
    await db(`post_eingang?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    return { status: gruende.length ? "pruefen" : "offen", art: a.art, pruef_grund: gruende.join("; ") || null };
  } catch (e) {
    await db(`post_eingang?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      pruef_grund: `Auslesen fehlgeschlagen: ${String(e).slice(0, 300)}` }) });
    await db(`post_eingang?id=eq.${id}&status=not.in.(beantwortet,freigegeben,erledigt)`, { method: "PATCH",
      body: JSON.stringify({ status: "pruefen" }) });
    return { status: "pruefen", art: null, pruef_grund: String(e).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const istBuero = rolle(req) === "buero";
    let istServer = false;
    const pk = req.headers.get("x-post-key");
    if (pk) istServer = pk === (await geheimnis("usp")).post_key;
    if (!istBuero && !istServer) return antwort(403, { fehler: "nicht_berechtigt" });

    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const b = await req.json();
      if (b.aktion !== "neu_auslesen" || !istBuero) return antwort(400, { fehler: "unbekannte_aktion" });
      if (!/^[0-9a-f-]{36}$/i.test(String(b.id))) return antwort(400, { fehler: "id_ungueltig" });
      const [e] = await db(`post_eingang?id=eq.${b.id}&select=id,datei_pfad,zugestellt_am`);
      if (!e) return antwort(404, { fehler: "nicht_gefunden" });
      const d = await fetch(`${SUPABASE_URL}/storage/v1/object/post/${e.datei_pfad}`, { headers: kopf });
      if (!d.ok) throw new Error(`Storage ${d.status}`);
      return antwort(200, { id: e.id, doppelt: false, ...(await verarbeiten(e.id, new Uint8Array(await d.arrayBuffer()), e.zugestellt_am)) });
    }

    const f = await req.formData();
    const datei = f.get("datei");
    if (!(datei instanceof File)) return antwort(400, { fehler: "datei_fehlt" });
    const pdf = new Uint8Array(await datei.arrayBuffer());
    if (pdf.length < 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") return antwort(400, { fehler: "kein_pdf" });
    const hash = await sha256(pdf);
    const deliveryId = (f.get("delivery_id") as string | null)?.trim() || null;

    const [alt] = await db(`post_eingang?sha256=eq.${hash}&select=id,status,art,pruef_grund,delivery_id,zugestellt_am`);
    if (alt) {
      if (deliveryId && !alt.delivery_id) {
        await db(`post_eingang?id=eq.${alt.id}`, { method: "PATCH", body: JSON.stringify({ delivery_id: deliveryId }) });
      }
      // Erneuter Upload holt ein gescheitertes Auslesen nach (z.B. Anthropic-Guthaben leer, Timeout auf 'neu').
      if (alt.status === "neu" || String(alt.pruef_grund ?? "").startsWith("Auslesen fehlgeschlagen")) {
        return antwort(200, { id: alt.id, doppelt: true, nachgeholt: true, ...(await verarbeiten(alt.id, pdf, alt.zugestellt_am)) });
      }
      return antwort(200, { id: alt.id, status: alt.status, art: alt.art, pruef_grund: alt.pruef_grund, doppelt: true });
    }

    const jetzt = new Date();
    const pfad = `${jetzt.getUTCFullYear()}/${String(jetzt.getUTCMonth() + 1).padStart(2, "0")}/${hash}.pdf`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/post/${pfad}`, {
      method: "POST", headers: { ...kopf, "Content-Type": "application/pdf", "x-upsert": "true" }, body: pdf,
    });
    if (!up.ok) throw new Error(`Storage-Upload ${up.status}: ${await up.text()}`);

    const zugestellt = (f.get("zugestellt_am") as string | null)?.trim() || null;
    const [neu] = await db("post_eingang", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        quelle: f.get("quelle") === "upload" || istBuero ? "upload" : "usp",
        delivery_id: deliveryId, sha256: hash, datei_pfad: pfad, dateiname: datei.name || null,
        usp_absender: (f.get("usp_absender") as string | null) || null,
        usp_betreff: (f.get("usp_betreff") as string | null) || null,
        zugestellt_am: zugestellt && !isNaN(Date.parse(zugestellt)) ? zugestellt : null,
        status: "neu",
      }),
    });
    return antwort(200, { id: neu.id, doppelt: false, ...(await verarbeiten(neu.id, pdf, neu.zugestellt_am)) });
  } catch (e) {
    return antwort(500, { fehler: String(e).slice(0, 500) });
  }
});
