-- Bankdaten auch fuer Notion-Fahrer ohne fahrer-Eintrag (Korrektur Betreiber 16.10.2026):
-- in der Formular-Zuordnung fehlten Fahrer, die nur in Notion stehen (z. B. noch nicht im Fuhrpark).
-- Bankdaten haengen an der Notion-Nr.; es wird KEIN fahrer-Eintrag angelegt.
-- Gleicher Stand wie in 2026-10-15-bankdaten.sql / -uebernahme.sql.

create or replace function public.buero_bank_setzen(p_notion_fahrer_id integer, p_kontoinhaber text, p_iban text,
                                                    p_bic text default null, p_revtag text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  -- Auch Notion-Fahrer ohne fahrer-Eintrag (noch nicht im Fuhrpark): Bankdaten haengen an der Notion-Nr.
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id)
     and not exists (select 1 from public.notion_fahrer where notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein Fahrer mit Nr. % (weder Fahrer-Liste noch Notion)', p_notion_fahrer_id using errcode = 'P0002'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, p_kontoinhaber, p_iban, p_bic, p_revtag,
                                coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro'));
end $$;

create or replace function public.formular_iban_zuordnen(p_id bigint, p_notion_fahrer_id integer,
                                                         p_ueberschreiben boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare i public.fahrer_iban;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into i from public.fahrer_iban where id = p_id and status = 'neu' for update;
  if i.id is null then raise exception 'Eintrag % nicht offen', p_id using errcode = 'P0002'; end if;
  if not public.iban_gueltig(i.iban) then raise exception 'IBAN ungültig – bitte beim Fahrer nachfragen' using errcode = '22023'; end if;
  -- Auch Notion-Fahrer ohne fahrer-Eintrag (noch nicht im Fuhrpark): Bankdaten haengen an der Notion-Nr.
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id)
     and not exists (select 1 from public.notion_fahrer where notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein Fahrer mit Nr. % (weder Fahrer-Liste noch Notion)', p_notion_fahrer_id using errcode = 'P0002'; end if;
  if not coalesce(p_ueberschreiben, false) and exists (select 1 from public.fahrer_bank where notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Fahrer hat schon Bankdaten – nur mit ausdrücklichem Überschreiben' using errcode = 'P0001'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, i.kontoinhaber, i.iban, i.bic, i.revtag,
          'formular (' || coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro') || ')');
  update public.fahrer_iban set status = 'uebernommen', uebernommen_nr = p_notion_fahrer_id where id = p_id;
end $$;
