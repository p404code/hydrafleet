// Reine Logik fuer uber-sync, ohne Netz und ohne Deno - testbar mit
// node --test scripts/test-uber-logik.mjs

// Uber benennt Berichtsspalten um: seit KW40/2026 steht "An dich gezahlt ..."
// wo vorher "An dein Unternehmen gezahlt ..." stand. Gelesen wird beides.
const KOPF_ALT = "An dein Unternehmen gezahlt";
const KOPF_NEU = "An dich gezahlt";
export function spalte(z: Record<string, string>, name: string): string | undefined {
  return z[name] ?? z[name.replace(KOPF_ALT, KOPF_NEU)];
}

// Ubers Zahlungsbericht braucht am Montag frueh laenger (12.10.2026: 213 s),
// als eine Edge Function leben darf (150 s). Ein Lauf, der nicht fertig wird,
// hoert deshalb sauber auf, und der naechste nimmt denselben Bericht wieder
// auf statt einen neuen anzufordern. Wieder aufgenommen wird nur ein Bericht
// mit genau diesem Typ und Fenster, der nicht fehlgeschlagen und hoechstens
// eine Stunde alt ist - ein aelterer koennte einen frueheren Datenstand zeigen.
export const BERICHT_MAX_ALTER_MS = 60 * 60000;
export function berichtWaehlen(
  berichte: any[] | undefined, typ: string, fenster: { vonMs: number; bisMs: number },
  jetztMs: number, maxAlterMs = BERICHT_MAX_ALTER_MS,
): string | null {
  const passend = (berichte ?? []).filter((r) =>
    r.reportType === typ && !String(r.status).includes("FAILED") &&
    Number(r.unixTimeRange?.startTimeUnixMillis?.value) === fenster.vonMs &&
    Number(r.unixTimeRange?.endTimeUnixMillis?.value) === fenster.bisMs &&
    jetztMs - Number(r.createdAt?.value) <= maxAlterMs
  ).sort((a, b) => Number(b.createdAt?.value) - Number(a.createdAt?.value));
  return passend[0]?.id?.uuid?.value ?? null;
}
