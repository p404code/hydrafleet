// uber-sync - holt Fahrer, Fahrzeuge, Fahrten und den Wochen-Zahlungsbericht
// aus dem Uber-Fleet-Portal.
//
// Kein offizieller API-Zugang: die offiziellen Echtzeit-Endpunkte reichen nur
// 24 Stunden zurueck. Stattdessen die interne Schnittstelle von fleethub.uber.com
// mit gespeicherter Anmeldesitzung. Bewusste Entscheidung des Betreibers.
//
// Drei Berichte, gleichzeitig angefordert damit die Wartezeit nur einmal anfaellt:
//   PAYMENTS_DRIVER      -> uber_reports   (Wochenabrechnung je Fahrer)
//   VEHICLE_PERFORMANCE  -> uber_vehicles  (Ubers Fahrzeugliste)
//   TRIP_ACTIVITY        -> uber_trips     (Fahrten mit Fahrer UND Fahrzeug)
//
// Schreibt NUR in die uber_*-Tabellen. settlements bleibt unberuehrt.
// Sitzung abgelaufen -> 'sitzung_abgelaufen' in verbindungen.letzter_fehler,
// erneuern mit scripts/uber-session-speichern.js.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FLEET        = "https://fleethub.uber.com/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const WOCHE_MS = 7 * 86400000;

const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
               "Content-Type": "application/json" };

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, {
    ...init, headers: { ...kopf, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (name: string, args: unknown) =>
  db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

async function upsert(tabelle: string, konflikt: string, zeilen: unknown[]) {
  for (let i = 0; i < zeilen.length; i += 500) {
    await db(`${tabelle}?on_conflict=${konflikt}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(zeilen.slice(i, i + 500)),
    });
  }
}

// ---------- Wochenlogik ----------
function isoWoche(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jahr = t.getUTCFullYear();
  const start = new Date(Date.UTC(jahr, 0, 1));
  const nr = Math.ceil(((t.getTime() - start.getTime()) / 86400000 + 1) / 7);
  return `${jahr}-W${String(nr).padStart(2, "0")}`;
}
function montagDerWoche(label: string): Date {
  const [j, w] = label.split("-W").map(Number);
  const vierter = new Date(Date.UTC(j, 0, 4));
  const mo = new Date(vierter);
  mo.setUTCDate(vierter.getUTCDate() - ((vierter.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return mo;
}
const alsDatum = (d: Date) => d.toISOString().slice(0, 10);
const schlaf = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wienOffsetMs(d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", timeZoneName: "longOffset",
  }).format(d);
  const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 3600000;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

// ---------- Uber-Portal ----------
class SitzungAbgelaufen extends Error {}

function portal(cookie: string, org: string) {
  return async function ruf(methode: string, body: unknown) {
    const r = await fetch(`${FLEET}/${methode}?localeCode=de-DE`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "x-csrf-token": "x", "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9",
        Referer: `https://fleethub.uber.com/orgs/${org}/reports`, Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 401 || r.status === 403 ||
        /auth\.uber\.com|<!DOCTYPE|<html/i.test(text.slice(0, 300))) {
      throw new SitzungAbgelaufen(`HTTP ${r.status} bei ${methode}`);
    }
    if (!r.ok) throw new Error(`Uber ${methode}: HTTP ${r.status} ${text.slice(0, 300)}`);
    let j;
    try { j = JSON.parse(text); }
    catch { throw new SitzungAbgelaufen(`keine JSON-Antwort bei ${methode}`); }
    if (j.status !== "success") throw new Error(`Uber ${methode}: ${text.slice(0, 300)}`);
    return j.data;
  };
}

const uuid = (v: string) => ({ uuid: { value: v } });
const aufStunde = (ms: number) => Math.floor(ms / 3600000) * 3600000;

// Ubers Abrechnungswoche beginnt Montag gegen 04:00 Wiener Zeit, nicht um
// Mitternacht, und der genaue Zeitpunkt schwankt um Minuten. Deshalb wird das
// Fenster bei Uber erfragt statt gerechnet; das Portal rundet auf die volle
// Stunde ab, wir machen es genauso.
async function abrechnungsfenster(ruf: any, org: string, von: string, bis: string) {
  const suchVon = Date.parse(`${von}T00:00:00Z`) - 86400000;
  const suchBis = Date.parse(`${bis}T00:00:00Z`) + 2 * 86400000;
  try {
    const d = await ruf("vs-sp-reports-management/GetReportingTimeWindows", { orgId: uuid(org) });
    for (const f of d.timeWindows ?? []) {
      const s = Number(f.startTimeUnixMillis?.value);
      if (!s || s < suchVon || s >= suchBis) continue;
      const e = f.endTimeUnixMillis?.value ? Number(f.endTimeUnixMillis.value) : null;
      return { vonMs: aufStunde(s), bisMs: e ? aufStunde(e) : aufStunde(s) + WOCHE_MS, quelle: "uber" };
    }
  } catch (_) { /* Rueckfall unten */ }
  const mo = new Date(`${von}T00:00:00Z`);
  const vonMs = mo.getTime() + 4 * 3600000 - wienOffsetMs(mo);
  return { vonMs, bisMs: vonMs + WOCHE_MS, quelle: "berechnet" };
}

// ---------- CSV, RFC-4180-fest ----------
function parseCSV(text: string): Record<string, string>[] {
  const zeilen: string[][] = [];
  let feld = "", zeile: string[] = [], inAnf = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inAnf) {
      if (c === '"' && text[i + 1] === '"') { feld += '"'; i++; }
      else if (c === '"') inAnf = false; else feld += c;
    } else if (c === '"') inAnf = true;
    else if (c === ",") { zeile.push(feld); feld = ""; }
    else if (c === "\n") { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ""; }
    else if (c !== "\r") feld += c;
  }
  if (feld.length || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  if (!zeilen.length) return [];
  const kopf = zeilen[0].map((h) => h.replace(/^﻿/, "").trim());
  return zeilen.slice(1).filter((z) => z.some((v) => v.trim() !== ""))
    .map((z) => Object.fromEntries(kopf.map((h, i) => [h, (z[i] ?? "").trim()])));
}

const zahl = (v: string | undefined) => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
};
const ganz = (v: string | undefined) => { const n = zahl(v); return n == null ? null : Math.round(n); };
const zeit = (v: string | undefined) => (v && v.trim() ? v.trim().replace(" ", "T") : null);

