// telegram-senden – Fahrer-Nachricht ins Telegram-Thema des Fahrers (Team-Gruppe); legt das Thema beim ersten Mal an.
// Nur service_role: Trigger nachrichten_weiterleiten ({id}) und Nachhol-Lauf nachrichten-nachholen ({nachholen: true}).
// Teil 2: Lauf themen-pflegen ({themen: true}) legt Themen fuer alle Fahrer mit App an, Trigger gelesen ({gelesen: id}) setzt 👀.
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_GRUPPE_ID setzt scripts/telegram-einrichten.mjs.
// Das Token steckt in der URL – Fehlermeldungen deshalb nie aus fetch() durchreichen (sie enthalten die URL).
import { autoZeile, fahrerZeile, gleich, kopfPost, themenName, type Kopf } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
// Telegram erlaubt ~20 Nachrichten/Min in einer Gruppe; ein neues Thema kostet zwei (Anlegen + Kopf-Post)
const THEMEN_JE_LAUF = 6;
const THEMEN_PAUSE_MS = Number(Deno.env.get("TELEGRAM_THEMEN_PAUSE_MS") ?? 3500);
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const patch = (pfad: string, werte: Record<string, unknown>) =>
  db(pfad, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(werte) });
const loeschen = (pfad: string) => db(pfad, { method: "DELETE", headers: { Prefer: "return=minimal" } });

// Rolle aus dem Token; die Signatur prueft das Gateway (verify_jwt = true)
function rolle(req: Request): string | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="))).role ?? null;
  } catch { return null; }
}

class TgFehler extends Error {}
async function tg(methode: string, body: Record<string, unknown>) {
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new TgFehler(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new TgFehler(`Telegram ${methode} ${j.error_code ?? r.status}: ${j.description ?? "ohne Beschreibung"}`);
  return j.result;
}
const themaWeg = (e: unknown) => e instanceof TgFehler && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.message);

async function themaAnlegen(nr: number, k: Kopf): Promise<number> {
  const name = themenName(k);
  let thread: number;
  try {
    thread = (await tg("createForumTopic", { chat_id: GRUPPE, name })).message_thread_id;
  } catch (e) {
    await loeschen(`tg_themen?fahrer_nr=eq.${nr}&thread_id=is.null`).catch(() => {});   // naechster Versuch sofort
    throw e;
  }
  // erst der Kopf-Post, dann eintragen: wartende Aufrufe fuer denselben Fahrer senden so erst nach dem Kopf
  await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: kopfPost(k), parse_mode: "HTML" })
    .catch((e) => console.warn("Kopf-Post", e.message));
  await patch(`tg_themen?fahrer_nr=eq.${nr}`, { thread_id: thread, name, kennzeichen: k.kennzeichen ?? null });
  return thread;
}

async function autoGewechselt(nr: number, thread: number, k: Kopf) {
  const name = themenName(k);
  await tg("editForumTopic", { chat_id: GRUPPE, message_thread_id: thread, name }).catch((e) => console.warn("editForumTopic", e.message));
  if (k.kennzeichen) await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: autoZeile(k), parse_mode: "HTML" })
    .catch((e) => console.warn("Autowechsel-Zeile", e.message));
  await patch(`tg_themen?fahrer_nr=eq.${nr}`, { name, kennzeichen: k.kennzeichen ?? null });
}

// Thema des Fahrers; gibt es keins, legt es genau ein Aufruf an (tg_thema_reservieren), die anderen warten kurz
async function themaHolen(nr: number, k: Kopf): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const [t] = await db("rpc/tg_thema_reservieren", { method: "POST", body: JSON.stringify({ p_fahrer_nr: nr }) });
    if (t.reserviert) return await themaAnlegen(nr, k);
    if (t.thread_id) {
      if ((k.kennzeichen ?? null) !== (t.kennzeichen ?? null)) await autoGewechselt(nr, t.thread_id, k);
      return t.thread_id;
    }
    await warte(1000);
  }
  throw new Error("Thema wird noch angelegt");
}

