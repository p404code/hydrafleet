-- Zwei Zuordnungen, die den Vergleich API gegen CSV verfaelscht haben.

-- 1) settlement_fahrer nahm bei gleicher Telefonnummer den Fahrer mit der
--    kleinsten id - auch wenn der abgemeldet ist. "Aslanbek Dombaew" (639, aktiv)
--    landete so bei der Karteileiche "Aslambek Dombaew" (633, inaktiv, gleiche
--    Nummer): die alte Zeile stand als "nur alt", die API-Zeile als "nur API".
--    Jetzt schlaegt aktiv inaktiv, erst dann die id.
create or replace function public.settlement_fahrer(p_telefon text, p_name text)
returns integer language sql stable set search_path to 'public' as $function$
  select f.id from public.fahrer f
  where (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon))
     or f.name = p_name
  order by (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) desc,
           f.aktiv desc nulls last,
           f.id
  limit 1
$function$;

-- 2) Muhammet Usta faehrt auf dem Bolt-Konto "Kamiran Haqqi". Das alte Konto bei
--    EH (9877577f) ist seit 23.09. von Hand zugeordnet; seit dem Wechsel zu Serdo
--    gibt es ein neues Konto mit eigener UUID (ein Fahrer hat je Bolt-Firma eine).
insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von)
select 'bolt', '69b35183-d9ad-4914-9681-f73150da3b0d', 282, 'Claude (Auftrag Boyko)'
where not exists (select 1 from public.zuordnung_manuell
                  where anbieter = 'bolt' and driver_uuid = '69b35183-d9ad-4914-9681-f73150da3b0d');
select public.notion_zuordnung_aktualisieren();
