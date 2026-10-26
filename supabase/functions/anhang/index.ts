// anhang – liefert der App ein Foto oder eine Sprachnachricht aus Telegram (die Datei liegt nur dort).
// GET /functions/v1/anhang?id=<nachricht>[&fahrer=<fahrer.id fuer die Buero-Vorschau>] mit dem JWT des Aufrufers.
// Ob er die Datei sehen darf, entscheidet fahrer_app_anhang (mit SEINEM JWT: Fahrer nur eigene, Buero nur in der Vorschau).
// Die Download-URL von Telegram enthaelt das Token – sie verlaesst nie diese Function, auch nicht in Fehlermeldungen.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS" };
const fehler = (s: number, text: string) => new Response(JSON.stringify({ fehler: text }), { status: s, headers: { "Content-Type": "application/json", ...cors } });

const TYPEN: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", webm: "audio/webm" };
const typVon = (pfad: string, art: string) => TYPEN[(pfad.split(".").pop() ?? "").toLowerCase()] ?? (art === "foto" ? "image/jpeg" : "audio/ogg");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return fehler(405, "nur_get");
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "", fahrer = u.searchParams.get("fahrer");
  if (!/^\d{1,15}$/.test(id) || (fahrer != null && !/^\d{1,9}$/.test(fahrer))) return fehler(400, "id_ungueltig");

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fahrer_app_anhang`, { method: "POST",
    headers: { apikey: ANON_KEY, Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ p_id: Number(id), p_fahrer_id: fahrer == null ? null : Number(fahrer) }) });
  const a = r.ok ? ((await r.json()) ?? [])[0] : null;
  if (!a?.tg_file_id) return fehler(404, "nicht gefunden");

  try {
    const g = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: a.tg_file_id }) });
    const gj = await g.json().catch(() => ({}));
    if (!gj.ok || !gj.result?.file_path) return fehler(404, "nicht mehr verfügbar");
    const d = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${gj.result.file_path}`);
    if (!d.ok || !d.body) return fehler(404, "nicht mehr verfügbar");
    return new Response(d.body, { status: 200, headers: { "Content-Type": typVon(gj.result.file_path, a.anhang),
      "Cache-Control": "private, max-age=86400", ...cors } });
  } catch {
    return fehler(502, "Telegram nicht erreichbar");   // nie die URL (Token) weitergeben
  }
});
