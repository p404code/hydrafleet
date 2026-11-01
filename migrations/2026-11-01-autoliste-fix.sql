-- ============================================================================
-- Autoliste – Korrekturen aus dem Review (01.11.2026), vor dem Scharfschalten
--
-- #1 auto_fahrer_setzen: Pauschale muss in der Stichwoche gelten. Sonst legte der Pauschalen-Wächter beim
--    Anlegen der fahrer-Zeile eine 0-€-„neuanlage“ an, die die künftige Pauschale dauerhaft verdeckt hätte.
-- #2 fuhrpark_notion_offen.seit wird bei jeder neuen Vormerkung erneuert; fuhrpark_notion_erledigt streicht nur,
--    wenn seit noch derselbe ist (sonst ginge eine während des Notion-Schreibens gespeicherte Änderung verloren).
-- #3 fuhrpark_notion_soll behält Notion-Fahrer, die noch nicht in HYDRAlink übernommen sind (z. B. Pavel-Fall),
--    statt sie beim Zurückschreiben aus Notion zu entfernen.
-- ============================================================================

create or replace function public.auto_fahrer_setzen(
  p_kennzeichen_key text, p_nr integer, p_art text default null, p_betrag numeric default null,
  p_prozent_satz numeric default null, p_prozent_schwelle numeric default null,
  p_gilt_ab text default null, p_gilt_bis text default null, p_grund text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_auto  public.fuhrpark;
  v_nf    public.notion_fahrer;
  v_alt   public.fahrer_auto;
  v_wer   text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
  v_stich text := public.pauschale_stichwoche();
  v_kz    text;
  v_fid   integer;
  v_autos text[];
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_auto from public.fuhrpark where kennzeichen_key = p_kennzeichen_key;
  if v_auto.kennzeichen_key is null or coalesce(v_auto.firma, '') = 'Abgemeldet' then
    raise exception 'Auto % ist nicht angemeldet', p_kennzeichen_key using errcode = '22023'; end if;
  select * into v_nf from public.notion_fahrer where notion_fahrer_id = p_nr order by aktualisiert_am desc limit 1;
  if v_nf.notion_fahrer_id is null or nullif(btrim(v_nf.name), '') is null then
    raise exception 'Fahrer Nr. % ist nicht in Notion', p_nr using errcode = '22023'; end if;

  if p_art is not null then
    perform public.pauschale_setzen(p_nr, p_art, p_betrag, p_prozent_satz, p_prozent_schwelle, p_gilt_ab, p_gilt_bis, p_grund);
  end if;
  -- #1: ohne Pauschale in der Stichwoche würde der Wächter eine 0-€-neuanlage anlegen
  if (public.pauschale_fuer(p_nr, v_stich)).id is null then
    if p_art is null then
      raise exception 'Pauschale fehlt – bitte für % festlegen', btrim(v_nf.name) using errcode = '22023';
    end if;
    raise exception 'Für % gibt es ab % noch keine Pauschale – „gilt ab“ bitte auf % setzen', btrim(v_nf.name), v_stich, v_stich
      using errcode = '22023';
  end if;

  v_kz := public.kennzeichen_anzeige(v_auto.kennzeichen);
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  values (p_nr, p_kennzeichen_key, v_kz, 'hand', v_wer);

  select max(id) into v_fid from public.fahrer where notion_fahrer_id = p_nr;
  if v_fid is null then
    -- Name wie der n8n-Full-Sync (upsert on_conflict=name); Pauschale setzt der Wächter aus dem Verlauf
    insert into public.fahrer (name, telefon, kennzeichen, aktiv, notion_fahrer_id, mietmodell, basis_miete, prozent_satz, prozent_schwelle)
    values (btrim(v_nf.name), public.telefon_wie_fullsync(v_nf.telefon), v_kz, true, p_nr, 'fix', 0, 0, 0);
  else
    update public.fahrer set kennzeichen = v_kz, aktiv = true where id = v_fid;
  end if;
  perform public.pauschalen_anwenden(p_nr);

  v_autos := array_remove(array[p_kennzeichen_key,
    case when v_alt.kennzeichen_key is distinct from p_kennzeichen_key then v_alt.kennzeichen_key end], null);
  -- #2: seit erneuern, damit ein gerade laufendes Nachziehen diese Änderung nicht abhakt
  insert into public.fuhrpark_notion_offen (kennzeichen_key, seit) select unnest(v_autos), clock_timestamp()
    on conflict (kennzeichen_key) do update set seit = excluded.seit;
  return jsonb_build_object('autos', to_jsonb(v_autos));
end $$;

create or replace function public.auto_fahrer_entfernen(p_nr integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alt public.fahrer_auto;
  v_wer text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  if v_alt.kennzeichen_key is null then return jsonb_build_object('autos', '[]'::jsonb); end if;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  values (p_nr, null, null, 'hand', v_wer);
  -- aktiv bleibt: Umsätze der laufenden Woche werden noch abgerechnet
  update public.fahrer set kennzeichen = null where id = (select max(id) from public.fahrer where notion_fahrer_id = p_nr);
  insert into public.fuhrpark_notion_offen (kennzeichen_key, seit) values (v_alt.kennzeichen_key, clock_timestamp())
    on conflict (kennzeichen_key) do update set seit = excluded.seit;
  return jsonb_build_object('autos', jsonb_build_array(v_alt.kennzeichen_key));
end $$;

-- #2 + #3: Soll-Zustand mit seit; Notion-Fahrer ohne HL-Verlauf bleiben im Feld
drop function if exists public.fuhrpark_notion_soll(text[]);
create function public.fuhrpark_notion_soll(p_keys text[] default null)
returns table (kennzeichen_key text, notion_page_id text, page_ids text[], seit timestamptz)
language sql stable security definer set search_path = public as $$
  select o.kennzeichen_key, fp.notion_page_id,
         coalesce((select array_agg(distinct x.pid order by x.pid) from (
             select nf.notion_page_id as pid
               from public.fahrer_auto_aktuell a
               join lateral (select n.notion_page_id from public.notion_fahrer n where n.notion_fahrer_id = a.notion_fahrer_id
                              order by n.aktualisiert_am desc limit 1) nf on true
              where a.kennzeichen_key = o.kennzeichen_key
             union
             select nf.notion_page_id
               from unnest(fp.notion_fahrer) as u(nr)
               join lateral (select n.notion_page_id from public.notion_fahrer n where n.notion_fahrer_id = u.nr
                              order by n.aktualisiert_am desc limit 1) nf on true
              where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = u.nr)
           ) x where x.pid is not null), '{}') as page_ids,
         o.seit
    from public.fuhrpark_notion_offen o
    left join public.fuhrpark fp on fp.kennzeichen_key = o.kennzeichen_key
   where p_keys is null or o.kennzeichen_key = any (p_keys)
   order by o.kennzeichen_key
$$;
drop function if exists public.fuhrpark_notion_erledigt(text);
create or replace function public.fuhrpark_notion_erledigt(p_key text, p_seit timestamptz) returns void
language sql security definer set search_path = public as $$
  -- auf Millisekunden verglichen (JSON-Weg kann Mikrosekunden verlieren); eine neuere Vormerkung hat ein anderes seit
  delete from public.fuhrpark_notion_offen
   where kennzeichen_key = p_key and date_trunc('milliseconds', seit) = date_trunc('milliseconds', p_seit)
$$;
revoke all on function public.fuhrpark_notion_soll(text[]), public.fuhrpark_notion_erledigt(text, timestamptz)
  from public, anon, authenticated;
