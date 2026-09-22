// bolt-sync - holt Auftraege, Fahrer und Fahrzeuge von der Bolt Fleet Integration API.
//
// Laeuft ueber alle aktiven Zeilen in 'verbindungen' mit anbieter='bolt'.
// Schreibt NUR in die Rohdaten-Tabellen. settlements wird nicht angefasst.
//
// Aufruf (service_role-Key im Authorization-Header):
//   POST /functions/v1/bolt-sync            -> ISO-Vorwoche
//   POST /functions/v1/bolt-sync {"woche":"2026-W38"}
//   POST /functions/v1/bolt-sync {"von":"2026-09-14","bis":"2026-09-20"}
//
// Warum time_range_filter_type='price_review':
//   Gegen den CSV-Import der KW 2026-W38 abgeglichen. Mit 'price_review' stimmen
//   Bruttoumsatz und Auszahlung je Fahrer auf den Cent, mit 'created' nicht.
//
// Abgleich mit der bestehenden Berechnung (verifiziert an 30 Fahrern, KW38):
//   bolt_brutto     = Σ (ride_price + cancellation_fee)
//   bolt_auszahlung = Σ net_earnings − Σ ride_price aller Fahrten mit payment_method='cash'
// Diese Aggregation macht die Abrechnung, nicht dieser Sync.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOLT_API     = "https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1";
const BOLT_TOKEN   = "https://oidc.bolt.eu/token";
const SEITE        = 1000; // max laut Bolt-Spec fuer getFleetOrders

// ---------- Supabase ----------
const kopf = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, {
    ...init,
    headers: { ...kopf, ...(init.headers ?? {}) },
  });
  // PostgREST antwortet je nach Prefer mit 204 ODER mit 201 und leerem Body.
  // Deshalb erst den Text lesen und nur parsen, wenn wirklich etwas da ist.
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name: string, args: unknown) {
  return await db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

// Upsert in Haeppchen, damit eine grosse Woche nicht an einer Request-Grenze scheitert.
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
// Die Woche ergibt sich aus dem abgefragten Fenster, nicht aus einem Feld im Auftrag:
// bei time_range_filter_type='price_review' liegt per Definition jeder Treffer darin.
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
  const montagKW1 = new Date(vierter);
  montagKW1.setUTCDate(vierter.getUTCDate() - ((vierter.getUTCDay() || 7) - 1));
  const mo = new Date(montagKW1);
  mo.setUTCDate(montagKW1.getUTCDate() + (w - 1) * 7);
  return mo;
}

// Wien ist im Sommer UTC+2, im Winter UTC+1. Statt eine Zeitzonenbibliothek zu laden,
// fragen wir die Laufzeit nach dem Offset fuer genau diesen Tag.
function wienOffsetMinuten(d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", timeZoneName: "longOffset",
  }).format(d);
  const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 60;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function fenster(von: string, bis: string) {
  const start = new Date(`${von}T00:00:00Z`);
  const ende  = new Date(`${bis}T23:59:59Z`);
  return {
    start_ts: Math.floor(start.getTime() / 1000) - wienOffsetMinuten(start) * 60,
    end_ts:   Math.floor(ende.getTime()  / 1000) - wienOffsetMinuten(ende)  * 60,
  };
}

function alsDatum(d: Date) { return d.toISOString().slice(0, 10); }

// ---------- Bolt ----------
async function holeToken(client_id: string, client_secret: string) {
  const r = await fetch(BOLT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "fleet-integration:api",
      client_id, client_secret,
    }),
  });
  if (!r.ok) throw new Error(`Bolt-Token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token as string;
}

// Das Token laeuft nach 10 Minuten ab, deshalb wird es je Lauf frisch geholt
// und nirgends zwischengespeichert.
async function bolt(token: string, pfad: string, body?: unknown) {
  const r = await fetch(`${BOLT_API}/${pfad}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  // Bolt antwortet auch bei Fachfehlern mit HTTP 200 und code != 0.
  if (!r.ok || j.code !== 0) throw new Error(`Bolt ${pfad}: ${JSON.stringify(j).slice(0, 400)}`);
  return j.data;
}

