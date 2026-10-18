-- ============================================================================
-- Nicht zugeordnete myPOS-Zahlungen (__MYPOS:<Terminal>__, Status MYPOS_UNASSIGNED vom AbrechnungsBot) einem Fahrer
-- der Woche zuordnen (Betreiber 19.10.2026: "zuordnen in der aktuellen Abrechnung, Umsatz und evtl. % korrigieren").
-- Datum: 2026-10-19
--
-- mypos_zuordnen(<__MYPOS-Zeile>, <Fahrer-Zeile>): der Betrag wird myPOS-Umsatz des Fahrers; bruttoumsatz_gesamt,
-- wir_bekommen, prozent_abzug, abzug_gesamt und auszahlung werden nachgerechnet (Prozent wie der Bot: f11 >1100 x10 %,
-- f12 >1200 x10 %, sonst prozent_satz ueber prozent_schwelle; als Differenz, damit Bot-Eigenheiten erhalten bleiben).
-- Die __MYPOS-Zeile bleibt mit Status MYPOS_ZUGEORDNET stehen. Alles in mypos_zuordnungen -> rueckgaengig moeglich.
-- Ein erneuter CSV-Upload rechnet die Woche neu (Terminal dann in Notion zuordnen, sonst wieder __MYPOS).
-- Rollback: drop function mypos_zuordnung_zurueck, mypos_zuordnen, prozent_nach_regel; drop table mypos_zuordnungen;
-- ============================================================================

create or replace function public.prozent_nach_regel(p_mietmodell text, p_brutto numeric, p_satz numeric, p_schwelle numeric)
returns numeric language sql immutable set search_path = public as $$
  select round(case p_mietmodell
    when 'f11' then greatest(p_brutto - 1100, 0) * 0.10
    when 'f12' then greatest(p_brutto - 1200, 0) * 0.10
    else case when coalesce(p_satz, 0) > 0 and p_brutto > coalesce(nullif(p_schwelle, 0), 1200)
              then (p_brutto - coalesce(nullif(p_schwelle, 0), 1200)) * p_satz / 100 else 0 end end, 2)
$$;

create table if not exists public.mypos_zuordnungen (
  id                bigint generated always as identity primary key,
  woche             text not null,
  mypos_zeile_id    integer not null,
  terminal          text not null,
  betrag            numeric(10,2) not null,
  ziel_zeile_id     integer not null,
  ziel_name         text not null,
  vorher            jsonb not null,     -- Werte der Fahrer-Zeile vor der Zuordnung
  nachher           jsonb not null,
  zugeordnet_von    text not null,
  zugeordnet_am     timestamptz not null default now(),
  zurueck_am        timestamptz,
  zurueck_von       text
);
alter table public.mypos_zuordnungen enable row level security;
revoke all on public.mypos_zuordnungen from public, anon, authenticated;
grant select on public.mypos_zuordnungen to authenticated;
drop policy if exists buero_liest on public.mypos_zuordnungen;
create policy buero_liest on public.mypos_zuordnungen for select to authenticated using (public.is_app_user());

