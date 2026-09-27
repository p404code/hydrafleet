// uber-probe - stillgelegt am 2026-09-28. War ein Wegwerf-Werkzeug aus der
// Erkundungsphase und fuer jeden mit dem oeffentlichen anon-Key aufrufbar.
// Tut nichts mehr. Im Supabase-Dashboard unter Edge Functions endgueltig loeschen.
Deno.serve(() => new Response(JSON.stringify({ fehler: "stillgelegt" }),
  { status: 410, headers: { "Content-Type": "application/json" } }));
