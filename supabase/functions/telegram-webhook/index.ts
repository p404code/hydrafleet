// telegram-webhook – Telegram meldet Gruppennachrichten. Der Bot ist Admin („Themen verwalten“) und bekommt deshalb alle;
// gespeichert wird nur, was ein Teammitglied in ein Fahrer-Thema schreibt (nachrichten, richtung 'team').
// „Allgemein“ und alles andere wird verworfen, ohne es zu speichern oder zu loggen.
// verify_jwt = false (Telegram schickt kein Supabase-JWT); Schutz: Header X-Telegram-Bot-Api-Secret-Token.
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_GRUPPE_ID, TELEGRAM_WEBHOOK_SECRET setzt scripts/telegram-einrichten.mjs.
// Teil 2: Menue in "Allgemein" (Knoepfe an alle / Fahrer finden / Info). Offene Schritte in tg_menue; gespeichert wird aus
// "Allgemein" nur der Entwurf einer Nachricht an alle und – nach Bestaetigung durch denselben Nutzer – die Nachricht selbst.
import {
  aufforderung, einordnen, esc, gesendetText, gleich, infoText, knopfLesen, themaLink, trefferKnoepfe, vorschau, vorschauKnoepfe,
} from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const BOT_ID = TOKEN.split(":")[0];   // die Id des Bots steht vorne im Token
const ENTWURF_GUELTIG_MS = 24 * 3600 * 1000;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const HINWEIS = "Videos, Dateien und Sticker kommen beim Fahrer nicht an – Fotos und Sprachnachrichten schon.";
const letzterHinweis = new Map<number, number>();   // je Thema; gilt nur, solange diese Instanz lebt
const leer = (s: number) => new Response(null, { status: s });

const dbRoh = (pfad: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });

