// Reine Logik fuer telegram-senden / telegram-webhook / push-senden (ohne Netz, ohne Datenbank).
// Tests: node --test scripts/test-telegram-logik.mjs

export type Kopf = { name?: string | null; fahrer_nr?: number | null; kennzeichen?: string | null; modell?: string | null };
export type Einordnung =
  | { art: "team"; thread_id: number; message_id: number; text: string; team_name: string }
  | { art: "ohne_text"; thread_id: number }
  | { art: "ignorieren"; grund: string };

// parse_mode HTML: nur diese drei Zeichen muessen escaped werden
export function esc(t: unknown): string {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const sauber = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();

// Auf max UTF-16-Einheiten kuerzen (so zaehlt Telegram), ohne ein Emoji zu zerschneiden
export function kuerzen(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const z of s) { if (out.length + z.length > max - 1) break; out += z; }
  return out + "…";
}

export function vorname(name: unknown): string {
  return sauber(name).split(" ")[0] || "Fahrer";
}

// "🚕 Max Mustermann · #123 · W-1234TX" – Telegram erlaubt 1–128 Zeichen
export function themenName(k: Kopf): string {
  const teile = [sauber(k.name) || "Fahrer"];
  if (k.fahrer_nr != null) teile.push("#" + k.fahrer_nr);
  if (sauber(k.kennzeichen)) teile.push(sauber(k.kennzeichen));
  return kuerzen("🚕 " + teile.join(" · "), 128);
}

function autoText(k: Kopf): string {
  return [sauber(k.kennzeichen), sauber(k.modell)].filter(Boolean).map(esc).join(" · ");
}

// Erster Post in einem neuen Thema
export function kopfPost(k: Kopf): string {
  const z1 = `🚕 <b>${esc(sauber(k.name) || "Fahrer")}</b>` + (k.fahrer_nr != null ? ` · #${k.fahrer_nr}` : "");
  const hinweis = `Alles, was ihr in diesem Thema schreibt, geht an ${esc(vorname(k.name))} in die App.`;
  return [z1, autoText(k), hinweis].filter(Boolean).join("\n");
}

export function autoZeile(k: Kopf): string {
  return "🚗 Fahrzeug jetzt " + autoText(k);
}

// "<b>Max:</b> Text" – hoechstens 4096 Zeichen nach dem Escapen, nie mitten in einem &amp;
export function fahrerZeile(k: Kopf, text: string): string {
  const vor = `<b>${esc(vorname(k.name))}:</b> `;
  let roh = String(text ?? "");
  let s = vor + esc(roh);
  while (s.length > 4096) { roh = kuerzen(roh, Math.floor(roh.length * 0.9)); s = vor + esc(roh); }
  return s;
}

// Push-Text: "Boyko: Fahr zur Werkstatt" (Klartext, kein HTML)
export function pushText(teamName: unknown, text: unknown): string {
  return kuerzen(`${sauber(teamName) || "Büro"}: ${sauber(text)}`, 120);
}

// Vergleich in konstanter Zeit (Webhook-Secret)
export function gleich(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const SERVICE = ["forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "new_chat_members", "left_chat_member",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "pinned_message", "migrate_from_chat_id"];

// Welches Telegram-Update ist eine Team-Nachricht an einen Fahrer? (Ob das Thema einem Fahrer gehoert, prueft die Function.)
export function einordnen(update: any, gruppeId: string | number): Einordnung {
  const m = update?.message;
  if (!m) return { art: "ignorieren", grund: "kein message" };
  if (String(m.chat?.id) !== String(gruppeId)) return { art: "ignorieren", grund: "fremder chat" };
  if (!m.is_topic_message || !m.message_thread_id) return { art: "ignorieren", grund: "allgemein" };
  if (SERVICE.some((k) => k in m)) return { art: "ignorieren", grund: "service" };
  // Anonyme Admins schreiben "als Gruppe": from = GroupAnonymousBot, sender_chat = die Gruppe
  const anonym = m.sender_chat && String(m.sender_chat.id) === String(gruppeId);
  if (!anonym && (!m.from || m.from.is_bot)) return { art: "ignorieren", grund: "bot" };
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (!text) return { art: "ohne_text", thread_id: m.message_thread_id };
  const name = anonym ? sauber(m.author_signature) || "Büro" : sauber(m.from.first_name) || "Büro";
  return { art: "team", thread_id: m.message_thread_id, message_id: m.message_id, text: kuerzen(text, 2000), team_name: name };
}
