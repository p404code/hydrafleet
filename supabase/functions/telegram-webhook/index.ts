// telegram-webhook – Telegram meldet Gruppennachrichten. Der Bot ist Admin („Themen verwalten“) und bekommt deshalb alle;
// gespeichert wird nur, was ein Teammitglied in ein Fahrer-Thema schreibt (nachrichten, richtung 'team').
// „Allgemein“ und alles andere wird verworfen, ohne es zu speichern oder zu loggen.
// verify_jwt = false (Telegram schickt kein Supabase-JWT); Schutz: Header X-Telegram-Bot-Api-Secret-Token.
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_GRUPPE_ID, TELEGRAM_WEBHOOK_SECRET setzt scripts/telegram-einrichten.mjs.
import { einordnen, gleich } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const HINWEIS = "Fotos, Sprachnachrichten und Sticker kommen noch nicht beim Fahrer an – bitte als Text schreiben.";
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
  const e = einordnen(u, GRUPPE);
  if (e.art === "ignorieren") return leer(200);

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
    body: JSON.stringify({ fahrer_nr: thema.fahrer_nr, richtung: "team", text: e.text, team_name: e.team_name, tg_message_id: e.message_id }) });
  const rt = await r.text();
  if (r.status === 409) return leer(200);                // schon gespeichert (Telegram hat wiederholt)
  if (!r.ok) { console.error("telegram-webhook: nachrichten", r.status, rt.slice(0, 200)); return leer(500); }
  // 👍 = beim Fahrer angekommen (gespeichert, Push ausgeloest)
  await tg("setMessageReaction", { chat_id: GRUPPE, message_id: e.message_id, reaction: [{ type: "emoji", emoji: "👍" }] })
    .catch((x) => console.warn("telegram-webhook: Reaktion", x.message));
  return leer(200);
});
