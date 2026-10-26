// push-senden – neue Team-Nachricht als Web-Push an alle Geraete des Fahrers. Nur service_role (Trigger nachrichten_weiterleiten).
// Abos, die der Push-Dienst mit 404/410 ablehnt, werden geloescht.
// Secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT setzt scripts/telegram-einrichten.mjs.
import { pushSenden } from "../_shared/webpush.ts";
import { pushText } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID = { publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "", privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:sw.hydrafleet@gmail.com" };
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
function rolle(req: Request): string | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="))).role ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return antwort(405, { fehler: "nur_post" });
  if (rolle(req) !== "service_role") return antwort(403, { fehler: "nicht_berechtigt" });
  if (!VAPID.publicKey || !VAPID.privateKey) return antwort(500, { fehler: "nicht_eingerichtet" });
  const b = await req.json().catch(() => ({}));
  if (!Number.isInteger(b?.id)) return antwort(400, { fehler: "id_fehlt" });
  const [n] = await db(`nachrichten?id=eq.${b.id}&select=id,fahrer_nr,richtung,text,team_name,an_alle`);
  if (!n || n.richtung !== "team") return antwort(200, { gesendet: 0 });
  const abos = await db(`push_abos?fahrer_nr=eq.${n.fahrer_nr}&select=id,endpoint,p256dh,auth`);
  const nutzlast = JSON.stringify({ title: "HYDRAlink", body: pushText(n.team_name, n.text, n.an_alle === true), url: "/fahrer/#nachrichten", tag: "nachrichten" });
  let gesendet = 0, geloescht = 0;
  for (const a of abos) {
    try {
      const status = await pushSenden(a, nutzlast, VAPID);
      if (status === 404 || status === 410) { await db(`push_abos?id=eq.${a.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); geloescht++; }
      else if (status >= 200 && status < 300) gesendet++;
      else console.warn("push-senden: Abo", a.id, "Status", status);
    } catch (e) { console.warn("push-senden: Abo", a.id, (e as Error).message); }
  }
  return antwort(200, { gesendet, geloescht, abos: abos.length });
});
