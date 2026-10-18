// revolut-auszahlung - legt die Wochenauszahlung als Payment-Draft im Revolut-Business-Konto (Serdo) an.
// Scopes READ + WRITE, KEIN PAY: freigegeben wird in der Revolut-App vom Betreiber. Nur Buero, nur freigegebene Wochen.
// Zugangsdaten ausschliesslich als Edge-Function-Secrets (setzt der Betreiber):
//   REVOLUT_PRIVATE_KEY, REVOLUT_CLIENT_ID, REVOLUT_REFRESH_TOKEN, REVOLUT_ACCOUNT_ID, REVOLUT_ENV (sandbox|production),
//   optional REVOLUT_ISS (Domain der Redirect-URI, Standard hydrafleet.pages.dev).
// Der Access-Token (40 Min) wird je Aufruf geholt und nie gespeichert. Nie Secrets oder Tokens loggen.
// Aktionen: vorschau | anlegen {nrs} | status (je mit woche) | buchungen_abrufen (Ueberweisungshistorie, auch Zeitplan)
import { auswahl, buchungAusTransaktion, clientAssertion, counterpartyBody, gegenparteienKarte, type Kandidat, statusAusTransaktion,
  wocheGueltig } from "../_shared/revolut-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ENV = (Deno.env.get("REVOLUT_ENV") ?? "sandbox") === "production" ? "production" : "sandbox";
const BASIS = ENV === "production" ? "https://b2b.revolut.com/api/1.0" : "https://sandbox-b2b.revolut.com/api/1.0";
const CFG = {
  key: Deno.env.get("REVOLUT_PRIVATE_KEY") ?? "", client: Deno.env.get("REVOLUT_CLIENT_ID") ?? "",
  refresh: Deno.env.get("REVOLUT_REFRESH_TOKEN") ?? "", konto: Deno.env.get("REVOLUT_ACCOUNT_ID") ?? "",
  iss: Deno.env.get("REVOLUT_ISS") ?? "hydrafleet.pages.dev",
};

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
// Rolle aus dem Token; die Signatur prueft das Gateway (verify_jwt = true)
function nutzer(req: Request): { name: string; automatik: boolean } | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")));
    if (p.role === "service_role") return { name: "Automatik", automatik: true };   // Zeitplan, nur buchungen_abrufen
    return ["admin", "user"].includes(p.app_metadata?.app_role) ? { name: p.app_metadata?.app_name || "Büro", automatik: false } : null;
  } catch { return null; }
}

