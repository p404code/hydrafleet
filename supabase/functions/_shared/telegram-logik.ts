// Reine Logik fuer telegram-senden / telegram-webhook / push-senden (ohne Netz, ohne Datenbank).
// Tests: node --test scripts/test-telegram-logik.mjs

export type Kopf = { name?: string | null; fahrer_nr?: number | null; kennzeichen?: string | null; modell?: string | null };
export type Einordnung =
  | { art: "team"; thread_id: number; message_id: number; text: string; team_name: string }
  | { art: "ohne_text"; thread_id: number }
  | { art: "knopf"; id: string; daten: string; von: Person; message_id: number | null }
  | { art: "allgemein_antwort"; antwort_auf: number; text: string; von: Person; message_id: number }
  | { art: "ignorieren"; grund: string };
export type Person = { id: number; name: string };
export type Treffer = { fahrer_nr: number; name: string; kennzeichen: string | null; thread_id: number | null };

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

// Push-Text: "Boyko: Fahr zur Werkstatt" bzw. "Boyko (an alle): …" (Klartext, kein HTML)
export function pushText(teamName: unknown, text: unknown, anAlle = false): string {
  return kuerzen(`${sauber(teamName) || "Büro"}${anAlle ? " (an alle)" : ""}: ${sauber(text)}`, 120);
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
// botId: nur Antworten auf Nachrichten DIESES Bots in "Allgemein" sind Menue-Antworten (Teil 2).
export function einordnen(update: any, gruppeId: string | number, botId?: string | number): Einordnung {
  const cq = update?.callback_query;
  if (cq) {
    if (String(cq.message?.chat?.id) !== String(gruppeId)) return { art: "ignorieren", grund: "fremder chat" };
    return { art: "knopf", id: String(cq.id), daten: String(cq.data ?? ""), von: person(cq.from), message_id: cq.message?.message_id ?? null };
  }
  const m = update?.message;
  if (!m) return { art: "ignorieren", grund: "kein message" };
  if (String(m.chat?.id) !== String(gruppeId)) return { art: "ignorieren", grund: "fremder chat" };
  if (!m.is_topic_message || !m.message_thread_id) {
    // "Allgemein": nur Text-Antworten von Menschen auf eine Nachricht des Bots (Menue-Aufforderung)
    const r = m.reply_to_message;
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (r && r.from?.is_bot && (botId == null || String(r.from.id) === String(botId)) && m.from && !m.from.is_bot && text) {
      return { art: "allgemein_antwort", antwort_auf: r.message_id, text: kuerzen(text, 2000), von: person(m.from), message_id: m.message_id };
    }
    return { art: "ignorieren", grund: "allgemein" };
  }
  if (SERVICE.some((k) => k in m)) return { art: "ignorieren", grund: "service" };
  // Anonyme Admins schreiben "als Gruppe": from = GroupAnonymousBot, sender_chat = die Gruppe
  const anonym = m.sender_chat && String(m.sender_chat.id) === String(gruppeId);
  if (!anonym && (!m.from || m.from.is_bot)) return { art: "ignorieren", grund: "bot" };
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (!text) return { art: "ohne_text", thread_id: m.message_thread_id };
  const name = anonym ? sauber(m.author_signature) || "Büro" : sauber(m.from.first_name) || "Büro";
  return { art: "team", thread_id: m.message_thread_id, message_id: m.message_id, text: kuerzen(text, 2000), team_name: name };
}

const person = (f: any): Person => ({ id: Number(f?.id), name: sauber(f?.first_name) || "Büro" });

/* ---------- Teil 2: Menue in "Allgemein" ---------- */

export function menueText(): string {
  return "<b>HYDRAlink – Fahrer-Chat</b>\nJeder Fahrer mit App hat unten sein eigenes Thema. Was ihr dort schreibt, geht an den Fahrer.\n" +
    "Hier in „Allgemein“ ist alles intern.";
}
export function menueKnoepfe() {
  return { inline_keyboard: [
    [{ text: "📢 Nachricht an alle Fahrer", callback_data: "menue:alle" }],
    [{ text: "🔎 Fahrer finden", callback_data: "menue:suche" }],
    [{ text: "ℹ️ So funktioniert's", callback_data: "menue:info" }],
  ] };
}
export function infoText(): string {
  return [
    "<b>So funktioniert's</b>",
    "• Jeder Fahrer mit App hat ein eigenes Thema. Was ihr dort schreibt, geht an ihn in die App (mit Push).",
    "• Hier in „Allgemein“ ist alles intern – außer „📢 Nachricht an alle“.",
    "• 👍 auf eurer Nachricht = beim Fahrer angekommen, 👀 = er hat den Chat geöffnet.",
    "• Bearbeiten oder Löschen kommt beim Fahrer nicht an – lieber neu schreiben.",
    "• Fotos und Sprachnachrichten kommen noch nicht an.",
  ].join("\n");
}
const erwaehnt = (name: string, id: number) => `<a href="tg://user?id=${Number(id)}">${esc(name)}</a>`;
export function aufforderung(art: "alle" | "suche", name: string, userId: number): string {
  return art === "alle"
    ? `📢 ${erwaehnt(name, userId)}, schreib die Nachricht an alle Fahrer (als Antwort hierauf):`
    : `🔎 ${erwaehnt(name, userId)}, Name, Fahrer-Nr. oder Kennzeichen? (als Antwort hierauf)`;
}
export function vorschau(text: string, anzahl: number): string {
  return `📢 An ${anzahl} Fahrer senden?\n\n„${esc(kuerzen(String(text ?? ""), 700))}“`;
}
export function vorschauKnoepfe(promptId: number) {
  return { inline_keyboard: [[{ text: "✅ Senden", callback_data: `alle:ok:${promptId}` }, { text: "✖ Abbrechen", callback_data: `alle:nein:${promptId}` }]] };
}
export function gesendetText(anzahl: number, name: string, text: string): string {
  return `✅ An ${anzahl} Fahrer geschickt (von ${esc(name)}):\n„${esc(kuerzen(String(text ?? ""), 700))}“`;
}
// Link in ein Thema der Supergruppe: -1004453022013 / 13 -> https://t.me/c/4453022013/13
export function themaLink(gruppeId: string | number, threadId: number): string {
  return `https://t.me/c/${String(gruppeId).replace(/^-100/, "")}/${threadId}`;
}
// Treffer mit Thema: Link hinein; ohne Thema: "Chat starten" (das Thema entsteht erst beim Klick)
export function trefferKnoepfe(treffer: Treffer[], gruppeId: string | number) {
  const name = (t: Treffer) => [sauber(t.name), "#" + t.fahrer_nr, sauber(t.kennzeichen)].filter((x) => x && x !== "#null").join(" · ");
  return { inline_keyboard: treffer.map((t) => [t.thread_id
    ? { text: kuerzen("🚕 " + name(t), 60), url: themaLink(gruppeId, Number(t.thread_id)) }
    : { text: kuerzen("💬 Chat starten: " + name(t), 60), callback_data: `start:${t.fahrer_nr}` }]) };
}
export function knopfLesen(d: unknown): { aktion: "menue"; wert: "alle" | "suche" | "info" } | { aktion: "alle_ok" | "alle_nein"; id: number }
  | { aktion: "start"; nr: number } | null {
  const s = String(d ?? "");
  const m0 = /^start:(\d{1,9})$/.exec(s);
  if (m0) return { aktion: "start", nr: Number(m0[1]) };
  const m1 = /^menue:(alle|suche|info)$/.exec(s);
  if (m1) return { aktion: "menue", wert: m1[1] as "alle" | "suche" | "info" };
  const m2 = /^alle:(ok|nein):(\d{1,15})$/.exec(s);
  if (m2) return { aktion: m2[1] === "ok" ? "alle_ok" : "alle_nein", id: Number(m2[2]) };
  return null;
}