const zeit = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toISOString() : null;

// ---------- Abbildung auf die Tabellen ----------
function auftragsZeile(o: any, company_id: number, company_name: string | null,
                       woche: string, lauf: string) {
  const p = o.order_price ?? {};
  const k = o.category_info ?? {};
  return {
    order_reference: o.order_reference,
    company_id, company_name,
    driver_uuid: o.driver_uuid, partner_uuid: o.partner_uuid,
    driver_name: o.driver_name, driver_phone: o.driver_phone,
    vehicle_license_plate: o.vehicle_license_plate, vehicle_model: o.vehicle_model,
    order_status: o.order_status,
    driver_cancelled_reason: o.driver_cancelled_reason,
    price_review_reason: o.price_review_reason,
    payment_method: o.payment_method,
    is_scheduled: o.is_scheduled, is_optional: o.is_optional,
    category_name: k.name ?? null, category_seats: k.seats ?? null,
    category_vehicle_type: k.vehicle_type ?? null,
    order_created_at: zeit(o.order_created_timestamp),
    order_accepted_at: zeit(o.order_accepted_timestamp),
    order_pickup_at: zeit(o.order_pickup_timestamp),
    order_drop_off_at: zeit(o.order_drop_off_timestamp),
    order_finished_at: zeit(o.order_finished_timestamp),
    order_cancelled_at: zeit(o.order_cancelled_timestamp),
    order_no_show_at: zeit(o.order_no_show_timestamp),
    payment_confirmed_at: zeit(o.payment_confirmed_timestamp),
    pickup_address: o.pickup_address, destination_address: o.destination_address,
    ride_distance: o.ride_distance,
    predicted_ride_distance: o.predicted_ride_distance,
    road_distance_at_matching: o.road_distance_at_matching,
    ride_price: p.ride_price, booking_fee: p.booking_fee, toll_fee: p.toll_fee,
    cancellation_fee: p.cancellation_fee, tip: p.tip, net_earnings: p.net_earnings,
    cash_discount: p.cash_discount, in_app_discount: p.in_app_discount,
    commission: p.commission,
    woche,
    roh: o,
    sync_run_id: lauf,
    aktualisiert_am: new Date().toISOString(),
  };
}

function fahrerZeile(d: any, company_id: number, lauf: string) {
  const v = d.active_vehicle ?? {};
  return {
    driver_uuid: d.driver_uuid, partner_uuid: d.partner_uuid, company_id,
    first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.phone,
    state: d.state, suspension_reason: d.suspension_reason ?? null,
    has_cash_payment: d.has_cash_payment,
    driver_score: d.driver_score, driver_rating: d.driver_rating,
    active_categories: d.active_categories ?? [],
    inactive_categories: d.inactive_categories ?? [],
    eligible_for_scheduled_ride: d.eligible_for_scheduled_ride,
    active_vehicle_id: v.id ?? null, active_vehicle_reg: v.reg_number ?? null,
    active_vehicle_model: v.model ?? null,
    roh: d, sync_run_id: lauf, aktualisiert_am: new Date().toISOString(),
  };
}

function fahrzeugZeile(v: any, company_id: number, lauf: string) {
  return {
    id: v.id, uuid: v.uuid, company_id,
    reg_number: v.reg_number, model: v.model, year: v.year, seats: v.seats,
    color: v.color, vin: v.vin,
    car_transport_licence_number: v.car_transport_licence_number,
    state: v.state, suspension_reason: v.suspension_reason,
    eligible_category_groups: v.eligible_category_groups ?? [],
    roh: v, sync_run_id: lauf, aktualisiert_am: new Date().toISOString(),
  };
}