class RevolutFehler extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function accessToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: CFG.refresh, client_id: CFG.client,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await clientAssertion(CFG.key, CFG.client, CFG.iss),
  });
  const r = await fetch(`${BASIS}/auth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const t = await r.text();
  // Antwort enthaelt den Token: nie ausgeben, nur Status + Fehlercode
  if (!r.ok) { let c = ""; try { c = JSON.parse(t).error ?? ""; } catch { /* */ } throw new RevolutFehler(r.status, `Anmeldung bei Revolut fehlgeschlagen (${r.status}${c ? ", " + c : ""})`); }
  return JSON.parse(t).access_token;
}
async function rv(token: string, pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${BASIS}${pfad}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) {
    let m = t.slice(0, 300); try { const j = JSON.parse(t); m = j.message ?? j.error ?? m; } catch { /* */ }
    throw new RevolutFehler(r.status, `Revolut ${r.status} bei ${pfad.split("/").slice(0, 2).join("/")}: ${m}`);
  }
  return t ? JSON.parse(t) : null;
}

async function konto(token: string) {
  const k = await rv(token, `/accounts/${encodeURIComponent(CFG.konto)}`);
  return { name: k.name ?? "", kontostand: Number(k.balance) || 0, waehrung: k.currency ?? "", state: k.state ?? "" };
}

// Gegenpartei anlegen: Revtag zuerst, wenn das scheitert IBAN. Liefert id + Konto-id.
async function gegenpartei(token: string, k: Kandidat) {
  let versuch = counterpartyBody(k, true);
  let cp: any;
  try { cp = await rv(token, "/counterparty", { method: "POST", body: JSON.stringify(versuch.body) }); }
  catch (e) {
    if (versuch.art !== "revtag") throw e;
    versuch = counterpartyBody(k, false);
    cp = await rv(token, "/counterparty", { method: "POST", body: JSON.stringify(versuch.body) });
  }
  const konten: any[] = cp.accounts ?? [];
  const passend = konten.find((a) => a.iban && a.iban.replace(/\s/g, "") === k.iban) ?? konten[0];
  return { id: cp.id as string, konto: (passend?.id ?? null) as string | null, art: versuch.art };
}

/* ---------- Ueberweisungshistorie (revolut_buchungen) ---------- */

async function alleGegenparteien(token: string) {
  const liste: any[] = [];
  let vor: string | null = null;
  for (let i = 0; i < 50; i++) {
    let seite: any[];
    try { seite = await rv(token, `/counterparties?limit=1000${vor ? "&created_before=" + encodeURIComponent(vor) : ""}`); }
    catch (e) { if (i === 0 && e instanceof RevolutFehler && e.status === 400) return await rv(token, "/counterparties"); throw e; }
    liste.push(...seite);
    if (seite.length < 1000) break;
    vor = seite[seite.length - 1].created_at;
  }
  return liste;
}
// Transaktionen von neu nach alt in [von, bis), seitenweise; liefert das aelteste erreichte Datum und ob fertig
async function seitenHolen(token: string, von: string, bis: string, karte: ReturnType<typeof gegenparteienKarte>, frist: number) {
  let zeilen = 0, aeltestes = bis;
  for (let i = 0; i < 200; i++) {
    if (Date.now() > frist) return { zeilen, aeltestes, fertig: false };
    const seite: any[] = await rv(token, `/transactions?from=${encodeURIComponent(von)}&to=${encodeURIComponent(aeltestes)}&count=1000`);
    const rows = seite.map((t) => buchungAusTransaktion(t, karte)).filter(Boolean)
      .map((r) => ({ ...r, aktualisiert_am: new Date().toISOString() }));
    for (let j = 0; j < rows.length; j += 500) {
      await db("revolut_buchungen?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(j, j + 500)) });
    }
    zeilen += rows.length;
    if (seite.length < 1000) return { zeilen, aeltestes: von, fertig: true };
    const min = seite.reduce((m, t) => (t.created_at < m ? t.created_at : m), seite[0].created_at);
    if (min >= aeltestes) return { zeilen, aeltestes, fertig: false };   // kein Fortschritt (gleiche Zeitstempel) - naechster Lauf
    aeltestes = min;
  }
  return { zeilen, aeltestes, fertig: false };
}
// nurNeu: nur die letzten 14 Tage (vor jedem Entwurf). Sonst zusaetzlich die Historie weiter nach hinten, bis sie vollstaendig ist.
async function buchungenAbrufen(token: string, nurNeu: boolean) {
  const frist = Date.now() + 100_000;   // Edge Function lebt hoechstens 150 s
  const [stand] = await db("revolut_abruf?id=eq.1&select=*");
  try {
    const karte = gegenparteienKarte(await alleGegenparteien(token));
    const jetzt = new Date().toISOString();
    const neu = await seitenHolen(token, new Date(Date.now() - 14 * 864e5).toISOString(), jetzt, karte, frist);
    let hist = { zeilen: 0, aeltestes: stand?.aeltestes ?? null, fertig: !!stand?.historie_fertig };
    if (!nurNeu && !hist.fertig) {
      const h = await seitenHolen(token, "2015-01-01T00:00:00Z", stand?.aeltestes ?? jetzt, karte, frist);
      hist = { zeilen: h.zeilen, aeltestes: h.aeltestes, fertig: h.fertig };
    }
    const offen = await db("rpc/revolut_buchungen_zuordnen", { method: "POST", body: "{}" });
    await db("revolut_abruf?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      letzter_lauf: jetzt, letzter_fehler: null, historie_fertig: hist.fertig, aeltestes: hist.aeltestes,
      anzahl: neu.zeilen + hist.zeilen }) });
    return { zeilen: neu.zeilen + hist.zeilen, historie_fertig: hist.fertig, offen };
  } catch (e) {
    await db("revolut_abruf?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ letzter_lauf: new Date().toISOString(), letzter_fehler: (e as Error).message.slice(0, 500) }) }).catch(() => null);
    throw e;
  }
}

async function zahlungen(woche: string) {
  return await db(`revolut_zahlungen?woche=eq.${encodeURIComponent(woche)}&select=notion_fahrer_id,name,betrag,iban_ende,empfaenger,referenz,status,fehler,revolut_draft_id,aktualisiert_am&order=name`);
}

async function vorschau(woche: string) {
  const kand: Kandidat[] = await db("rpc/revolut_kandidaten", { method: "POST", body: JSON.stringify({ p_woche: woche }) });
  const a = auswahl(kand, woche);
  let k: Awaited<ReturnType<typeof konto>> | null = null, konto_fehler: string | null = null;
  try { k = await konto(await accessToken()); } catch (e) { konto_fehler = (e as Error).message; }
  return {
    umgebung: ENV, woche, summe: a.summe, konto: k, konto_fehler,
    fehlbetrag: k ? Math.max(0, Math.round((a.summe - k.kontostand) * 100) / 100) : null,
    posten: a.posten.map((p) => ({ notion_fahrer_id: p.notion_fahrer_id, name: p.name, betrag: p.betrag_eur, iban_ende: (p.iban ?? "").slice(-4),
      revtag: !!p.revtag, gegenpartei: !!p.counterparty_id, referenz: p.referenz })),
    uebersprungen: a.uebersprungen, zahlungen: await zahlungen(woche),
  };
}

async function anlegen(woche: string, nrs: number[], von: string) {
  const token = await accessToken();
  // Erst die letzten Ueberweisungen holen: wer seit der Freigabe schon Geld bekam (auch direkt in der Revolut-App), bleibt draussen
  try { await buchungenAbrufen(token, true); }
  catch (e) { return antwort(502, { fehler: "Bisherige Überweisungen konnten nicht geprüft werden – kein Entwurf angelegt. " + (e as Error).message }); }
  const kand: Kandidat[] = await db("rpc/revolut_kandidaten", { method: "POST", body: JSON.stringify({ p_woche: woche }) });
  const a = auswahl(kand, woche, nrs);
  if (!a.posten.length) return antwort(400, { fehler: "keine_posten", uebersprungen: a.uebersprungen });

  const k = await konto(token);
  if (k.waehrung && k.waehrung !== "EUR") return antwort(409, { fehler: "konto_nicht_eur", konto: k });
  if (k.kontostand < a.summe) {
    return antwort(409, { fehler: "kontostand", summe: a.summe, kontostand: k.kontostand,
      fehlbetrag: Math.round((a.summe - k.kontostand) * 100) / 100 });
  }

  // Gegenparteien (nur fuer gepruefte Bankdaten; neue IBAN -> Spalte ist leer -> neu anlegen)
  const uebersprungen = [...a.uebersprungen];
  const bereit: (typeof a.posten[number] & { cp: string; cp_konto: string | null; art: string })[] = [];
  for (const p of a.posten) {
    try {
      let cp = p.counterparty_id, cpk = p.counterparty_account_id, art = p.empfaenger ?? "iban";
      if (!cp) {
        const g = await gegenpartei(token, p);
        cp = g.id; cpk = g.konto; art = g.art;
        const ok = await db("rpc/revolut_counterparty_setzen", { method: "POST",
          body: JSON.stringify({ p_nr: p.notion_fahrer_id, p_iban: p.iban, p_cp: cp, p_cp_konto: cpk, p_art: art }) });
        if (!ok) { uebersprungen.push({ notion_fahrer_id: p.notion_fahrer_id, name: p.name, betrag: p.betrag_eur, grund: "Bankdaten inzwischen geändert" }); continue; }
      }
      bereit.push({ ...p, cp: cp!, cp_konto: cpk, art });
    } catch (e) {
      uebersprungen.push({ notion_fahrer_id: p.notion_fahrer_id, name: p.name, betrag: p.betrag_eur, grund: "Gegenpartei: " + (e as Error).message });
    }
  }
  if (!bereit.length) return antwort(400, { fehler: "keine_posten", uebersprungen });

  const reserviert: number[] = await db("rpc/revolut_reservieren", { method: "POST", body: JSON.stringify({
    p_woche: woche, p_von: von,
    p_posten: bereit.map((p) => ({ nr: p.notion_fahrer_id, name: p.name, betrag: p.betrag_eur, iban_ende: (p.iban ?? "").slice(-4),
      empfaenger: p.art, referenz: p.referenz, cp: p.cp })),
  }) });
  const posten = bereit.filter((p) => reserviert.includes(p.notion_fahrer_id));
  for (const p of bereit) if (!reserviert.includes(p.notion_fahrer_id)) {
    uebersprungen.push({ notion_fahrer_id: p.notion_fahrer_id, name: p.name, betrag: p.betrag_eur, grund: "gerade von jemand anderem angelegt" });
  }
  if (!posten.length) return antwort(409, { fehler: "schon_angelegt", uebersprungen });
  const summe = Math.round(posten.reduce((t, p) => t + p.betrag_eur, 0) * 100) / 100;
  const nrListe = posten.map((p) => p.notion_fahrer_id).join(",");
  const zeilen = `revolut_zahlungen?woche=eq.${encodeURIComponent(woche)}&notion_fahrer_id=in.(${nrListe})&status=eq.reserviert`;

  let draft: any;
  try {
    draft = await rv(token, "/payment-drafts", { method: "POST", body: JSON.stringify({
      title: `HYDRAlink Auszahlung ${woche.replace(/^(\d{4})-W(\d+).*/, "KW$2/$1")}`,
      payments: posten.map((p) => ({
        account_id: CFG.konto, amount: p.betrag_eur, currency: "EUR", reference: p.referenz,
        receiver: p.cp_konto ? { counterparty_id: p.cp, account_id: p.cp_konto } : { counterparty_id: p.cp },
      })),
    }) });
  } catch (e) {
    // Nichts angelegt: Reservierung freigeben (verworfen = darf neu angelegt werden)
    await db(zeilen, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "verworfen", fehler: (e as Error).message.slice(0, 500), aktualisiert_am: new Date().toISOString() }) });
    throw e;
  }
  await db(zeilen, { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "entwurf", revolut_draft_id: draft.id, aktualisiert_am: new Date().toISOString() }) });
  return antwort(200, { umgebung: ENV, draft_id: draft.id, anzahl: posten.length, summe, kontostand: k.kontostand, uebersprungen,
    zahlungen: await zahlungen(woche) });
}

// Stand nachziehen (falls ein Webhook fehlt). Zuerst die echten Buchungen ueber die Referenz suchen -
// erst wenn es sicher keine gibt, gilt ein in Revolut entfernter Entwurf als verworfen (darf neu angelegt
// werden). Umgekehrt waere eine doppelte Zahlung moeglich: ein freigegebener Entwurf verschwindet ebenfalls.
async function status(woche: string) {
  const offen = await db(`revolut_zahlungen?woche=eq.${encodeURIComponent(woche)}&status=in.(entwurf,pending)&select=notion_fahrer_id,referenz,status,revolut_draft_id,revolut_counterparty_id,revolut_transaction_id,erstellt_am`);
  if (offen.length) {
    const token = await accessToken();
    const ab = new Date(Math.min(...offen.map((z: any) => Date.parse(z.erstellt_am))) - 864e5).toISOString();
    const txs: any[] = await rv(token, `/transactions?from=${encodeURIComponent(ab)}&count=1000`);
    const vollstaendig = txs.length < 1000;
    const zuRef = new Map<string, any>();
    for (const t of txs) if (t.reference && (t.legs ?? []).some((l: any) => l.account_id === CFG.konto)) zuRef.set(t.reference, t);
    const entwuerfe = new Map<string, any>();
    const setzen = (z: any, felder: Record<string, unknown>) =>
      db(`revolut_zahlungen?woche=eq.${encodeURIComponent(woche)}&notion_fahrer_id=eq.${z.notion_fahrer_id}&status=eq.${z.status}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...felder, aktualisiert_am: new Date().toISOString() }) });
    for (const z of offen) {
      const t = zuRef.get(z.referenz);
      if (t) {
        const st = statusAusTransaktion(t.state) ?? "pending";
        if (st !== z.status || t.id !== z.revolut_transaction_id) await setzen(z, { status: st, revolut_transaction_id: t.id });
        continue;
      }
      if (z.status !== "entwurf" || !z.revolut_draft_id) continue;
      if (!entwuerfe.has(z.revolut_draft_id)) {
        let d: any = null;
        try { d = await rv(token, `/payment-drafts/${encodeURIComponent(z.revolut_draft_id)}`); }
        catch (e) { if (!(e instanceof RevolutFehler && e.status === 404)) throw e; }
        entwuerfe.set(z.revolut_draft_id, d);
      }
      const d = entwuerfe.get(z.revolut_draft_id);
      const p = d && ((d.payments ?? []).find((x: any) => x.reference === z.referenz)
        ?? (d.payments ?? []).find((x: any) => x.receiver?.counterparty_id === z.revolut_counterparty_id));
      const s = String(p?.state ?? "").toLowerCase();
      if (p && (s === "declined" || s === "failed")) await setzen(z, { status: s, fehler: p.reason ?? p.error_message ?? null });
      else if (p && (s === "cancelled" || s === "deleted") && vollstaendig) await setzen(z, { status: "verworfen" });
      else if (!p && vollstaendig) await setzen(z, { status: "verworfen", fehler: "Entwurf in Revolut nicht mehr vorhanden, keine Buchung gefunden" });
    }
  }
  return { umgebung: ENV, woche, zahlungen: await zahlungen(woche) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const u = nutzer(req);
  if (!u) return antwort(403, { fehler: "nicht_berechtigt" });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.aktion === "buchungen_abrufen") {
      const fehltAbruf = Object.entries({ REVOLUT_PRIVATE_KEY: CFG.key, REVOLUT_CLIENT_ID: CFG.client, REVOLUT_REFRESH_TOKEN: CFG.refresh })
        .filter(([, v]) => !v).map(([k]) => k);
      if (fehltAbruf.length) return antwort(503, { fehler: "revolut_nicht_eingerichtet", fehlt: fehltAbruf, umgebung: ENV });
      return antwort(200, { umgebung: ENV, ...(await buchungenAbrufen(await accessToken(), false)) });
    }
    if (u.automatik) return antwort(403, { fehler: "nur_buero" });
    if (!wocheGueltig(b.woche)) return antwort(400, { fehler: "woche_fehlt" });
    const [fr] = await db(`abrechnung_freigaben?woche=eq.${encodeURIComponent(b.woche)}&select=woche`);
    if (!fr) return antwort(400, { fehler: "woche_nicht_freigegeben" });
    const fehlt = Object.entries({ REVOLUT_PRIVATE_KEY: CFG.key, REVOLUT_CLIENT_ID: CFG.client, REVOLUT_REFRESH_TOKEN: CFG.refresh,
      REVOLUT_ACCOUNT_ID: CFG.konto }).filter(([, v]) => !v).map(([k]) => k);
    if (b.aktion === "vorschau") {
      if (fehlt.length) return antwort(503, { fehler: "revolut_nicht_eingerichtet", fehlt, umgebung: ENV });
      return antwort(200, await vorschau(b.woche));
    }
    if (fehlt.length) return antwort(503, { fehler: "revolut_nicht_eingerichtet", fehlt, umgebung: ENV });
    if (b.aktion === "anlegen") {
      const nrs = Array.isArray(b.nrs) ? b.nrs.filter((n: unknown) => Number.isInteger(n)) : [];
      if (!nrs.length) return antwort(400, { fehler: "keine_fahrer_gewaehlt" });
      return await anlegen(b.woche, nrs, u.name);
    }
    if (b.aktion === "status") return antwort(200, await status(b.woche));
    return antwort(400, { fehler: "aktion_unbekannt" });
  } catch (e) {
    const m = (e as Error).message;
    console.error("revolut-auszahlung:", m);   // nur Meldungstext, nie Token/Secrets
    return antwort(e instanceof RevolutFehler ? 502 : 500, { fehler: m });
  }
});
