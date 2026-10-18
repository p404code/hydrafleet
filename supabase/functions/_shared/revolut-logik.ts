// Reine Logik fuer revolut-auszahlung / revolut-webhook (ohne Netz, ohne Datenbank).
// Tests: node --test scripts/test-revolut-logik.mjs

export type Kandidat = {
  notion_fahrer_id: number; name: string; betrag: number | string | null;
  kontoinhaber: string | null; iban: string | null; bic: string | null; revtag: string | null;
  geprueft: boolean; counterparty_id: string | null; counterparty_account_id: string | null; empfaenger: string | null;
  csv_exportiert: number | string | null; zahlung_status: string | null; zahlung_betrag: number | string | null;
  seit_freigabe_ueberwiesen?: number | string | null;
};
export type Posten = Kandidat & { betrag_eur: number; referenz: string };
export type Uebersprungen = { notion_fahrer_id: number; name: string; betrag: number; grund: string };

// Zahlungen in diesem Zustand blockieren keinen neuen Entwurf
export const NEU_ERLAUBT = ["verworfen", "failed", "declined"];

export function wocheGueltig(w: unknown): w is string {
  return typeof w === "string" && /^\d{4}-W\d{2}k?$/.test(w);
}

// "Auszahlung KW42/26 FHR-123" - eindeutig je Woche und Fahrer, der Webhook ordnet darueber zu
export function referenz(woche: string, nr: number): string {
  const m = /^(\d{4})-W(\d{2})/.exec(woche);
  if (!m) throw new Error("Woche ungültig: " + woche);
  return `Auszahlung KW${Number(m[2])}/${m[1].slice(2)} FHR-${nr}`;
}

const zahl = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

// Wer kommt in den Entwurf, wer nicht (mit Grund). gewaehlt = Notion-Nrn. aus dem Dashboard (null = alle).
export function auswahl(kand: Kandidat[], woche: string, gewaehlt: number[] | null = null) {
  const posten: Posten[] = [], uebersprungen: Uebersprungen[] = [];
  for (const k of kand) {
    const betrag = zahl(k.betrag);
    const weg = (grund: string) => uebersprungen.push({ notion_fahrer_id: k.notion_fahrer_id, name: k.name, betrag, grund });
    if (k.zahlung_status && !NEU_ERLAUBT.includes(k.zahlung_status)) { weg("schon bei Revolut (" + k.zahlung_status + ")"); continue; }
    if (!(betrag > 0)) { weg(betrag < 0 ? "negativer Betrag" : "kein Betrag"); continue; }
    if (!k.iban) { weg("keine Bankdaten"); continue; }
    if (!k.geprueft) { weg("Bankdaten ungeprüft"); continue; }
    if (zahl(k.csv_exportiert) > 0) { weg("schon per Revolut-CSV exportiert"); continue; }
    if (zahl(k.seit_freigabe_ueberwiesen) > 0) { weg("seit Freigabe schon überwiesen (" + zahl(k.seit_freigabe_ueberwiesen).toFixed(2) + " €)"); continue; }
    if (betrag > 20000) { weg("Betrag über 20.000 €"); continue; }
    if (gewaehlt && !gewaehlt.includes(k.notion_fahrer_id)) { weg("abgewählt"); continue; }
    posten.push({ ...k, betrag_eur: betrag, referenz: referenz(woche, k.notion_fahrer_id) });
  }
  const summe = zahl(posten.reduce((t, p) => t + p.betrag_eur, 0));
  return { posten, uebersprungen, summe };
}

// Revolut verlangt bei Privatpersonen Vor- und Nachname getrennt
export function nameTeilen(inhaber: string): { first_name: string; last_name: string } | null {
  const t = String(inhaber || "").trim().split(/\s+/).filter(Boolean);
  if (t.length < 2) return null;
  return { first_name: t.slice(0, -1).join(" "), last_name: t[t.length - 1] };
}

// Body fuer POST /counterparty. Revtag hat Vorrang (Revolut intern), sonst IBAN (+BIC) und Kontoinhaber.
export function counterpartyBody(k: Pick<Kandidat, "kontoinhaber" | "iban" | "bic" | "revtag">, mitRevtag = true) {
  const inhaber = String(k.kontoinhaber || "").trim();
  if (mitRevtag && k.revtag) {
    return { art: "revtag" as const, body: { profile_type: "personal", name: inhaber, revtag: k.revtag.replace(/^@/, "") } };
  }
  const iban = String(k.iban || "");
  const name = nameTeilen(inhaber);
  const body: Record<string, unknown> = { bank_country: iban.slice(0, 2), currency: "EUR", iban };
  if (k.bic) body.bic = k.bic;
  if (name) body.individual_name = name; else body.company_name = inhaber;
  return { art: "iban" as const, body };
}

// Revolut-Zustand einer Transaktion -> revolut_zahlungen.status
export function statusAusTransaktion(state: unknown): string | null {
  const s = String(state || "").toLowerCase();
  if (s === "created" || s === "pending") return "pending";
  return ["completed", "declined", "failed", "reverted"].includes(s) ? s : null;
}