// Das Token steckt in der URL – Fehlermeldungen aus fetch() nie durchreichen
async function tg(methode: string, body: Record<string, unknown>) {
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new Error(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${methode} ${j.error_code ?? r.status}: ${j.description ?? "ohne Beschreibung"}`);
  return j.result;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return leer(405);
  if (!SECRET || !gleich(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", SECRET)) return leer(401);
  let u: unknown;
  try { u = await req.json(); } catch { return leer(200); }
  const e = einordnen(u, GRUPPE, BOT_ID);
  if (e.art === "ignorieren") return leer(200);
  if (e.art === "knopf") return await knopf(e);
  if (e.art === "allgemein_antwort") return await menueAntwort(e);

  const t = await dbRoh(`tg_themen?thread_id=eq.${e.thread_id}&select=fahrer_nr`);
  if (!t.ok) { console.error("telegram-webhook: tg_themen", t.status); return leer(500); }   // Telegram wiederholt
  const [thema] = await t.json();
  if (!thema) return leer(200);                          // Thema gehoert keinem Fahrer (von Hand angelegt)

  if (e.art === "ohne_text") {
    const jetzt = Date.now();
    if (jetzt - (letzterHinweis.get(e.thread_id) ?? 0) > 10 * 60 * 1000) {
      letzterHinweis.set(e.thread_id, jetzt);
      await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: e.thread_id, text: HINWEIS })
        .catch((x) => console.warn("telegram-webhook: Hinweis", x.message));
    }
    return leer(200);
  }

  const r = await dbRoh("nachrichten", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ fahrer_nr: thema.fahrer_nr, richtung: "team", text: e.text, team_name: e.team_name, tg_message_id: e.message_id,
      ...(e.anhang ? { anhang: e.anhang, tg_file_id: e.file_id, dauer: e.dauer ?? null } : {}) }) });
  const rt = await r.text();
  if (r.status === 409) return leer(200);                // schon gespeichert (Telegram hat wiederholt)
  if (!r.ok) { console.error("telegram-webhook: nachrichten", r.status, rt.slice(0, 200)); return leer(500); }
  // 👍 = beim Fahrer angekommen (gespeichert, Push ausgeloest)
  await tg("setMessageReaction", { chat_id: GRUPPE, message_id: e.message_id, reaction: [{ type: "emoji", emoji: "👍" }] })
    .catch((x) => console.warn("telegram-webhook: Reaktion", x.message));
  return leer(200);
});

/* ---------- Teil 2: Menue ---------- */

async function dbJson(pfad: string, init: RequestInit = {}) {
  const r = await dbRoh(pfad, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const menueZeile = async (id: number) => (await dbJson(`tg_menue?prompt_message_id=eq.${id}&select=*`))[0] ?? null;
const menueWeg = (id: number) => dbJson(`tg_menue?prompt_message_id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
const abgelaufen = (z: any) => !z || Date.now() - Date.parse(z.erstellt_am) > ENTWURF_GUELTIG_MS;

async function knopf(e: { id: string; daten: string; von: { id: number; name: string }; message_id: number | null }) {
  const antworte = (text?: string) => tg("answerCallbackQuery", { callback_query_id: e.id, ...(text ? { text } : {}) }).catch(() => {});
  const k = knopfLesen(e.daten);
  try {
    if (!k) { await antworte(); return leer(200); }
    if (k.aktion === "menue") {
      await antworte();
      if (k.wert === "info") { await tg("sendMessage", { chat_id: GRUPPE, text: infoText(), parse_mode: "HTML" }); return leer(200); }
      const m = await tg("sendMessage", { chat_id: GRUPPE, text: aufforderung(k.wert, e.von.name, e.von.id), parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true,
          input_field_placeholder: k.wert === "alle" ? "Nachricht an alle Fahrer" : "Name, Nr. oder Kennzeichen" } });
      await dbJson("tg_menue", { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ prompt_message_id: m.message_id, art: k.wert, tg_user_id: e.von.id, tg_name: e.von.name }) });
      return leer(200);
    }
    if (k.aktion === "start") {   // "Chat starten": Thema erst jetzt anlegen (telegram-senden kennt die Telegram-Logik dafuer)
      const f = (await dbJson("rpc/tg_fahrer_liste", { method: "POST", body: "{}" })).find((x: any) => x.fahrer_nr === k.nr);
      if (!f) { await antworte("Fahrer nicht gefunden"); return leer(200); }
      const r = await fetch(`${SUPABASE_URL}/functions/v1/telegram-senden`, { method: "POST", headers: kopf, body: JSON.stringify({ thema: k.nr }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.thread_id) { await antworte("Hat nicht geklappt – bitte nochmal"); return leer(200); }
      await antworte();
      await tg("sendMessage", { chat_id: GRUPPE, parse_mode: "HTML",
        text: `💬 Chat mit <b>${esc(f.name)}</b> ist bereit – was ihr dort schreibt, geht an den Fahrer.`,
        reply_markup: { inline_keyboard: [[{ text: "➡️ Zum Chat", url: themaLink(GRUPPE, Number(j.thread_id)) }]] } });
      return leer(200);
    }
    // ✅ Senden / ✖ Abbrechen einer Nachricht an alle
    const z = await menueZeile(k.id);
    if (!z || z.art !== "alle" || !z.entwurf || abgelaufen(z)) { await antworte("Abgelaufen – bitte neu über das Menü"); return leer(200); }
    if (String(z.tg_user_id) !== String(e.von.id)) { await antworte(`Nur ${z.tg_name} kann das senden`); return leer(200); }
    const vorschauId = z.vorschau_message_id ?? e.message_id;
    if (k.aktion === "alle_nein") {
      await menueWeg(k.id);
      await tg("editMessageText", { chat_id: GRUPPE, message_id: vorschauId, text: "✖ Abgebrochen" });
      await antworte();
      return leer(200);
    }
    // atomar und doppelt harmlos: dieselbe Aufforderungs-Id legt je Fahrer hoechstens eine Zeile an
    const n = await dbJson("rpc/tg_an_alle", { method: "POST",
      body: JSON.stringify({ p_text: z.entwurf, p_team_name: z.tg_name, p_tg_message_id: k.id }) });
    await menueWeg(k.id);
    if (Number(n) > 0) {
      await tg("editMessageText", { chat_id: GRUPPE, message_id: vorschauId, text: gesendetText(Number(n), z.tg_name, z.entwurf), parse_mode: "HTML" });
    }
    await antworte(Number(n) > 0 ? "Gesendet" : "Schon gesendet");
    return leer(200);
  } catch (x) {
    console.error("telegram-webhook: Knopf", (x as Error).message);
    await antworte("Hat nicht geklappt – bitte nochmal");
    return leer(200);
  }
}

async function menueAntwort(e: { antwort_auf: number; text: string; von: { id: number; name: string }; message_id: number }) {
  let z;
  try { z = await menueZeile(e.antwort_auf); } catch (x) { console.error("telegram-webhook: tg_menue", (x as Error).message); return leer(500); }
  if (!z || String(z.tg_user_id) !== String(e.von.id) || abgelaufen(z)) return leer(200);   // fremde Antwort: nichts speichern
  try {
    if (z.art === "suche") {
      const treffer = await dbJson("rpc/tg_fahrer_suchen", { method: "POST", body: JSON.stringify({ p_q: e.text }) });
      const knoepfe = trefferKnoepfe(treffer, GRUPPE);
      const text = treffer.length ? "Gefunden:" : "Kein Fahrer gefunden.";
      await tg("sendMessage", { chat_id: GRUPPE, text, reply_parameters: { message_id: e.message_id, allow_sending_without_reply: true },
        ...(knoepfe.inline_keyboard.length ? { reply_markup: knoepfe } : {}) });
      await menueWeg(z.prompt_message_id);
      return leer(200);
    }
    const anzahl = (await dbJson("rpc/tg_fahrer_liste", { method: "POST", body: "{}" })).length;
    const v = await tg("sendMessage", { chat_id: GRUPPE, text: vorschau(e.text, anzahl), parse_mode: "HTML",
      reply_markup: vorschauKnoepfe(z.prompt_message_id), reply_parameters: { message_id: e.message_id, allow_sending_without_reply: true } });
    await dbJson(`tg_menue?prompt_message_id=eq.${z.prompt_message_id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ entwurf: e.text, vorschau_message_id: v.message_id }) });
    return leer(200);
  } catch (x) {
    console.error("telegram-webhook: Menue-Antwort", (x as Error).message);
    return leer(200);
  }
}
