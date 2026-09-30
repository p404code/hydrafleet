// post-senden - beantwortet Lenkererhebungen per SMTP ueber sw.hydrafleet@gmail.com (App-Passwort,
// Vault-Anbieter 'gmail'). Gmail legt die Mail unter "Gesendet" ab. Nur Buero. Nie zweimal je GZ.
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { antwortMail, knopfText, type Mieter, mieterZurTatzeit, sendbarGrund } from "../_shared/post-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
// Aufruf aus dem Dashboard (Browser): CORS wie fahrer-zugang, sonst scheitert schon die Vorabfrage.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${t}`);
  return t ? JSON.parse(t) : null;
}
function nutzer(req: Request): { id: string } | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")));
    return ["admin", "user"].includes(p.app_metadata?.app_role) ? { id: p.sub } : null;
  } catch { return null; }
}

async function smtpSenden(an: string, betreff: string, text: string): Promise<string> {
  const [v] = await db("verbindungen?anbieter=eq.gmail&status=eq.aktiv&select=id");
  if (!v) throw new Error("keine aktive Gmail-Verbindung (App-Passwort fehlt)");
  const z = await db("rpc/verbindung_zugang", { method: "POST", body: JSON.stringify({ p_verbindung_id: v.id }) });
  const msgId = `<${crypto.randomUUID()}@hydralink.hydrafleet>`;
  const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
    auth: { username: z.user, password: z.app_passwort } } });
  try {
    await client.send({ from: `Hydrafleet KG <${z.user}>`, to: an, subject: betreff, content: text,
      headers: { "Message-ID": msgId } });
  } finally {
    await client.close().catch(() => null);
  }
  return msgId;   // Gmail-Suche: rfc822msgid:<id>
}

async function laden(ids: string[]) {
  const liste = ids.map((i) => `"${i}"`).join(",");
  const rows = await db(`post_eingang?id=in.(${liste})&select=id,art,gz,kennzeichen,tatzeit,antwort_email,status,pruef_grund`);
  const mieter: Mieter[] = await db("mietverhaeltnisse?select=*");
  return { rows, mieter };
}
function entwurf(e: any, mieter: Mieter[]) {
  const nein = sendbarGrund(e);
  if (nein) return { ok: false, grund: nein };
  const m = mieterZurTatzeit(mieter, e.tatzeit);
  if (!m) return { ok: false, grund: "kein Mieter zur Tatzeit" };
  return { ok: true, m, mail: antwortMail(e, m) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const u = nutzer(req);
  if (!u) return antwort(403, { fehler: "nicht_berechtigt" });
  try {
    const b = await req.json();

    if (b.aktion === "abgleich") return antwort(400, { fehler: "abgleich_nicht_verfuegbar" });

    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string" && UUID.test(x)) : [];
    if (!ids.length || ids.length > 100) return antwort(400, { fehler: "ids_fehlen_oder_zu_viele" });
    const { rows, mieter } = await laden(ids);

    if (b.aktion === "vorschau") {
      return antwort(200, rows.map((e: any) => {
        const x = entwurf(e, mieter);
        return x.ok ? { id: e.id, ok: true, ...x.mail, mieter_kurz: x.m!.kurz, knopf: knopfText(x.mail!.an, x.m!) }
                    : { id: e.id, ok: false, grund: x.grund };
      }));
    }

    if (b.aktion === "senden") {
      const testAn = typeof b.test_an === "string" && b.test_an.includes("@") ? b.test_an.trim() : null;
      const erg = [];
      for (const e of rows) {
        const x = entwurf(e, mieter);
        if (!x.ok) { erg.push({ id: e.id, ok: false, grund: x.grund }); continue; }
        if (!testAn) {
          const schon = await db(`post_ausgang?gz=eq.${encodeURIComponent(e.gz)}&test_an=is.null&fehler=is.null&select=id`);
          if (schon.length) {
            await db(`post_eingang?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "beantwortet" }) });
            erg.push({ id: e.id, ok: false, grund: "bereits beantwortet" }); continue;
          }
        }
        const an = testAn ?? x.mail!.an;
        // Erst reservieren, dann senden: der Unique-Index post_ausgang_gz_einmal (test_an/fehler null)
        // laesst je GZ nur eine Zeile zu - ein zweiter gleichzeitiger Klick scheitert hier, nicht bei der Behoerde.
        let res: any;
        try {
          [res] = await db("post_ausgang", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
            eingang_id: e.id, gz: e.gz, an, betreff: x.mail!.betreff, text: x.mail!.text,
            mietverhaeltnis_id: x.m!.id, gesendet_von: u.id, test_an: testAn, quelle: "hydralink" }) });
        } catch (err) {
          erg.push({ id: e.id, ok: false, grund: String(err).includes("23505") ? "wird bereits gesendet oder ist beantwortet" : String(err).slice(0, 300) });
          continue;
        }
        let msgId: string;
        try {
          msgId = await smtpSenden(an, x.mail!.betreff, x.mail!.text);
        } catch (err) {
          const fehler = String(err).slice(0, 500);   // fehler gesetzt -> Reservierung frei, erneuter Versuch moeglich
          await db(`post_ausgang?id=eq.${res.id}`, { method: "PATCH", body: JSON.stringify({ fehler }) }).catch(() => null);
          erg.push({ id: e.id, ok: false, grund: fehler });
          continue;
        }
        // Ab hier ist die Mail raus: Status in jedem Fall setzen, sonst droht ein zweiter Versand.
        const protokoll = await db(`post_ausgang?id=eq.${res.id}`, { method: "PATCH", body: JSON.stringify({
          gmail_message_id: msgId, gesendet_am: new Date().toISOString() }) })
          .then(() => null, (err) => String(err).slice(0, 200));
        if (!testAn) await db(`post_eingang?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "beantwortet" }) });
        erg.push({ id: e.id, ok: true, gmail_message_id: msgId, ...(protokoll ? { warnung: `gesendet, Protokoll fehlgeschlagen: ${protokoll}` } : {}) });
      }
      return antwort(200, erg);
    }
    return antwort(400, { fehler: "unbekannte_aktion" });
  } catch (e) {
    return antwort(500, { fehler: String(e).slice(0, 500) });
  }
});
