// revolut-webhook - Revolut meldet Transaktionen (TransactionCreated / TransactionStateChanged).
// verify_jwt = false (Revolut schickt kein Supabase-JWT); Schutz ist die HMAC-Signatur mit
// REVOLUT_WEBHOOK_SECRET (Edge-Function-Secret, setzt der Betreiber). Ohne gueltige Signatur passiert nichts.
// Doppelte Zustellungen erkennt revolut_webhook_events. Zuordnung ueber die Referenz (revolut_zahlungen.referenz),
// danach ueber die Transaktions-id.
import { signaturGueltig, statusAusTransaktion } from "../_shared/revolut-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("REVOLUT_WEBHOOK_SECRET") ?? "";
const KONTO = Deno.env.get("REVOLUT_ACCOUNT_ID") ?? "";
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  return { ok: r.ok, status: r.status, daten: t ? JSON.parse(t) : null };
}
const leer = (s: number) => new Response(null, { status: s });

Deno.serve(async (req) => {
  if (req.method !== "POST") return leer(405);
  const body = await req.text();
  if (!await signaturGueltig(SECRET, req.headers.get("Revolut-Signature"), req.headers.get("Revolut-Request-Timestamp"), body)) {
    console.warn("revolut-webhook: Signatur ungültig");
    return leer(401);
  }
  let ev: any;
  try { ev = JSON.parse(body); } catch { return leer(400); }
  const d = ev?.data ?? {};
  const schluessel = `${ev?.event}:${d.id}:${d.new_state ?? d.state ?? ""}`;
  const schon = await db(`revolut_webhook_events?schluessel=eq.${encodeURIComponent(schluessel)}&select=schluessel`);
  if (!schon.ok) return leer(500);                    // Revolut wiederholt spaeter
  if ((schon.daten ?? []).length) return leer(200);   // schon verarbeitet

  // Erst verarbeiten, dann als erledigt eintragen: scheitert die Verarbeitung, kommt die Wiederholung durch
  const ok = await verarbeiten(ev, d);
  if (!ok) return leer(500);
  const r = await db("revolut_webhook_events", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ schluessel, event: String(ev?.event ?? ""), nutzlast: ev }) });
  return leer(r.ok || r.status === 409 ? 200 : 500);
});

async function verarbeiten(ev: any, d: any): Promise<boolean> {
  const jetzt = new Date().toISOString();
  if (ev.event === "TransactionCreated") {
    const ref = String(d.reference ?? "");
    if (!ref.startsWith("Auszahlung KW")) return true;                         // fremde Buchung
    if (!(d.legs ?? []).some((l: any) => !KONTO || l.account_id === KONTO)) return true;   // anderes Konto
    const st = statusAusTransaktion(d.state) ?? "pending";
    // auch 'verworfen': ist zu der Referenz doch Geld geflossen, muss das sichtbar sein
    const r = await db(`revolut_zahlungen?referenz=eq.${encodeURIComponent(ref)}&status=in.(reserviert,entwurf,verworfen,pending)`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ revolut_transaction_id: d.id, status: st, aktualisiert_am: jetzt }) });
    if (!r.ok) return false;
    if (!(r.daten ?? []).length) console.warn("revolut-webhook: keine offene Zahlung zur Referenz", ref);
    return true;
  }
  if (ev.event === "TransactionStateChanged") {
    const st = statusAusTransaktion(d.new_state);
    if (!st || !d.id) return true;
    const r = await db(`revolut_zahlungen?revolut_transaction_id=eq.${encodeURIComponent(d.id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: st, aktualisiert_am: jetzt }) });
    return r.ok;
  }
  return true;
}