create or replace function public.mypos_zuordnen(p_mypos_id integer, p_ziel_id integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.settlements; z public.settlements; f public.fahrer; v_betrag numeric; v_brutto numeric;
        v_p_alt numeric; v_p_neu numeric; v_prozent numeric; v_ausz numeric; v_wer text; v_vorher jsonb; v_nachher jsonb;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  v_wer := coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro');
  select * into m from public.settlements where id = p_mypos_id for update;
  if m.id is null or m.fahrer_name not like '\_\_MYPOS:%' then raise exception 'Keine myPOS-Zeile' using errcode = 'P0002'; end if;
  if m.status <> 'MYPOS_UNASSIGNED' then raise exception 'Diese myPOS-Zahlung ist schon zugeordnet' using errcode = '22023'; end if;
  select * into z from public.settlements where id = p_ziel_id for update;
  if z.id is null or z.woche <> m.woche or z.fahrer_name like '\_\_%' then raise exception 'Fahrer gehört nicht zu dieser Woche' using errcode = '22023'; end if;
  if z.status <> 'berechnet' then raise exception 'Fahrer-Zeile ist nicht berechnet (%)', z.status using errcode = '22023'; end if;
  select * into f from public.fahrer where id = public.settlement_fahrer(z.telefon, z.fahrer_name);

  v_betrag := round(coalesce(m.mypos_summe, 0), 2);
  if v_betrag = 0 then raise exception 'Betrag ist 0' using errcode = '22023'; end if;
  v_brutto := coalesce(z.bruttoumsatz_gesamt, 0) + v_betrag;
  v_p_alt := public.prozent_nach_regel(z.mietmodell, coalesce(z.bruttoumsatz_gesamt, 0), f.prozent_satz, f.prozent_schwelle);
  v_p_neu := public.prozent_nach_regel(z.mietmodell, v_brutto, f.prozent_satz, f.prozent_schwelle);
  v_prozent := round(coalesce(z.prozent_abzug, 0) + (v_p_neu - v_p_alt), 2);
  v_ausz := round(coalesce(z.auszahlung, 0) + v_betrag - (v_prozent - coalesce(z.prozent_abzug, 0)), 2);
  v_vorher := jsonb_build_object('mypos_summe', z.mypos_summe, 'bruttoumsatz_gesamt', z.bruttoumsatz_gesamt, 'wir_bekommen', z.wir_bekommen,
    'prozent_abzug', z.prozent_abzug, 'abzug_gesamt', z.abzug_gesamt, 'auszahlung', z.auszahlung);

  update public.settlements set
    mypos_summe = round(coalesce(mypos_summe, 0) + v_betrag, 2),
    bruttoumsatz_gesamt = round(v_brutto, 2),
    wir_bekommen = round(coalesce(wir_bekommen, 0) + v_betrag, 2),
    prozent_abzug = v_prozent,
    abzug_gesamt = round(coalesce(miete, 0) + v_prozent, 2),
    auszahlung = v_ausz
  where id = z.id
  returning jsonb_build_object('mypos_summe', mypos_summe, 'bruttoumsatz_gesamt', bruttoumsatz_gesamt, 'wir_bekommen', wir_bekommen,
    'prozent_abzug', prozent_abzug, 'abzug_gesamt', abzug_gesamt, 'auszahlung', auszahlung) into v_nachher;

  update public.settlements set status = 'MYPOS_ZUGEORDNET', korrektur_note = 'zugeordnet an ' || z.fahrer_name || ' (' || v_wer || ')'
   where id = m.id;
  insert into public.mypos_zuordnungen (woche, mypos_zeile_id, terminal, betrag, ziel_zeile_id, ziel_name, vorher, nachher, zugeordnet_von)
  values (m.woche, m.id, substring(m.fahrer_name from '^__MYPOS:(.*)__$'), v_betrag, z.id, z.fahrer_name, v_vorher, v_nachher, v_wer);
  return jsonb_build_object('fahrer', z.fahrer_name, 'betrag', v_betrag, 'prozent_vorher', z.prozent_abzug, 'prozent_nachher', v_prozent,
    'auszahlung_vorher', z.auszahlung, 'auszahlung_nachher', v_ausz);
end $$;

-- Rueckgaengig: nur solange die Fahrer-Zeile seitdem nicht anders geaendert wurde (sonst Zuordnungen in falscher Reihenfolge)
create or replace function public.mypos_zuordnung_zurueck(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r public.mypos_zuordnungen; z public.settlements;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into r from public.mypos_zuordnungen where id = p_id for update;
  if r.id is null or r.zurueck_am is not null then raise exception 'Zuordnung nicht gefunden oder schon zurückgenommen' using errcode = 'P0002'; end if;
  select * into z from public.settlements where id = r.ziel_zeile_id for update;
  if z.id is null or z.auszahlung is distinct from (r.nachher->>'auszahlung')::numeric
     or z.mypos_summe is distinct from (r.nachher->>'mypos_summe')::numeric then
    raise exception 'Die Zeile von % wurde seitdem geändert (z. B. Neu-Upload) – bitte von Hand prüfen', r.ziel_name using errcode = '22023'; end if;
  update public.settlements set
    mypos_summe = (r.vorher->>'mypos_summe')::numeric, bruttoumsatz_gesamt = (r.vorher->>'bruttoumsatz_gesamt')::numeric,
    wir_bekommen = (r.vorher->>'wir_bekommen')::numeric, prozent_abzug = (r.vorher->>'prozent_abzug')::numeric,
    abzug_gesamt = (r.vorher->>'abzug_gesamt')::numeric, auszahlung = (r.vorher->>'auszahlung')::numeric
  where id = z.id;
  update public.settlements set status = 'MYPOS_UNASSIGNED', korrektur_note = null where id = r.mypos_zeile_id and status = 'MYPOS_ZUGEORDNET';
  update public.mypos_zuordnungen set zurueck_am = now(), zurueck_von = coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro') where id = p_id;
end $$;

revoke all on function public.mypos_zuordnen(integer, integer), public.mypos_zuordnung_zurueck(bigint) from public, anon;
grant execute on function public.mypos_zuordnen(integer, integer), public.mypos_zuordnung_zurueck(bigint) to authenticated;
