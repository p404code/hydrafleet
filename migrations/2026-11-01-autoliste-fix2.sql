-- ============================================================================
-- Autoliste – Korrekturen aus dem Live-Probelauf (01.11.2026), vor dem Scharfschalten
--
-- * notion_platzhalter(): Notion-„Fahrer“ wie „S—T—E—H—T“ / „BIS“ sind Platzhalter (der n8n-Full-Sync ignoriert sie
--   genauso) – nicht in „in Notion, nicht übernommen“, nicht einsetzbar.
-- * auto_fahrer_setzen: gleicher Name mit anderer Fahrer-Nr. = Fahrer steht in Notion doppelt -> klare Meldung statt
--   Unique-Fehler (fahrer.name ist eindeutig, der Full-Sync upsertet darauf).
-- ============================================================================

create or replace function public.notion_platzhalter(p_name text) returns boolean
language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-zÀ-ſ]', '', 'g')) in ('STEHT', 'BIS')
$$;

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
  v_doppelt_id integer;
  v_doppelt_nr integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_auto from public.fuhrpark where kennzeichen_key = p_kennzeichen_key;
  if v_auto.kennzeichen_key is null or coalesce(v_auto.firma, '') = 'Abgemeldet' then
    raise exception 'Auto % ist nicht angemeldet', p_kennzeichen_key using errcode = '22023'; end if;
  select * into v_nf from public.notion_fahrer where notion_fahrer_id = p_nr order by aktualisiert_am desc limit 1;
  if v_nf.notion_fahrer_id is null or nullif(btrim(v_nf.name), '') is null then
    raise exception 'Fahrer Nr. % ist nicht in Notion', p_nr using errcode = '22023'; end if;
  if public.notion_platzhalter(v_nf.name) then
    raise exception '„%“ ist ein Platzhalter in Notion, kein Fahrer', btrim(v_nf.name) using errcode = '22023'; end if;

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
    -- Gleicher Name mit anderer Fahrer-Nr.: der Fahrer steht in Notion doppelt (Probelauf 01.11.: 36/192, 239/253, 245/200)
    select id, notion_fahrer_id into v_doppelt_id, v_doppelt_nr from public.fahrer where name = btrim(v_nf.name) limit 1;
    if v_doppelt_id is not null then
      raise exception 'Es gibt schon einen Fahrer „%“ (Nr. %) – steht er in Notion doppelt? Bitte Nr. % wählen oder in Notion beim Auto den richtigen Fahrer eintragen.',
        btrim(v_nf.name), coalesce(v_doppelt_nr::text, '–'), coalesce(v_doppelt_nr::text, '–') using errcode = '22023';
    end if;
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


create or replace view public.autoliste with (security_invoker = true) as
with s as (select public.pauschale_stichwoche() as w),
akt as (
  select a.notion_fahrer_id, a.kennzeichen_key, a.am, btrim(nf.name) as name,
         p.art, p.betrag, p.prozent_satz, p.prozent_schwelle
    from public.fahrer_auto_aktuell a
   cross join s
    left join lateral (select n.name from public.notion_fahrer n where n.notion_fahrer_id = a.notion_fahrer_id
                        order by n.aktualisiert_am desc limit 1) nf on true
    left join lateral public.pauschale_fuer(a.notion_fahrer_id, s.w) p on true
   where a.kennzeichen_key is not null
)
select fp.kennzeichen_key, fp.kennzeichen, fp.modell, fp.firma,
  coalesce((select jsonb_agg(jsonb_build_object('nr', akt.notion_fahrer_id, 'name', akt.name, 'art', akt.art,
              'betrag', akt.betrag, 'prozent_satz', akt.prozent_satz, 'prozent_schwelle', akt.prozent_schwelle, 'seit', akt.am)
              order by akt.name)
              from akt where akt.kennzeichen_key = fp.kennzeichen_key), '[]'::jsonb) as fahrer,
  coalesce((select jsonb_agg(jsonb_build_object('nr', u.nr, 'name', btrim(nf.name), 'telefon', nf.telefon) order by nf.name)
              from unnest(fp.notion_fahrer) as u(nr)
              join lateral (select n.name, n.telefon from public.notion_fahrer n where n.notion_fahrer_id = u.nr
                             order by n.aktualisiert_am desc limit 1) nf on true
             where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = u.nr)
               and not public.notion_platzhalter(nf.name)), '[]'::jsonb)
    as notion_nicht_uebernommen,
  exists (select 1 from public.fuhrpark_notion_offen o where o.kennzeichen_key = fp.kennzeichen_key) as notion_offen
from public.fuhrpark fp
where coalesce(fp.firma, '') <> 'Abgemeldet';