/* ---------- Kryptografie (WebCrypto: Deno und Node) ---------- */

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const txt = (s: string) => new TextEncoder().encode(s);

function derLaenge(n: number): number[] {
  if (n < 0x80) return [n];
  const b: number[] = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return [0x80 | b.length, ...b];
}
// PKCS#1 ("BEGIN RSA PRIVATE KEY", z. B. LibreSSL auf dem Mac) in PKCS#8 einpacken - WebCrypto kann nur PKCS#8.
export function pkcs1ZuPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oktett = [0x04, ...derLaenge(pkcs1.length), ...pkcs1];
  const inhalt = [0x02, 0x01, 0x00, ...algo, ...oktett];
  return new Uint8Array([0x30, ...derLaenge(inhalt.length), ...inhalt]);
}
export function pemZuPkcs8(pem: string): Uint8Array {
  const roh = String(pem || "").replace(/\\n/g, "\n");
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(roh);
  const b64 = roh.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) throw new Error("privater Schlüssel fehlt");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return pkcs1 ? pkcs1ZuPkcs8(der) : der;
}

// Client-Assertion fuer /auth/token: iss = Domain der Redirect-URI, sub = Client-ID, aud = https://revolut.com
export async function clientAssertion(pem: string, clientId: string, iss: string, jetztSek = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("pkcs8", pemZuPkcs8(pem) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const kopf = b64url(txt(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const last = b64url(txt(JSON.stringify({ iss, sub: clientId, aud: "https://revolut.com", exp: jetztSek + 300 })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, txt(kopf + "." + last)));
  return kopf + "." + last + "." + b64url(sig);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export async function hmacHex(secret: string, daten: string) {
  const key = await crypto.subtle.importKey("raw", txt(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, txt(daten))));
}
// Revolut-Signature: "v1=<hex>[,v1=<hex>]" ueber "v1.<Revolut-Request-Timestamp>.<roher Body>", hoechstens 5 Min alt
export async function signaturGueltig(secret: string, kopfSig: string | null, zeitstempel: string | null, body: string,
                                      jetztMs = Date.now()): Promise<boolean> {
  if (!secret || !kopfSig || !zeitstempel || !/^\d+$/.test(zeitstempel)) return false;
  if (Math.abs(jetztMs - Number(zeitstempel)) > 5 * 60 * 1000) return false;
  const soll = "v1=" + await hmacHex(secret, `v1.${zeitstempel}.${body}`);
  return kopfSig.split(",").map((s) => s.trim()).some((s) => s.length === soll.length && gleich(s, soll));
}
function gleich(a: string, b: string) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

/* ---------- Ueberweisungshistorie ---------- */

export type GegenInfo = { cp: string; name: string; iban: string | null };
// GET /counterparties -> Konto-id der Gegenpartei -> Name/IBAN, und Gegenpartei-id -> Name
export function gegenparteienKarte(liste: any[]) {
  const konten = new Map<string, GegenInfo>(), namen = new Map<string, string>();
  for (const c of liste || []) {
    if (!c?.id) continue;
    namen.set(c.id, c.name ?? "");
    for (const a of c.accounts ?? []) {
      if (a?.id) konten.set(a.id, { cp: c.id, name: c.name ?? a.name ?? "", iban: a.iban ? String(a.iban).toUpperCase().replace(/[^A-Z0-9]/g, "") : null });
    }
  }
  return { konten, namen };
}

// Eine Revolut-Transaktion -> Zeile fuer revolut_buchungen; nur ausgehende Ueberweisungen, sonst null
export function buchungAusTransaktion(tx: any, karte: ReturnType<typeof gegenparteienKarte>) {
  if (!tx?.id || tx.type !== "transfer") return null;
  const leg = (tx.legs ?? []).find((l: any) => Number(l.amount) < 0);
  if (!leg) return null;
  const cpId: string | null = leg.counterparty?.id ?? null, cpKonto: string | null = leg.counterparty?.account_id ?? null;
  const info = cpKonto ? karte.konten.get(cpKonto) : undefined;
  const name = info?.name || (cpId ? karte.namen.get(cpId) : "") || String(leg.description ?? "").replace(/^(To|An|Payment to)\s+/i, "").trim() || null;
  return {
    id: String(tx.id), typ: tx.type, state: tx.state ?? null, erstellt_am: tx.created_at,
    abgeschlossen_am: tx.completed_at ?? null, konto_id: leg.account_id ?? null,
    betrag: Math.round(Math.abs(Number(leg.amount)) * 100) / 100, waehrung: leg.currency ?? null,
    referenz: tx.reference ?? null, beschreibung: leg.description ?? null,
    gegen_counterparty_id: info?.cp ?? cpId, gegen_account_id: cpKonto, gegen_name: name, gegen_iban: info?.iban ?? null,
  };
}