// ---------- Spalten, 1:1 aus den echten Berichten ----------
const P: Record<string, string> = {
  gezahlt: "An dein Unternehmen gezahlt",
  umsaetze: "An dein Unternehmen gezahlt : Deine Umsätze",
  bargeld: "An dein Unternehmen gezahlt : Fahrtguthaben : Auszahlungen : Eingenommenes Bargeld",
  fahrpreis: "An dein Unternehmen gezahlt : Deine Umsätze : Fahrpreis",
  steuern: "An dein Unternehmen gezahlt : Deine Umsätze : Steuern",
  fahrpreis_basis: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Fahrpreis",
  stornierung: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Stornierung",
  dynamische_anpassung: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Dynamische Fahrpreisanpassung",
  steuer_auf_fahrpreis: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Steuer auf Fahrpreis",
  wartezeit_abholung: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Wartezeit am Abholungsort",
  servicegebuehr: "An dein Unternehmen gezahlt:Deine Umsätze:Servicegebühr",
  steuer_servicegebuehr: "An dein Unternehmen gezahlt:Deine Umsätze:Steuern:Steuer auf Servicegebühr",
  trinkgeld: "An dein Unternehmen gezahlt:Deine Umsätze:Trinkgeld",
  flughafen_parkgebuehr: "An dein Unternehmen gezahlt:Fahrtguthaben:Rückerstattungen:Flughafen-Parkgebühr",
  anpassung: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Anpassung",
  buchungsgebuehr: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Buchungsgebühr",
  reservierungsgebuehr: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Reservierungsgebühr",
  bankueberweisung: "An dein Unternehmen gezahlt:Fahrtguthaben:Auszahlungen:Auf Bankkonto überwiesen",
  zeit_zwischenstopp: "An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Zeit am Zwischenstopp",
};
const V_ZAHL: Record<string, string> = {
  gesamtumsaetze: "Gesamtumsätze", umsaetze_pro_std: "Umsätze/Std",
  bargeld: "Eingenommenes Bargeld", fahrten_pro_std: "Fahrten/Std",
  stunden_online: "Stunden online", stunden_fahrzeit: "Stunden Fahrtzeit",
  aktivzeit: "Aktivzeit", annahmequote: "Acceptance Rate",
  stornoquote: "Stornierungsrate",
  fahrten_angenommen: "Angenommene Fahrten (ohne Fahrtenradar o.ä.)",
  fahrten_abgelehnt: "Fahrten abgelehnt",
};
const V_GANZ: Record<string, string> = {
  fahrten_gesamt: "Total Trips", fahrten_storniert: "Fahrten storniert",
  fahrten_fehlgeschlagen: "Fahrten fehlgeschlagen",
  fahrtzuweisungen: "Gesamtzahl der Fahrtenzuweisungen",
};

