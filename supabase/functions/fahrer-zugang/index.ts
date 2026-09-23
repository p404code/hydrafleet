// fahrer-zugang - legt App-Zugaenge fuer Fahrer an und verwaltet sie.
//
// Vertrag: docs/2026-09-23-fahrerapp-schnittstelle.md, Abschnitt 2.
//
// Aufruf nur durch Buero-User (app_metadata.app_role in admin/user). Der
// Fahrer-Login ist ein normaler Supabase-Auth-User:
//   E-Mail  fhr-<nr>@hydralink.local
//   Passwort  6-stelliger PIN, vom Server erzeugt, genau einmal zurueckgegeben
//   app_metadata  { fahrer_nr: <nr> }   (kein app_role, keine user_metadata)
//
// Neben Auth pflegt die Function public.fahrer_app_zugang (nur sie schreibt
// dort, mit service_role). Reihenfolge immer: erst Auth, dann Tabelle.
//
// Der PIN wird NIE geloggt. Service-Key, Passwort-Hashes und der Auth-User als
// Ganzes gehen nie an den Aufrufer zurueck.
//
// Deploy mit verify_jwt = true. Voraussetzung in Supabase Auth: Mindest-
// Passwortlaenge <= 6, sonst lehnt admin/users den PIN ab.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

// Umstellbar auf nur Admins: hier ["admin"] eintragen.
const ERLAUBTE_ROLLEN = ["admin", "user"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
               "Content-Type": "application/json" };

type Aktion = "anlegen" | "pin_neu" | "sperren" | "entsperren";
const AKTIONEN: Aktion[] = ["anlegen", "pin_neu", "sperren", "entsperren"];

// ---------- Antworten ----------
function antwort(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: Antworten koennen den PIN enthalten, nie zwischenspeichern.
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": "no-store" },
  });
}

class Fehler extends Error {
  constructor(public status: number, public code: string, meldung: string) {
    super(meldung);
  }
}

const kurz = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 300);

// ---------- Supabase REST (service_role) ----------
async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, {
    ...init, headers: { ...kopf, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${kurz(text)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Supabase Auth Admin (service_role) ----------
async function authAdmin(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${pfad}`, {
    ...init, headers: { ...kopf, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  return { status: r.status, ok: r.ok, json, text };
}

// Lesbare Fehlermeldung aus einer GoTrue-Antwort (enthaelt nie das Passwort).
function authText(a: { status: number; json: any; text: string }) {
  const j = a.json ?? {};
  const t = j.msg ?? j.message ?? j.error_description ?? j.error ?? a.text ?? "";
  return kurz(`${a.status} ${typeof t === "string" ? t : JSON.stringify(t)}`);
}

// ---------- Hilfen ----------
// 6 Ziffern, kryptographisch zufaellig, ohne Modulo-Verzerrung (Verwerfen).
function neuerPin(): string {
  const grenze = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < grenze) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

// JSON-Zahl oder Ziffern-String, ganze Zahl 1..999999999, sonst null.
function parseNr(wert: unknown): number | null {
  let n: number;
  if (typeof wert === "number") n = wert;
  else if (typeof wert === "string" && /^\d{1,12}$/.test(wert.trim())) n = parseInt(wert.trim(), 10);
  else return null;
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) return null;
  return n;
}

const email = (nr: number) => `fhr-${String(nr)}@hydralink.local`;
const login = (nr: number) => `FHR-${nr}`;

async function zugangLesen(nr: number) {
  const zeilen = await db(
    `fahrer_app_zugang?select=auth_user_id,gesperrt&notion_fahrer_id=eq.${nr}`);
  return (zeilen?.[0] ?? null) as { auth_user_id: string; gesperrt: boolean } | null;
}

// Tabelle nach erfolgreichem Auth-Schritt aendern. Scheitert es -> 500 mit Hinweis.
async function zugangAendern(nr: number, felder: Record<string, unknown>) {
  try {
    const zeilen = await db(`fahrer_app_zugang?notion_fahrer_id=eq.${nr}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(felder),
    });
    if (!Array.isArray(zeilen) || zeilen.length !== 1) {
      throw new Error("Eintrag nicht gefunden");
    }
  } catch (e) {
    throw new Fehler(500, "db_fehler",
      `Datenbankfehler: ${(e as Error).message} (Auth ist schon geändert, ` +
      `erneuter Aufruf ist gefahrlos.)`);
  }
}