async function senden(id: number): Promise<{ id: number; ok: boolean; fehler?: string }> {
  const [n] = await db(`nachrichten?id=eq.${id}&select=id,fahrer_nr,richtung,text,kopf,tg_message_id,tg_versuche`);
  if (!n || n.richtung !== "fahrer" || n.tg_message_id) return { id, ok: true };   // nichts zu tun, doppelter Aufruf harmlos
  await patch(`nachrichten?id=eq.${id}`, { tg_versuche: n.tg_versuche + 1 });
  const k: Kopf = n.kopf ?? {};
  try {
    let msg: { message_id: number } | null = null;
    for (let versuch = 0; versuch < 2 && !msg; versuch++) {
      const thread = await themaHolen(n.fahrer_nr, k);
      // geschlossenes Thema wieder oeffnen; bei offenem meldet Telegram einen Fehler – egal
      await tg("reopenForumTopic", { chat_id: GRUPPE, message_thread_id: thread }).catch(() => {});
      try {
        msg = await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: fahrerZeile(k, n.text),
          parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch (e) {
        if (!themaWeg(e) || versuch > 0) throw e;
        // Thema in Telegram geloescht: nur diese Zuordnung weg (ein parallel neu angelegtes Thema bleibt), im 2. Durchgang neu
        await loeschen(`tg_themen?fahrer_nr=eq.${n.fahrer_nr}&thread_id=eq.${thread}`);
      }
    }
    await patch(`nachrichten?id=eq.${id}`, { tg_message_id: msg!.message_id, tg_fehler: null });
    return { id, ok: true };
  } catch (e) {
    const fehler = String((e as Error)?.message ?? e).slice(0, 500);
    console.warn("telegram-senden", id, fehler);
    await patch(`nachrichten?id=eq.${id}`, { tg_fehler: fehler }).catch(() => {});
    return { id, ok: false, fehler };
  }
}

// Themen fuer alle berechtigten Fahrer: fehlende anlegen, bei Autowechsel umbenennen – in Etappen
async function themenPflegen() {
  const liste = await db("rpc/tg_fahrer_liste", { method: "POST", body: "{}" });
  const themen = new Map((await db("tg_themen?select=fahrer_nr,thread_id,kennzeichen")).map((t: any) => [t.fahrer_nr, t]));
  let angelegt = 0, umbenannt = 0, rest = 0;
  for (const f of liste) {
    const t: any = themen.get(f.fahrer_nr);
    const k: Kopf = { name: f.name, fahrer_nr: f.fahrer_nr, kennzeichen: f.kennzeichen, modell: f.modell };
    const fehlt = !t || !t.thread_id;
    const anders = !fehlt && (t.kennzeichen ?? null) !== (f.kennzeichen ?? null);
    if (!fehlt && !anders) continue;
    if (angelegt + umbenannt >= THEMEN_JE_LAUF) { rest++; continue; }
    try {
      if (fehlt) { await themaHolen(f.fahrer_nr, k); angelegt++; }
      else { await autoGewechselt(f.fahrer_nr, t.thread_id, k); umbenannt++; }
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/ 429:/.test(m)) { rest++; break; }   // Telegram bremst: der naechste Lauf macht weiter
      console.warn("themen-pflegen", f.fahrer_nr, m);
    }
    if (THEMEN_PAUSE_MS) await warte(THEMEN_PAUSE_MS);
  }
  return { angelegt, umbenannt, rest };
}

// Fahrer hat die Team-Nachricht gesehen: 👍 -> 👀 (nicht bei "an alle", die steht nicht im Thema)
async function gelesen(id: number) {
  const [n] = await db(`nachrichten?id=eq.${id}&select=richtung,an_alle,tg_message_id`);
  if (!n || n.richtung !== "team" || n.an_alle || !n.tg_message_id) return { id, ok: true };
  try {
    await tg("setMessageReaction", { chat_id: GRUPPE, message_id: n.tg_message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
    return { id, ok: true };
  } catch (e) {
    console.warn("gelesen", id, (e as Error).message);
    return { id, ok: false };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return antwort(405, { fehler: "nur_post" });
  // Trigger/Cron schicken den service_role-JWT aus dem Vault; andere Functions (anhang-senden, telegram-webhook) ihren
  // SUPABASE_SERVICE_ROLE_KEY – der ist live kein JWT (neues Schluesselformat), deshalb zusaetzlich direkter Vergleich
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (rolle(req) !== "service_role" && !gleich(tok, SERVICE_KEY)) return antwort(403, { fehler: "nicht_berechtigt" });
  if (!TOKEN || !GRUPPE) return antwort(500, { fehler: "nicht_eingerichtet" });
  const b = await req.json().catch(() => ({}));
  if (b?.themen === true) return antwort(200, await themenPflegen());
  if (Number.isInteger(b?.gelesen)) return antwort(200, await gelesen(b.gelesen));
  if (Number.isInteger(b?.thema)) {   // "Chat starten" aus dem Menue: Thema fuer genau diesen Fahrer
    const f = (await db("rpc/tg_fahrer_liste", { method: "POST", body: "{}" })).find((x: any) => x.fahrer_nr === b.thema);
    if (!f) return antwort(404, { fehler: "kein_fahrer" });
    try {
      return antwort(200, { thread_id: await themaHolen(f.fahrer_nr, { name: f.name, fahrer_nr: f.fahrer_nr, kennzeichen: f.kennzeichen, modell: f.modell }) });
    } catch (e) {
      console.warn("thema", b.thema, (e as Error).message);
      return antwort(500, { fehler: "thema_nicht_angelegt" });
    }
  }
  let ids: number[];
  if (b?.nachholen === true) {
    const grenze = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const offen = await db(`nachrichten?richtung=eq.fahrer&tg_message_id=is.null&tg_versuche=lt.5` +
      `&erstellt_am=lt.${encodeURIComponent(grenze)}&select=id&order=id.asc&limit=20`);
    ids = offen.map((x: { id: number }) => x.id);
  } else if (Number.isInteger(b?.id)) ids = [b.id];
  else return antwort(400, { fehler: "id_fehlt" });
  const ergebnis = [];
  for (const id of ids) ergebnis.push(await senden(id));   // der Reihe nach, damit die Reihenfolge im Thema stimmt
  return antwort(200, { ergebnis });
});
