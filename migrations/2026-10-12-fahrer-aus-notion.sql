-- ============================================================================
-- Plattform-Konto einem Fahrer zuordnen, den es in `fahrer` noch nicht gibt
-- Datum: 2026-10-12
--
-- Die Handzuordnung (konto_zuordnen) kennt nur Fahrer aus `fahrer`. Die Tabelle
-- fuellt der n8n-Sync aus Notion - wer dort nicht ankommt (12.10.: Ossama Eid,
-- Zahra Houshangpanah, Bashiir Mohamud, Davoud Haghnejad), laesst sich nicht
-- waehlen, und der AbrechnungsBot rechnet ihn als "UNBEKANNT" ohne Pauschale.
--
-- Neu: Notion-Fahrer ohne Eintrag stehen in der Auswahl; das Buero legt den
-- Eintrag mit Mietmodell, Pauschale und Kennzeichen an und ordnet zu.
--
-- ACHTUNG: `fahrer` gehoert dem alten System. Der AbrechnungsBot liest die neue
-- Zeile ab dem naechsten Lauf (Pauschale wird abgezogen), und der n8n-Sync
-- schreibt in dieselbe Tabelle. Legt er die Person spaeter selbst an, gibt es
-- zwei Zeilen mit derselben Notion-Nr. - konto_zuordnen meldet das dann.
--
-- Rollback: drop function konto_fahrer_anlegen; drop view notion_fahrer_ohne_eintrag;
--   (angelegte fahrer-Zeilen bleiben)
-- ============================================================================

-- Notion-Fahrer, zu denen kein aktiver Eintrag in `fahrer` gehoert.
create or replace view public.notion_fahrer_ohne_eintrag with (security_invoker = true) as
select n.notion_fahrer_id, n.name, n.telefon, n.status, n.firma,
       public.tel_key(n.telefon) as tel_key, public.name_key(n.name) as name_key
from public.notion_fahrer n
where n.notion_fahrer_id is not null
  and coalesce(btrim(n.name), '') <> ''
  and coalesce(n.status, '') <> 'Abgemeldet'
  and not exists (select 1 from public.fahrer f
                  where f.aktiv and f.notion_fahrer_id = n.notion_fahrer_id);

revoke all on public.notion_fahrer_ohne_eintrag from public, anon;
grant select on public.notion_fahrer_ohne_eintrag to authenticated;

-- Legt den Fahrer aus dem Notion-Eintrag an und ordnet ihm das Konto zu.
-- Prozentsatz und Schwelle folgen dem Mietmodell wie bei allen anderen Fahrern
-- (f12: 10 % ab 1200, f11: 10 % ab 1100, fix: 0).
create or replace function public.konto_fahrer_anlegen(
  p_anbieter text, p_driver_uuid text, p_notion_fahrer_id integer,
  p_mietmodell text, p_basis_miete numeric, p_kennzeichen text)
returns integer
language plpgsql security definer set search_path = public as $$
declare n record; v_tel text; v_id integer; v_schon text;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if p_anbieter not in ('bolt','uber') then raise exception 'Unbekannter Anbieter %', p_anbieter using errcode = '22023'; end if;
  if p_mietmodell is null or p_mietmodell not in ('fix','f11','f12') then
    raise exception 'Mietmodell fehlt (fix, f11 oder f12)' using errcode = '22023'; end if;
  if p_basis_miete is null or p_basis_miete < 0 or p_basis_miete > 2000 then
    raise exception 'Pauschale fehlt oder liegt nicht zwischen 0 und 2000' using errcode = '22023'; end if;
  if coalesce(btrim(p_kennzeichen), '') = '' then
    raise exception 'Kennzeichen fehlt' using errcode = '22023'; end if;

  select * into n from public.notion_fahrer where notion_fahrer_id = p_notion_fahrer_id limit 1;
  if not found or coalesce(btrim(n.name), '') = '' then
    raise exception 'Notion-Fahrer Nr. % nicht gefunden', p_notion_fahrer_id using errcode = 'P0002'; end if;

  -- Nie einen zweiten Eintrag fuer dieselbe Person: weder ueber die Notion-Nr.
  -- noch ueber Telefon oder Namen.
  select f.name || ' (Nr. ' || coalesce(f.notion_fahrer_id::text, '–') || ')' into v_schon
  from public.fahrer f
  where f.aktiv and (f.notion_fahrer_id = p_notion_fahrer_id
     or (public.tel_key(n.telefon) <> '' and public.tel_key(f.telefon) = public.tel_key(n.telefon))
     or (public.name_key(n.name) <> '' and public.name_key(f.name) = public.name_key(n.name)))
  order by f.id limit 1;
  if v_schon is not null then
    raise exception 'Diesen Fahrer gibt es schon: % – bitte dort zuordnen', v_schon using errcode = 'P0001'; end if;

  -- Telefon wie in `fahrer` ueblich: +43…  (Notion hat 0676…, 676… und +43 676 …)
  v_tel := public.tel_key(n.telefon);
  if v_tel = '' then v_tel := null;
  else
    if v_tel like '6%' and length(v_tel) <= 11 then v_tel := '43' || v_tel; end if;
    v_tel := '+' || v_tel;
  end if;

  insert into public.fahrer (name, telefon, kennzeichen, mietmodell, basis_miete,
                             prozent_satz, prozent_schwelle, aktiv, notion_fahrer_id)
  values (btrim(n.name), v_tel, btrim(p_kennzeichen), p_mietmodell, p_basis_miete,
          case when p_mietmodell = 'fix' then 0 else 10 end,
          case p_mietmodell when 'f12' then 1200 when 'f11' then 1100 else 0 end,
          true, p_notion_fahrer_id)
  returning id into v_id;

  perform public.konto_zuordnen(p_anbieter, p_driver_uuid, v_id);
  return v_id;
end $$;

revoke all on function public.konto_fahrer_anlegen(text, text, integer, text, numeric, text) from public, anon;
grant execute on function public.konto_fahrer_anlegen(text, text, integer, text, numeric, text) to authenticated;
