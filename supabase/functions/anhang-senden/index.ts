// anhang-senden – Fahrer schickt aus der App ein Foto oder eine Sprachnachricht in sein Telegram-Thema.
// Die Datei bleibt nur in Telegram; in nachrichten steht die file_id. verify_jwt an: nur echte Fahrer (fahrer_app_profil mit
// dem JWT des Aufrufers – Buero/Vorschau bekommen 403). Pruefung von Art, Typ, Groesse, Dauer und Spam-Limit vor Telegram.
// Das Token steckt in der URL – Fehlermeldungen aus fetch() nie durchreichen.
import { anhangPruefen, anhangZeile, type Kopf } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...cors } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

class TgFehler extends Error { code = 0; }
async function tgForm(methode: string, fd: FormData) {
  let r: Response;
  try { r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, { method: "POST", body: fd }); }
  catch { throw new TgFehler(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new TgFehler(`Telegram ${methode} ${j.error_code ?? r.status}: ${j.description ?? "ohne Beschreibung"}`); e.code = j.error_code ?? r.status; throw e; }
  return j.result;
}
const endung = (typ: string) => typ.includes("ogg") ? ".ogg" : typ.includes("webm") ? ".webm" : typ.includes("mpeg") ? ".mp3" : ".m4a";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return antwort(405, { fehler: "nur_post" });
  if (!TOKEN || !GRUPPE) return antwort(500, { fehler: "nicht_eingerichtet" });

  // Wer schickt? fahrer_app_profil mit dem JWT des Aufrufers (Buero ohne Vorschau-Id bekommt keine Zeile)
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fahrer_app_profil`, { method: "POST", body: "{}",
    headers: { apikey: ANON_KEY, Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json" } });
  const p = pr.ok ? ((await pr.json()) ?? [])[0] : null;
  if (!p || p.vorschau || p.fahrer_nr == null) return antwort(403, { fehler: "Nur der Fahrer selbst kann senden" });

  const form = await req.formData().catch(() => null);
  const datei = form?.get("datei");
  if (!form || !(datei instanceof File)) return antwort(400, { fehler: "Datei fehlt" });
  const art = String(form.get("art") ?? "");
  const dauer = Math.round(Number(form.get("dauer") ?? 0)) || 0;
  const text = String(form.get("text") ?? "").trim().slice(0, 2000);
  const f = anhangPruefen(art, datei.type, datei.size, dauer);
  if (f) return antwort(f.code, { fehler: f.fehler });

  try {
    // Spam-Limit wie bei Text: hoechstens 10 Fahrer-Nachrichten in 10 Minuten
    const seit = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const juengst = await db(`nachrichten?fahrer_nr=eq.${p.fahrer_nr}&richtung=eq.fahrer&erstellt_am=gt.${encodeURIComponent(seit)}&select=id`);
    if (juengst.length >= 10) return antwort(429, { fehler: "Zu viele Nachrichten – bitte kurz warten" });

    // Thema des Fahrers (legt es an, falls er noch keins hat)
    const t = await fetch(`${SUPABASE_URL}/functions/v1/telegram-senden`, { method: "POST", headers: kopf, body: JSON.stringify({ thema: p.fahrer_nr }) });
    const tj = await t.json().catch(() => ({}));
    if (!t.ok || !tj.thread_id) return antwort(502, { fehler: "Senden hat nicht geklappt – bitte nochmal" });

    const k: Kopf = { name: p.name, fahrer_nr: p.fahrer_nr, kennzeichen: p.kennzeichen, modell: p.fahrzeug_modell };
    const formular = (feld: string, name: string) => {
      const fd = new FormData();
      fd.set("chat_id", GRUPPE); fd.set("message_thread_id", String(tj.thread_id));
      fd.set("caption", anhangZeile(k, art as "foto" | "sprache", text)); fd.set("parse_mode", "HTML");
      if (art === "sprache" && dauer) fd.set("duration", String(dauer));
      fd.set(feld, datei, name);
      return fd;
    };
    let msg: any, fileId: string | undefined;
    if (art === "foto") {
      msg = await tgForm("sendPhoto", formular("photo", "foto.jpg"));
      fileId = (msg.photo ?? []).reduce((a: any, b: any) => ((b.width ?? 0) >= (a?.width ?? 0) ? b : a), null)?.file_id;
    } else {
      const name = "sprache" + endung(datei.type);
      try { msg = await tgForm("sendVoice", formular("voice", name)); }
      catch (e) {
        if (!(e instanceof TgFehler) || e.code !== 400) throw e;
        msg = await tgForm("sendAudio", formular("audio", name));   // Telegram nimmt das Format nicht als Sprachnachricht
      }
      fileId = msg.voice?.file_id ?? msg.audio?.file_id ?? msg.document?.file_id;
    }
    if (!fileId) return antwort(502, { fehler: "Senden hat nicht geklappt – bitte nochmal" });

    // tg_message_id ist gesetzt: der Trigger ruft telegram-senden, das hier nichts mehr tut
    const [z] = await db("nachrichten", { method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ fahrer_nr: p.fahrer_nr, richtung: "fahrer", text, kopf: k, anhang: art, tg_file_id: fileId,
        tg_message_id: msg.message_id, dauer: art === "sprache" ? dauer : null }) });
    return antwort(200, { id: z.id });
  } catch (e) {
    console.warn("anhang-senden", p.fahrer_nr, String((e as Error)?.message ?? e).slice(0, 300));
    return antwort(502, { fehler: "Senden hat nicht geklappt – bitte nochmal" });
  }
});