// ---------- ein Bericht ----------
async function berichtAnfordern(ruf: any, org: string, typ: string, von: string, bis: string, f: any) {
  const g = await ruf("vs-sp-reports-management/GenerateReport", {
    orgId: uuid(org), reportType: typ,
    startDate: { value: von },
    endDate: { value: alsDatum(new Date(Date.parse(`${bis}T00:00:00Z`) + 86400000)) },
    visibility: "",
    unixTimeRangeOverride: {
      startTimeUnixMillis: { value: String(f.vonMs) },
      endTimeUnixMillis: { value: String(f.bisMs) },
    },
    childOrgUuids: [uuid(org)],
  });
  const id = g.reportId?.uuid?.value;
  if (!id) throw new Error(`GenerateReport ${typ} lieferte keine reportId`);
  return id;
}

async function berichtHolen(ruf: any, org: string, reportId: string) {
  const dl = await ruf("vs-sp-reports-management/DownloadReport",
    { orgId: uuid(org), reportId: uuid(reportId) });
  const url = dl.signedUrl?.value;
  if (!url) throw new Error("DownloadReport lieferte keine signedUrl");
  const a = await fetch(url);
  if (!a.ok) throw new Error(`CSV-Download HTTP ${a.status}`);
  return parseCSV(await a.text());
}