// ---------- Ein Lauf je Verbindung ----------
async function syncVerbindung(v: any, von: string, bis: string, woche: string) {
  const [lauf] = await db("sync_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      verbindung_id: v.id, zeitraum_von: von, zeitraum_bis: bis, status: "laeuft",
    }),
  });

  try {
    const zugang = await rpc("verbindung_zugang", { p_verbindung_id: v.id });
    const token = await holeToken(zugang.client_id, zugang.client_secret);
    const { company_ids } = await bolt(token, "getCompanies");
    const { start_ts, end_ts } = fenster(von, bis);

    let auftraege = 0, fahrer = 0, fahrzeuge = 0;

    for (const co of company_ids) {
      // Auftraege, seitenweise
      const alle: any[] = [];
      let offset = 0, name: string | null = null;
      while (true) {
        const d = await bolt(token, "getFleetOrders", {
          company_ids: [co], start_ts, end_ts, offset, limit: SEITE,
          time_range_filter_type: "price_review",
        });
        name = d.company_name ?? name;
        alle.push(...d.orders);
        offset += d.orders.length;
        if (d.orders.length === 0 || offset >= d.total_orders) break;
      }
      if (alle.length) {
        await upsert("bolt_orders", "order_reference",
          alle.map((o) => auftragsZeile(o, co, name, woche, lauf.id)));
        auftraege += alle.length;
      }

      // Fahrer
      const d1 = await bolt(token, "getDrivers",
        { company_id: co, start_ts, end_ts, offset: 0, limit: SEITE });
      // driver_uuid ist laut Spec nullable, ist aber der Primaerschluessel -> solche
      // Zeilen ueberspringen statt den ganzen Lauf scheitern zu lassen.
      const d1ok = (d1.drivers ?? []).filter((x: any) => x.driver_uuid);
      if (d1ok.length) {
        await upsert("bolt_drivers", "driver_uuid",
          d1ok.map((x: any) => fahrerZeile(x, co, lauf.id)));
        fahrer += d1ok.length;
      }

      // Fahrzeuge (limit hier max 100 laut Spec)
      const d2 = await bolt(token, "getVehicles",
        { company_id: co, start_ts, end_ts, offset: 0, limit: 100 });
      const d2ok = (d2.vehicles ?? []).filter((x: any) => x.id != null);
      if (d2ok.length) {
        await upsert("bolt_vehicles", "id",
          d2ok.map((x: any) => fahrzeugZeile(x, co, lauf.id)));
        fahrzeuge += d2ok.length;
      }
    }

    await db(`sync_runs?id=eq.${lauf.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ende: new Date().toISOString(), anzahl: auftraege, status: "ok" }),
    });
    await db(`verbindungen?id=eq.${v.id}`, {
      method: "PATCH",
      body: JSON.stringify({ letzter_abruf: new Date().toISOString(), letzter_fehler: null }),
    });

    return { firma: v.firma, company_ids, auftraege, fahrer, fahrzeuge, status: "ok" };
  } catch (e) {
    const text = String(e).slice(0, 1000);
    await db(`sync_runs?id=eq.${lauf.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ende: new Date().toISOString(), status: "fehler", fehler: text }),
    });
    await db(`verbindungen?id=eq.${v.id}`, {
      method: "PATCH",
      body: JSON.stringify({ letzter_abruf: new Date().toISOString(), letzter_fehler: text }),
    });
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
      // Standard: ISO-Vorwoche, wie im Upload-Tab vorausgewaehlt
      woche = body.woche ?? isoWoche(new Date(Date.now() - 7 * 86400000));
      const mo = montagDerWoche(woche);
      const so = new Date(mo); so.setUTCDate(mo.getUTCDate() + 6);
      von = alsDatum(mo); bis = alsDatum(so);
    }

    const verbindungen = await db(
      "verbindungen?anbieter=eq.bolt&status=eq.aktiv&select=id,firma,externe_id");
    if (!verbindungen.length) throw new Error("Keine aktive Bolt-Verbindung");

    const ergebnis = [];
    for (const v of verbindungen) ergebnis.push(await syncVerbindung(v, von, bis, woche));

    const fehler = ergebnis.some((r) => r.status === "fehler");
    return new Response(
      JSON.stringify({ woche, von, bis, verbindungen: ergebnis }, null, 2),
      { status: fehler ? 207 : 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ fehler: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" } });
  }
});
