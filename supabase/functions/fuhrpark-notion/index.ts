// fuhrpark-notion - schreibt die Fahrer↔Auto-Zuordnung aus HYDRAlink nach Notion („Fahrer aktuell“ beim Auto).
//
// Aufruf (Dashboard direkt nach dem Speichern, Büro-JWT; oder service_role):
//   POST /functions/v1/fuhrpark-notion {"autos": ["W204TX"]}   -> nur diese Autos (sofern offen)
//   POST /functions/v1/fuhrpark-notion {}                      -> alle offenen Autos
// Offen = Zeile in fuhrpark_notion_offen (setzen auto_fahrer_setzen/_entfernen). Was hier scheitert, holt
// notion-sync beim nächsten 10-Minuten-Lauf nach. Spec: docs/superpowers/specs/2026-11-01-autoliste-design.md
import { notionNachziehen } from "../_shared/fuhrpark-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTION       = "https://api.notion.com/v1";
const NOTION_VER   = "2026-03-11";   // wie notion-sync

const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (name: string, args: unknown = {}) => db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

// Wie bei notion-sync: nur service_role oder Büro (app_metadata.app_role admin/user); verify_jwt bleibt an.
function aufruferErlaubt(req: Request): boolean {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return false;
  if (tok === SERVICE_KEY) return true;
  try {
    const teil = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(teil.padEnd(Math.ceil(teil.length / 4) * 4, "=")));
    return p.role === "service_role" || ["admin", "user"].includes(p.app_metadata?.app_role);
  } catch { return false; }
}
const antwort = (daten: unknown, status = 200) =>
  new Response(JSON.stringify(daten), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (!aufruferErlaubt(req)) return antwort({ fehler: "nicht_berechtigt" }, 403);
  try {
    const body = await req.json().catch(() => ({}));
    const autos = Array.isArray(body?.autos) ? body.autos.filter((x: unknown) => typeof x === "string").slice(0, 50) : null;

    const [v] = await db("verbindungen?anbieter=eq.notion&status=eq.aktiv&select=id&limit=1");
    if (!v) return antwort({ fehler: "keine aktive Notion-Verbindung" }, 500);
    const token = (await rpc("verbindung_zugang", { p_verbindung_id: v.id }))?.token;
    if (!token) return antwort({ fehler: "kein Notion-Token im Vault" }, 500);

    const ergebnis = await notionNachziehen(autos, {
      soll: (keys) => rpc("fuhrpark_notion_soll", { p_keys: keys }),
      patch: async (pageId, b) => {
        const r = await fetch(`${NOTION}/pages/${pageId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
          body: JSON.stringify(b),
        });
        return { ok: r.ok, status: r.status, text: r.ok ? "" : await r.text() };
      },
      erledigt: async (key) => { await rpc("fuhrpark_notion_erledigt", { p_key: key }); },
    });
    return antwort(ergebnis);
  } catch (e) {
    return antwort({ fehler: String(e).slice(0, 500) }, 500);
  }
});