async function syncVerbindung(v: any, von: string, bis: string, woche: string, nurTest: boolean) {
  const [lauf] = await db("sync_runs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ verbindung_id: v.id, zeitraum_von: von, zeitraum_bis: bis, status: "laeuft" }),
  });
  try {
    const zugang = await rpc("verbindung_zugang", { p_verbindung_id: v.id });
    const org = v.externe_id;
    if (!org) throw new Error("externe_id (org_id) fehlt an der Verbindung");
    if (!zugang?.cookie) throw new Error("Kein cookie im Vault-Eintrag");
    const ruf = portal(zugang.cookie, org);

    const orgs = await ruf("vs-sp-reports-management/GetUserOrganizations", {});
    const orgName = (orgs || []).find((o: any) => o.uuid === org)?.name ?? null;

    if (nurTest) {
      const f = await abrechnungsfenster(ruf, org, von, bis);
      await db(`sync_runs?id=eq.${lauf.id}`, { method: "PATCH", body: JSON.stringify({
        ende: new Date().toISOString(), anzahl: 0, status: "ok", fehler: "nur Verbindungstest" }) });
      return { firma: v.firma, status: "ok", test: true, org: orgName,
               fenster: `${new Date(f.vonMs).toISOString()} .. ${new Date(f.bisMs).toISOString()} (${f.quelle})` };
    }

    const fenster = await abrechnungsfenster(ruf, org, von, bis);
    const jetzt0 = () => new Date().toISOString();

    // --- Fahrer (direkt, kein Bericht noetig) ---
    let token = "";
    const fahrerZeilen: any[] = [];
    for (let seite = 0; seite < 20; seite++) {
      const d = await ruf("getDrivers", {
        orgUuid: uuid(org), driverUuids: [],
        paginationOptions: { pageSize: { value: 100 }, pageToken: { value: token } },
      });
      for (const f of d.driversData ?? []) {
        const u = f.driverUuid?.uuid?.value;
        if (!u) continue;
        const t = f.phoneNumber;
        fahrerZeilen.push({
          driver_uuid: u, org_id: org,
          vorname: f.name?.firstName ?? null, nachname: f.name?.lastName ?? null,
          email: f.email ?? null,
          telefon: t ? `${t.countryCode ?? ""}${t.number ?? ""}` : null,
          roh: f, sync_run_id: lauf.id, aktualisiert_am: jetzt0(),
        });
      }
      token = d.paginationResult?.nextPageToken?.value ?? "";
      if (!token) break;
    }
    if (fahrerZeilen.length) await upsert("uber_drivers", "driver_uuid", fahrerZeilen);

    // --- drei Berichte GLEICHZEITIG anfordern, damit die Wartezeit nur einmal anfaellt ---
    const typen = {
      zahlungen: "REPORT_TYPE_PAYMENTS_DRIVER",
      fahrzeuge: "REPORT_TYPE_VEHICLE_PERFORMANCE",
      fahrten:   "REPORT_TYPE_TRIP_ACTIVITY",
    } as Record<string, string>;
    const ids: Record<string, string> = {};
    for (const [k, t] of Object.entries(typen)) {
      ids[k] = await berichtAnfordern(ruf, org, t, von, bis, fenster);
    }

    // --- gemeinsam auf alle warten ---
    const fertig: Record<string, string> = {};
    for (let i = 0; i < 40 && Object.keys(fertig).length < 3; i++) {
      await schlaf(5000);
      const l = await ruf("vs-sp-reports-management/GetReports", {
        orgId: uuid(org),
        pageOptions: { pageToken: { value: "" }, pageSize: { value: 30 } }, filters: [],
      });
      for (const [k, rid] of Object.entries(ids)) {
        if (fertig[k]) continue;
        const r = (l.reports ?? []).find((x: any) => x.id?.uuid?.value === rid);
        if (!r) continue;
        if (r.status === "REPORT_STATUS_COMPLETED") fertig[k] = r.fileName;
        else if (String(r.status).includes("FAILED"))
          throw new Error(`Bericht ${typen[k]} fehlgeschlagen: ${r.failedReason}`);
      }
    }
    const offen = Object.keys(ids).filter((k) => !fertig[k]);
    if (offen.length) throw new Error(`Berichte nicht rechtzeitig fertig: ${offen.join(", ")}`);

    const jetzt = jetzt0();
    const zaehler: Record<string, number> = {};

    // --- Zahlungen ---
    {
      const rows = (await berichtHolen(ruf, org, ids.zahlungen))
        .filter((z) => (z["Fahrer-UUID"] ?? "").trim() !== "");
      const out = rows.map((z) => {
        const o: any = { org_id: org, org_name: orgName, zeitraum_von: von, zeitraum_bis: bis, woche,
          driver_uuid: z["Fahrer-UUID"], vorname: z["Vorname des Fahrers"] ?? null,
          nachname: z["Nachname des Fahrers"] ?? null,
          report_id: ids.zahlungen, roh: z, sync_run_id: lauf.id, aktualisiert_am: jetzt };
        for (const f of Object.keys(P)) o[f] = zahl(z[P[f]]);
        return o;
      });
      if (out.length) await upsert("uber_reports", "org_id,zeitraum_von,zeitraum_bis,driver_uuid", out);
      zaehler.zahlungen = out.length;
    }

    // --- Fahrzeuge ---
    {
      const rows = (await berichtHolen(ruf, org, ids.fahrzeuge))
        .filter((z) => (z["Fahrzeug-UUID"] ?? "").trim() !== "");
      const out = rows.map((z) => {
        const o: any = { org_id: org, zeitraum_von: von, zeitraum_bis: bis, woche,
          vehicle_uuid: z["Fahrzeug-UUID"], name: z["Fahrzeugname"] ?? null,
          kennzeichen: z["Fahrzeugkennzeichen"] ?? null,
          roh: z, sync_run_id: lauf.id, aktualisiert_am: jetzt };
        for (const f of Object.keys(V_ZAHL)) o[f] = zahl(z[V_ZAHL[f]]);
        for (const f of Object.keys(V_GANZ)) o[f] = ganz(z[V_GANZ[f]]);
        return o;
      });
      if (out.length) await upsert("uber_vehicles", "org_id,zeitraum_von,zeitraum_bis,vehicle_uuid", out);
      zaehler.fahrzeuge = out.length;
    }

    // --- Fahrten ---
    {
      const rows = (await berichtHolen(ruf, org, ids.fahrten))
        .filter((z) => (z["Fahrt-UUID"] ?? "").trim() !== "");
      const out = rows.map((z) => ({
        trip_uuid: z["Fahrt-UUID"], org_id: org, woche,
        driver_uuid: z["Fahrer-UUID"] || null,
        vorname: z["Vorname des Fahrers"] ?? null, nachname: z["Nachname des Fahrers"] ?? null,
        vehicle_uuid: z["Fahrzeug-UUID"] || null, kennzeichen: z["Kennzeichen"] || null,
        serviceart: z["Serviceart"] ?? null,
        bestellt_am: zeit(z["Zeitpunkt der Fahrtbestellung"]),
        angekommen_am: zeit(z["Ankunftszeit der Fahrt"]),
        abholadresse: z["Abholadresse"] ?? null, zieladresse: z["Zieladresse"] ?? null,
        distanz: zahl(z["Fahrtdistanz"]), status: z["Fahrtstatus"] ?? null,
        produkttyp: z["Produkttyp"] ?? null, zahlungsart: z["Zahlungsart"] ?? null,
        roh: z, sync_run_id: lauf.id, aktualisiert_am: jetzt,
      }));
      if (out.length) await upsert("uber_trips", "trip_uuid", out);
      zaehler.fahrten = out.length;
    }

    await db(`sync_runs?id=eq.${lauf.id}`, { method: "PATCH", body: JSON.stringify({
      ende: jetzt0(), anzahl: zaehler.fahrten ?? 0, status: "ok" }) });
    await db(`verbindungen?id=eq.${v.id}`, { method: "PATCH", body: JSON.stringify({
      letzter_abruf: jetzt0(), letzter_fehler: null }) });

    return { firma: v.firma, org: orgName, fahrer: fahrerZeilen.length,
             zahlungen: zaehler.zahlungen, fahrzeuge: zaehler.fahrzeuge, fahrten: zaehler.fahrten,
             fenster: `${new Date(fenster.vonMs).toISOString()} .. ${new Date(fenster.bisMs).toISOString()} (${fenster.quelle})`,
             status: "ok" };
  } catch (e) {
    const abgelaufen = e instanceof SitzungAbgelaufen;
    const text = (abgelaufen ? "sitzung_abgelaufen: " : "") + String(e).slice(0, 900);
    const jetzt = new Date().toISOString();
    await db(`sync_runs?id=eq.${lauf.id}`, { method: "PATCH", body: JSON.stringify({
      ende: jetzt, status: "fehler", fehler: text }) });
    await db(`verbindungen?id=eq.${v.id}`, { method: "PATCH", body: JSON.stringify({
      letzter_abruf: jetzt, letzter_fehler: text, status: abgelaufen ? "fehler" : "aktiv" }) });
    return { firma: v.firma, status: "fehler", fehler: text };
  }
}

