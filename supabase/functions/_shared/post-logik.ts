// Reine Logik fuer post-eingang und post-senden. Keine Deno-/Netz-APIs:
// laeuft unveraendert in Deno (Edge Function) und in Node (node --test).

export type Art = "lenkererhebung" | "strafverfuegung" | "anonymverfuegung" |
  "zahlungsaufforderung" | "mahnung" | "sonstige";

export interface Auslese {
  art: Art; gz: string | null; behoerde: string | null; kennzeichen: string | null;
  tatzeit: string | null; tatort: string | null; delikt: string | null; betrag: number | null;
  frist: string | null; antwort_email: string | null; volltext: string;
}

export interface Mieter {
  id: number; kurz: string; name: string; adresse: string; uid: string | null; fn: string | null;
  gueltig_von: string | null; gueltig_bis: string | null;
}

const WIEN = "Europe/Vienna";

export function wienDatum(iso: string): string {
  // en-CA liefert YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: WIEN, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));
}

function wienZeit(iso: string): string {
  const p = new Intl.DateTimeFormat("de-AT", {
    timeZone: WIEN, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}.${g("month")}.${g("year")} ${g("hour")}:${g("minute")}`;
}

export function mieterZurTatzeit(liste: Mieter[], tatzeitIso: string | null): Mieter | null {
  if (!tatzeitIso) return null;
  const d = wienDatum(tatzeitIso);
  return liste.find((m) => (!m.gueltig_von || m.gueltig_von <= d) && (!m.gueltig_bis || d <= m.gueltig_bis)) ?? null;
}

// Lenkererhebungen nennen meist kein Datum, sondern "binnen zwei Wochen nach Zustellung".
// Ein Datum aus dem PDF gewinnt immer.
export function fristErgaenzen(art: Art, frist: string | null, zugestelltAm: string | null): string | null {
  if (frist || art !== "lenkererhebung" || !zugestelltAm) return frist;
  const d = new Date(`${wienDatum(zugestelltAm)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
}

const STRAFEN: Art[] =["strafverfuegung", "anonymverfuegung", "zahlungsaufforderung", "mahnung"];

export function pruefeAuslese(a: Auslese, zugestelltAm: string | null): string[] {
  const g: string[] = [];
  const text = (a.volltext ?? "").toLowerCase();
  const verkehr = a.art === "lenkererhebung" || STRAFEN.includes(a.art);
  if (!verkehr) return g;
  if (!a.gz) g.push("GZ fehlt");
  else if (!text.includes(a.gz.toLowerCase())) g.push("GZ steht nicht im PDF-Text");
  if (a.tatzeit && zugestelltAm && Date.parse(a.tatzeit) > Date.parse(zugestelltAm)) g.push("Tatzeit liegt nach der Zustellung");
  // Ohne Offset liest JS/Postgres die Zeit als UTC: 1-2 h falsch, am Stichtag falscher Mieter.
  if (a.tatzeit && !/(Z|[+-]\d\d:?\d\d)$/.test(a.tatzeit.trim())) g.push("Tatzeit ohne Zeitzone");
  if (a.art === "lenkererhebung") {
    if (!a.kennzeichen) g.push("Kennzeichen fehlt");
    if (!a.tatzeit) g.push("Tatzeit fehlt");
    const m = (a.antwort_email ?? "").trim().toLowerCase();
    if (!m) g.push("Antwort-Mailadresse fehlt");
    else {
      if (!m.endsWith(".gv.at")) g.push("Antwort-Mailadresse endet nicht auf .gv.at");
      if (!text.includes(m)) g.push("Antwort-Mailadresse steht nicht im PDF-Text");
    }
  }
  if (a.art !== "lenkererhebung" && a.art !== "mahnung" && (a.betrag == null || !(a.betrag >= 0))) g.push("Betrag fehlt");
  return g;
}

// Behoerden-Adresse: nur ein Token, keine Leerzeichen/Zeilenumbrueche (Header-Injection), Endung .gv.at
export const GV_MAIL = /^[^\s@]+@[^\s@]+\.gv\.at$/i;

// null = darf gesendet werden; sonst der Grund. Serverseitige Sperre in post-senden.
export function sendbarGrund(e: { art: string | null; status: string; pruef_grund: string | null;
  gz: string | null; tatzeit: string | null; antwort_email: string | null }): string | null {
  if (e.art !== "lenkererhebung") return "keine Lenkererhebung";
  if (e.status === "beantwortet") return "bereits beantwortet";
  if (e.pruef_grund) return `prüfen: ${e.pruef_grund}`;
  if (e.status !== "offen") return `Status ${e.status} – nicht offen`;
  if (!e.gz || !e.tatzeit || !e.antwort_email) return "GZ, Tatzeit oder Mailadresse fehlt";
  if (!GV_MAIL.test(e.antwort_email)) return "Mailadresse ist keine gültige .gv.at-Adresse";
  return null;
}

export function antwortMail(
  e: { gz: string; kennzeichen: string | null; tatzeit: string; antwort_email: string }, m: Mieter,
): { an: string; betreff: string; text: string } {
  const firma = [m.name, m.adresse, m.uid, m.fn ? `FN ${m.fn}` : null].filter(Boolean).join(", ");
  const fz = e.kennzeichen ? `das Fahrzeug ${e.kennzeichen}` : "das Fahrzeug";
  const text = [
    "Sehr geehrte Damen und Herren!",
    "",
    `Hiermit teilen wir mit, dass ${fz} zur Tatzeit ${wienZeit(e.tatzeit)} vermietet war an:`,
    firma,
    "",
    "Mit freundlichen Grüßen",
    "Hydrafleet KG",
  ].join("\n");
  return { an: e.antwort_email.trim(), betreff: `GZ: ${e.gz}`, text };
}

export function behoerdeKurz(email: string): string {
  const [lokal, domain] = email.toLowerCase().split("@");
  const ma = domain?.match(/^ma(\d+)\./);
  if (ma) return `MA ${ma[1]}`;
  if (domain === "polizei.gv.at") {
    return email.split("@")[0].split("-").filter((t) => !/^(kanzlei|verkehrsamt)$/i.test(t)).join(" ").toUpperCase();
  }
  return domain ?? lokal;
}

export function knopfText(email: string, m: Mieter): string {
  return `An ${behoerdeKurz(email)} senden → ${m.kurz}`;
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function mimeRaw(an: string, betreff: string, text: string): string {
  const msg = [
    `To: ${an}`,
    `Subject: =?UTF-8?B?${b64(betreff)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
  ].join("\r\n");
  return b64(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