async function authAendern(id: string, felder: Record<string, unknown>) {
  const a = await authAdmin(`users/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify(felder),
  });
  if (!a.ok) {
    throw new Fehler(502, "auth_fehler", `Supabase Auth hat abgelehnt: ${authText(a)}`);
  }
}

// ---------- Aktionen ----------
async function anlegen(nr: number, aufrufer: string) {
  let fahrer: { id: number; name: string }[];
  let vorhanden: unknown;
  try {
    fahrer = await db(
      `fahrer?select=id,name&aktiv=is.true&notion_fahrer_id=eq.${nr}`);
    vorhanden = await zugangLesen(nr);
  } catch (e) {
    throw new Fehler(500, "db_fehler", `Datenbankfehler: ${(e as Error).message}`);
  }
  if (!fahrer || fahrer.length === 0) {
    throw new Fehler(404, "fahrer_nicht_gefunden", `Kein aktiver Fahrer mit Nr. ${nr}.`);
  }
  if (fahrer.length > 1) {
    throw new Fehler(409, "fahrer_nr_doppelt",
      `Nr. ${nr} ist in Notion doppelt vergeben. Erst bereinigen.`);
  }
  if (vorhanden) {
    throw new Fehler(409, "zugang_existiert", `Für ${login(nr)} gibt es schon einen Zugang.`);
  }

  const pin = neuerPin();
  const a = await authAdmin("users", {
    method: "POST",
    body: JSON.stringify({
      email: email(nr),
      password: pin,
      email_confirm: true,
      app_metadata: { fahrer_nr: nr },
    }),
  });
  if (!a.ok) {
    // 422 heisst bei GoTrue auch "Passwort zu schwach" - nur "E-Mail existiert"
    // ist auth_user_existiert, alles andere auth_fehler.
    const code = a.json?.error_code ?? a.json?.code;
    const msg = String(a.json?.msg ?? a.json?.message ?? "");
    const existiert = a.status === 422 &&
      (code === "email_exists" || code === "user_already_exists" ||
       /already (been )?registered|already exists/i.test(msg));
    if (existiert) {
      throw new Fehler(409, "auth_user_existiert",
        `Login fhr-${nr} existiert schon ohne Eintrag. Bitte melden.`);
    }
    throw new Fehler(502, "auth_fehler", `Supabase Auth hat abgelehnt: ${authText(a)}`);
  }
  const authId: string | undefined = a.json?.id ?? a.json?.user?.id;
  if (!authId) {
    throw new Fehler(502, "auth_fehler", "Supabase Auth hat abgelehnt: keine User-ID erhalten");
  }

  try {
    await db("fahrer_app_zugang", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        notion_fahrer_id: nr, auth_user_id: authId, angelegt_von: aufrufer,
      }),
    });
  } catch (e) {
    // Aufraeumen, damit ein erneutes Anlegen moeglich bleibt.
    const d = await authAdmin(`users/${encodeURIComponent(authId)}`, { method: "DELETE" })
      .catch((x) => ({ status: 0, ok: false, json: null, text: String((x as Error)?.message ?? x) }));
    const zusatz = d.ok ? "" :
      ` Auth-User fhr-${nr} konnte nicht entfernt werden (${authText(d)}).`;
    console.error(`fahrer-zugang anlegen ${nr}: Tabelle fehlgeschlagen, ` +
                  `Aufraeumen ${d.ok ? "ok" : "fehlgeschlagen"}`);
    throw new Fehler(500, "db_fehler", `Datenbankfehler: ${(e as Error).message}.${zusatz}`);
  }

  return { name: fahrer[0].name, pin, gesperrt: false };
}

async function bestehenderZugang(nr: number) {
  let z;
  try {
    z = await zugangLesen(nr);
  } catch (e) {
    throw new Fehler(500, "db_fehler", `Datenbankfehler: ${(e as Error).message}`);
  }
  if (!z) throw new Fehler(404, "kein_zugang", `${login(nr)} hat noch keinen App-Zugang.`);
  return z;
}

async function pinNeu(nr: number) {
  const z = await bestehenderZugang(nr);
  const pin = neuerPin();
  await authAendern(z.auth_user_id, { password: pin });
  await zugangAendern(nr, { pin_geaendert_am: new Date().toISOString() });
  return { pin, gesperrt: z.gesperrt };
}

async function sperren(nr: number) {
  const z = await bestehenderZugang(nr);
  await authAendern(z.auth_user_id, { ban_duration: "876000h" });
  await zugangAendern(nr, { gesperrt: true, gesperrt_am: new Date().toISOString() });
  return { gesperrt: true };
}

async function entsperren(nr: number) {
  const z = await bestehenderZugang(nr);
  await authAendern(z.auth_user_id, { ban_duration: "none" });
  await zugangAendern(nr, { gesperrt: false, gesperrt_am: null });
  return { gesperrt: false };
}

// ---------- Einstieg ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    if (req.method !== "POST") throw new Fehler(405, "methode", "Nur POST.");

    // 1. Aufrufer pruefen
    const auth = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(auth)) {
      throw new Fehler(401, "nicht_angemeldet", "Bitte neu anmelden.");
    }
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: ANON_KEY },
    });
    if (ur.status !== 200) {
      await ur.body?.cancel();
      throw new Fehler(401, "nicht_angemeldet", "Bitte neu anmelden.");
    }
    const user = await ur.json().catch(() => null);
    const meta = user?.app_metadata ?? {};
    if (!ERLAUBTE_ROLLEN.includes(meta.app_role)) {
      throw new Fehler(403, "nicht_berechtigt", "Keine Berechtigung.");
    }
    const aufrufer: string = meta.app_name ?? user?.email ?? "unbekannt";

    // 2. Anfrage pruefen
    const body = await req.json().catch(() => null);
    const aktion = body?.aktion as Aktion;
    const nr = parseNr(body?.fahrer_nr);
    if (!AKTIONEN.includes(aktion) || nr === null) {
      throw new Fehler(400, "ungueltige_anfrage", "Ungültige Anfrage.");
    }

    // 3. Ausfuehren
    let ergebnis: { name?: string; pin?: string; gesperrt: boolean };
    switch (aktion) {
      case "anlegen":    ergebnis = await anlegen(nr, aufrufer); break;
      case "pin_neu":    ergebnis = await pinNeu(nr); break;
      case "sperren":    ergebnis = await sperren(nr); break;
      case "entsperren": ergebnis = await entsperren(nr); break;
      default: throw new Fehler(400, "ungueltige_anfrage", "Ungültige Anfrage.");
    }
    console.log(`fahrer-zugang ${aktion} ${login(nr)} durch ${aufrufer}: ok`);

    const out: Record<string, unknown> = { ok: true, aktion, fahrer_nr: nr };
    if (ergebnis.name !== undefined) out.name = ergebnis.name;
    out.login = login(nr);
    if (ergebnis.pin !== undefined) out.pin = ergebnis.pin;
    out.gesperrt = ergebnis.gesperrt;
    return antwort(200, out);
  } catch (e) {
    if (e instanceof Fehler) {
      if (e.status >= 500) console.error(`fahrer-zugang ${e.code}: ${e.message}`);
      return antwort(e.status, { ok: false, fehler: e.code, meldung: e.message });
    }
    const text = kurz((e as Error)?.message ?? String(e));
    console.error(`fahrer-zugang unerwartet: ${text}`);
    return antwort(500, { ok: false, fehler: "db_fehler", meldung: `Datenbankfehler: ${text}` });
  }
});