Deno.serve(async (req) => {
  try {
    const body = req.headers.get("content-length") === "0" ? {} : await req.json().catch(() => ({}));
    let von: string, bis: string, woche: string;
    if (body.von && body.bis) {
      von = body.von; bis = body.bis; woche = body.woche ?? isoWoche(new Date(`${von}T12:00:00Z`));
    } else {
      woche = body.woche ?? isoWoche(new Date(Date.now() - 7 * 86400000));
      const mo = montagDerWoche(woche);
      const so = new Date(mo); so.setUTCDate(mo.getUTCDate() + 6);
      von = alsDatum(mo); bis = alsDatum(so);
    }
    const verbindungen = await db("verbindungen?anbieter=eq.uber&select=id,firma,externe_id,status");
    const aktive = (verbindungen || []).filter((v: any) => v.status === "aktiv");
    if (!aktive.length) throw new Error("Keine aktive Uber-Verbindung");
    const ergebnis = [];
    for (const v of aktive) ergebnis.push(await syncVerbindung(v, von, bis, woche, body.test === true));
    const fehler = ergebnis.some((r: any) => r.status === "fehler");
    return new Response(JSON.stringify({ woche, von, bis, verbindungen: ergebnis }, null, 2),
      { status: fehler ? 207 : 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ fehler: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" } });
  }
});
