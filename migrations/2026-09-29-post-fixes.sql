-- Post & Strafen: Nachbesserungen aus dem Review (29.09.2026)
-- 1) Freigabe nur fuer offene Faelle ohne Pruefgrund.
-- 2) "prüfen" -> vom Buero geprueft uebernehmen (Spec: Fall mit Entwurf, per Klick sendbar).

create or replace function public.post_freigeben(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang
     set status = 'freigegeben', freigegeben_am = now(), freigegeben_von = auth.uid()
   where id = p_id and fahrer_id is not null and pruef_grund is null and status = 'offen'
     and art in ('strafverfuegung','anonymverfuegung','zahlungsaufforderung','mahnung');
  if not found then raise exception 'freigabe_nicht_moeglich'; end if;
end $$;

-- Buero hat das PDF angesehen und Empfaenger/GZ bestaetigt oder korrigiert.
create or replace function public.post_pruefung_bestaetigen(p_id uuid, p_antwort_email text, p_gz text)
returns void language plpgsql security definer set search_path = public as $$
declare v_mail text := lower(btrim(p_antwort_email)); v_gz text := btrim(p_gz);
begin
  perform public.post_nur_buero();
  if v_mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.gv\.at$' then raise exception 'mailadresse_ungueltig'; end if;
  if coalesce(v_gz, '') = '' then raise exception 'gz_fehlt'; end if;
  update public.post_eingang
     set antwort_email = v_mail, gz = v_gz, pruef_grund = null, status = 'offen',
         notiz = concat_ws(E'\n', nullif(notiz, ''), 'Geprüft ' || to_char(now() at time zone 'Europe/Vienna', 'DD.MM.YYYY HH24:MI'))
   where id = p_id and status = 'pruefen' and art = 'lenkererhebung' and tatzeit is not null;
  if not found then raise exception 'nicht_moeglich'; end if;
end $$;

revoke all on function public.post_pruefung_bestaetigen(uuid, text, text) from public, anon;
grant execute on function public.post_pruefung_bestaetigen(uuid, text, text) to authenticated;
