-- ============================================================================
-- Fahrzeugbilder aus dem Uber-Fleet-Portal
-- Datum: 2026-10-07
--
-- Uber zeigt je Fahrzeug ein Modellbild (z. B. "2021 Toyota Prius+", kein Foto des
-- echten Autos). Die Liste kommt aus der Fahrzeugseite des Portals (GraphQL
-- vehiclesTableVehicles, E&E Taxi KG; EH hat dort keine Fahrzeuge mehr), geholt mit
-- scripts/uber-fahrzeugbilder.js. Die 32 Bilddateien liegen in img/fahrzeuge/.
-- uber_fahrzeuge haelt die Zuordnung Kennzeichen -> Bild samt Marke/Modell/Baujahr/Farbe.
-- fahrer_app_profil() liefert zusaetzlich fahrzeug_bild (Dateiname) fuer die Fahrerapp.
--
-- Rollback: drop table uber_fahrzeuge; fahrer_app_profil aus 2026-09-27-fahrerapp-fahrzeug.sql.
-- ============================================================================

create table if not exists public.uber_fahrzeuge (
  kennzeichen_key  text primary key,
  kennzeichen      text not null,
  marke            text,
  modell           text,
  baujahr          integer,
  farbe            text,
  bild             text,
  status           text,
  vehicle_uuid     text,
  org_id           text,
  aktualisiert_am  timestamptz not null default now()
);
alter table public.uber_fahrzeuge enable row level security;
revoke all on public.uber_fahrzeuge from anon;
drop policy if exists app_users_read on public.uber_fahrzeuge;
create policy app_users_read on public.uber_fahrzeuge for select to authenticated using (public.is_app_user());
grant select on public.uber_fahrzeuge to authenticated;

insert into public.uber_fahrzeuge (kennzeichen_key, kennzeichen, marke, modell, baujahr, farbe, bild, status, vehicle_uuid, org_id)
select public.kennzeichen_key(d.kz), d.kz, d.marke, d.modell, d.baujahr, d.farbe, d.bild, d.status, d.uuid, 'c566f3b3-772f-4b28-b644-877451d2d173'
from (values
('SW-41ETX','Hyundai','Ioniq',2019,'Weiß','hyundai-ioniq-25ea3466.png','ACTIVE','46ced3d1-9174-48a7-ab98-073e4fb303db'),
('SW-447TX','Toyota','Corolla',2020,'Weiß','toyota-corolla-d62ca998.png','ACTIVE','6f18ae73-97e7-4207-a97f-5f7c8df1c8b4'),
('SW-451TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','1e5ab2b9-56e2-4362-899e-11092629293b'),
('SW-479TX','Toyota','Auris Touring Sports',2018,'Weiß','toyota-auris-hybrid-touring-sports-8fb84e1a.png','ACTIVE','d6742adb-6134-4e56-80aa-26ce6e7cfa80'),
('SW-513TX','Volkswagen','Touran',2016,'Grau','volkswagen-touran-0187f5f0.png','ACTIVE','0bce9c9c-a358-493c-b5ba-1d8865bb468c'),
('SW-570TX','Toyota','Auris Touring Sports',2018,'Grau','toyota-auris-hybrid-touring-sports-46b412bf.png','ACTIVE','f61241c7-b42b-459b-8853-4dde4ec69dd5'),
('SW-584TX','Hyundai','Ioniq',2019,'Weiß','hyundai-ioniq-25ea3466.png','ACTIVE','785b4c43-398d-498c-bc07-56b275338cfe'),
('SW-68DTX','Toyota','Corolla',2022,'Grau','toyota-corolla-77f1cdf9.png','ACTIVE','a2a4de5f-58dc-4645-a763-4a6fa521da75'),
('SW-869TX','Audi','A4 Limousine',2016,'Schwarz',null,'ACTIVE','443d4eed-9033-412b-81f5-aa108dff3acf'),
('SW-882TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','12a05efc-43ab-4795-8b70-b42182b14bc4'),
('SW-88FTX','Audi','A4 Limousine',2016,'Schwarz',null,'ACTIVE','128b35a7-d553-42d3-8c6e-efcfcf3ea263'),
('W-1061TX','Toyota','Corolla',2022,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','dd46d7aa-a977-46fa-a36c-e219a940c62c'),
('W-107CTX','Audi','A6 Avant',2020,'Blau',null,'ACTIVE','149d14d9-5fd1-491c-933f-905b61ab02f5'),
('W-1174TX','Toyota','Prius+',2024,'Schwarz','toyota-prius-2a5f278a.png','ACTIVE','31a16471-91c8-4405-a3a7-65d3e7e98ce1'),
('W-1553TX','Toyota','Prius+',2016,'Grau','toyota-prius-edc2afe6.png','ACTIVE','d39cd2e9-013f-48cb-87b1-c9bf88230e92'),
('W-1559TX','Toyota','Prius+',2012,'Grau','toyota-prius-3c73a4d6.png','ACTIVE','ffa30c67-3e59-45b4-b2c2-4185517e8a68'),
('W-1634TX','Toyota','Prius+',2019,'Weiß','toyota-prius-05f4f085.png','ACTIVE','8d1c0dc4-8fc6-42e8-827e-651f0ffa5a16'),
('W-204TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','4745fdf2-68f1-4313-85cc-de624bf6875d'),
('W-2408TX','Toyota','Prius+',2018,'Grau','toyota-prius-edc2afe6.png','ACTIVE','00140631-9a5d-4a7b-a840-c2401afec322'),
('W-3513TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','799b7237-49b7-4308-9ad6-963c207374b1'),
('W-396ATX','Toyota','Corolla Touring Sports Hybrid',2021,'Grau','toyota-corolla-touring-sports-hybrid-eb5d1f47.png','ACTIVE','b446764b-58ae-4407-b782-33eb0a375b5e'),
('W-4084TX','Toyota','Prius+',2024,'Weiß','toyota-prius-05f4f085.png','ACTIVE','b5099e6c-2ba0-484a-b5ae-8266f733468e'),
('W-4097TX','Toyota','Corolla Touring Sports Hybrid',2021,'Schwarz','toyota-corolla-touring-sports-hybrid-38763bba.png','ACTIVE','fc260cd6-6a64-4083-9870-24f5ae9390e3'),
('W-4115TX','Toyota','RAV4 Hybrid',2021,'Grau','toyota-rav4-5745b25b.png','ACTIVE','d4755d90-d116-4671-979c-1131155a587f'),
('W-4123TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','7d6d4e5f-629e-4064-b225-0165028548a5'),
('W-4154TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','62cd02c4-699f-427d-9358-f852a02fd311'),
('W-4155TX','Toyota','Corolla',2020,'Weiß','toyota-corolla-d62ca998.png','ACTIVE','78242420-dcf4-4eac-80cd-76bce6b87ae2'),
('W-4160TX','Toyota','RAV4',2019,'Grau','toyota-rav4-5745b25b.png','ACTIVE','20c4f55c-acd7-4107-87cb-9bd94be90385'),
('W-4175TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','ef24bc32-e205-4b61-b73c-0e5a022dc326'),
('W-4177TX','Toyota','C-HR Hybrid',2017,'Schwarz','toyota-c-hr-hybrid-e9f675c3.png','ACTIVE','77e05765-449c-4482-a912-657bbaa2753b'),
('W-4181TX','Toyota','Corolla Hybrid',2020,'Grau','toyota-corolla-hybrid-ba09e2f8.png','ACTIVE','355fd169-49c3-4a37-ac48-07cf9d6e54d0'),
('W-4193TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','21983c56-4967-4971-ba5f-697fde29f386'),
('W-4233TX','Toyota','Prius+',2017,'Schwarz','toyota-prius-2a5f278a.png','ACTIVE','bc01f48c-2435-4b77-acb1-dc11cf53e842'),
('W-4262TX','Toyota','RAV4',2019,'Weiß','toyota-rav4-d6a3c95b.png','ACTIVE','a422588e-2c73-46d8-8864-3e0dcb68a3d6'),
('W-4267TX','Toyota','Corolla Touring Sports Hybrid',2022,'Schwarz','toyota-corolla-touring-sports-hybrid-38763bba.png','ACTIVE','5009d84f-891f-421c-8f84-0fee1b16ae40'),
('W-4273TX','Toyota','RAV4',2019,'Schwarz','toyota-rav4-df11c868.png','ACTIVE','248a75e1-47a8-42a5-9e23-9667beada727'),
('W-4298TX','Toyota','RAV4',2023,'Weiß','toyota-rav4-d6a3c95b.png','ACTIVE','48c81539-e485-405a-8054-bcdc3a149fed'),
('W-4357TX','Toyota','Corolla Hybrid',2020,'Weiß','toyota-corolla-hybrid-d62ca998.png','ACTIVE','15df5577-085d-4f3c-a608-024415833be4'),
('W-4460TX','Toyota','Corolla Touring Sports Hybrid',2019,'Grau','toyota-corolla-touring-sports-hybrid-eb5d1f47.png','ACTIVE','7398ba07-da7e-4174-935a-4409b809f818'),
('W-4463TX','Volkswagen','Touran',2017,'Gelb','volkswagen-touran-b8f158a4.png','ACTIVE','1578c892-703a-4ddb-a297-3f5794b9b088'),
('W-457ATX','Mercedes-Benz','E 220',2015,'Blau','mercedes-benz-e-220-2b91df9c.png','ACTIVE','dcfe253e-9cbf-4cd0-908a-0a15ac2175b1'),
('W-4923TX','Toyota','Prius+',2015,'Weiß','toyota-prius-05f4f085.png','ACTIVE','7add192e-7e70-426f-8981-6a39ee5d03d7'),
('W-5387TX','Toyota','Auris Touring Sports',2018,'Weiß','toyota-auris-hybrid-touring-sports-8fb84e1a.png','ACTIVE','02aead8a-ff3d-4dd2-bd37-22ac9cac7584'),
('W-5416TX','Toyota','RAV4',2018,'Weiß','toyota-rav4-af104fd6.png','ACTIVE','2033cc41-4785-42ba-b200-aad79975b94a'),
('W-5417TX','Toyota','Corolla',2022,'Schwarz','toyota-corolla-d627dd56.png','ACTIVE','26e2c454-14de-49e5-a99c-c778720c9c23'),
('W-5423TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','8abe8a59-aef4-4879-a44b-4f2a5aa0d997'),
('W-5442TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','9b607fd9-b026-40ae-bcae-e443ce3588c4'),
('W-5530TX','Mercedes-Benz','E 200',2017,'Schwarz','mercedes-benz-e-200-edb3f978.png','ACTIVE','5d4daba6-d718-46f0-8c0f-b28f43e04019'),
('W-5535TX','Toyota','RAV4',2019,'Schwarz','toyota-rav4-df11c868.png','ACTIVE','6706eb96-dff8-4932-9f8f-c4cf7ed6f181'),
('W-5546TX','Toyota','Corolla',2022,'Grau','toyota-corolla-77f1cdf9.png','ACTIVE','ffc64b7e-65cd-47ff-acd2-76c31b3d0276'),
('W-5549TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','9a748221-6c39-48ce-a128-9505a7d1246e'),
('W-5553TX','Ford','Mondeo Hybrid',2017,'Schwarz','ford-mondeo-hybrid-282d377e.png','ACTIVE','5581ffcb-ec77-49f6-b2ff-23fc4b5b4712'),
('W-5564TX','Toyota','Corolla Touring Sports Hybrid',2020,'Weiß','toyota-corolla-touring-sports-hybrid-8da04d1d.png','ACTIVE','4fdec7ab-e0c7-495c-8267-aa6f3e4294ca'),
('W-5579TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','198362c6-8cf5-4d88-a0e0-68c2ee8cdff5'),
('W-5584TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','b285dccd-6c17-4f60-b41a-ea98037d567b'),
('W-5586TX','Toyota','Corolla',2023,'Grau','toyota-corolla-77f1cdf9.png','ACTIVE','3bd46119-1a5b-4ac3-a0b1-4f400b821034'),
('W-5587TX','Toyota','Corolla',2022,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','d8e5f1b1-f14a-47cd-ba47-64f0b343d012'),
('W-5625TX','Toyota','Prius+',2017,'Weiß','toyota-prius-05f4f085.png','ACTIVE','1ed8d27d-c9e7-4672-9a2d-19b258504147'),
('W-5648TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','91f3c97d-e41c-45f2-ad81-83a474912afb'),
('W-570CTX','Toyota','Corolla Touring Sports Hybrid',2019,'Weiß','toyota-corolla-touring-sports-hybrid-8da04d1d.png','ACTIVE','cea9bd42-4f89-47a9-b693-44b7b17d2642'),
('W-579CTX','Toyota','RAV4',2021,'Weiß','toyota-rav4-d6a3c95b.png','ACTIVE','44426071-ce0f-464b-baf1-5bafb41c42cd'),
('W-5801TX','Toyota','Corolla',2020,'Weiß','toyota-corolla-d62ca998.png','ACTIVE','f28beca2-c7bf-470d-9c4e-2d7637b0da7e'),
('W-580CTX','Toyota','Prius+',2020,'Grau','toyota-prius-edc2afe6.png','ACTIVE','d623a839-f56f-416a-9178-a50854290d36'),
('W-593CTX','Toyota','Corolla',2022,'Grau','toyota-corolla-77f1cdf9.png','ACTIVE','eeec7f04-5159-490d-9e34-cf1017084ee6'),
('W-597CTX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','7e0cd5d2-6c98-4bc2-b5bf-4aece3fcfef9'),
('W-6018TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','6c080cfd-08b6-4ee5-84c6-966fcb14d607'),
('W-6020TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','7eac2dff-9149-419a-ba1b-ccaf74e188cd'),
('W-6021TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','cb8df33d-31c7-43db-869a-98b3dc39a732'),
('W-6385TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','5eaba52f-e777-46a4-a00c-448db74c74e0'),
('W-7191TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','9d7ab166-c725-43f1-a9ed-f95b7741a4e9'),
('W-7195TX','Suzuki','Swace Hybrid',2021,'Blau','suzuki-swace-hybrid-0b98d50c.png','ACTIVE','61576522-2da8-4f91-b714-b6f707132971'),
('W-7208TX','Toyota','Corolla',2019,'Weiß','toyota-corolla-0161aa3d.png','ACTIVE','77d4c45b-07f9-48a6-8205-080838a82a7f'),
('W-7213TX','Toyota','Corolla',2021,'Schwarz','toyota-corolla-d7253769.png','ACTIVE','263d249f-34a7-4835-a8a1-dec87b1cb63c'),
('W-7226TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','ce8750e7-2491-4af0-a7bf-a71f3d8ff732'),
('W-7235TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','9f450b6f-2dd8-4293-b4ed-88fee56fb505'),
('W-7236TX','Toyota','Corolla Touring Sports Hybrid',2021,'Weiß','toyota-corolla-touring-sports-hybrid-8da04d1d.png','ACTIVE','43ea7d78-45b6-41e6-b192-aef1fa8befd4'),
('W-7244TX','Toyota','Corolla Touring Sports Hybrid',2021,'Weiß','toyota-corolla-touring-sports-hybrid-8da04d1d.png','ACTIVE','a77adbb1-55b1-4439-8e5f-97ad119f8492'),
('W-7257TX','Toyota','Corolla',2023,'Grau','toyota-corolla-77f1cdf9.png','ACTIVE','aac7e768-978a-4b5d-99cc-b732d63c6477'),
('W-7272TX','Toyota','Corolla',2022,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','ef88b88a-28e8-45b6-b747-e9c11671274b'),
('W-7275TX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','29cc6b3a-b491-417a-ae69-7ce53f721e2e'),
('W-7285TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','131122c9-3df8-4732-8aa2-bb75b2b3e085'),
('W-7298TX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','f6af0389-dca8-4e52-bc58-5d543924c5c9'),
('W-755TX','Toyota','Corolla',2024,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','09ef3363-c23f-4f7d-922b-9e5ea70791d5'),
('W-7779TX','Toyota','Corolla',2020,'Weiß','toyota-corolla-d62ca998.png','ACTIVE','a088530c-f692-4b48-a0e6-87165f9f40f5'),
('W-7780TX','Toyota','Corolla',2020,'Weiß','toyota-corolla-d62ca998.png','ACTIVE','26d46c6a-d05d-4d1f-aaed-5b4e4a79520b'),
('W-8276TX','Toyota','Prius+',2020,'Weiß','toyota-prius-05f4f085.png','ACTIVE','ad7c8193-55fd-4097-88c1-1c5e8ca91ce0'),
('W-837CTX','Toyota','Camry',2021,'Grau','toyota-camry-18e609e5.png','ACTIVE','69f2e2db-5be8-42a9-929a-589c18a78dc8'),
('W-8757TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','b5934c4d-ab94-4e1c-81ca-b63500ecdd64'),
('W-8758TX','Toyota','Corolla',2020,'Schwarz','toyota-corolla-d7253769.png','ACTIVE','e7269142-59e2-4d04-bae8-a1feee3a8a6e'),
('W-8759TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','a5768001-8b07-46a8-89c2-81b4b94de108'),
('W-888BTX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','eb968d4f-c4b3-40a7-8a51-74c13d656446'),
('W-9139TX','Toyota','RAV4',2020,'Schwarz','toyota-rav4-df11c868.png','ACTIVE','c3715be4-cbf4-42cc-b8a2-3db2eadfa7aa'),
('W-927BTX','Toyota','Corolla',2022,'Schwarz','toyota-corolla-d627dd56.png','ACTIVE','c8fcd6f1-66e5-439c-9e12-c4b7f225f3f8'),
('W-932BTX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','f77e39e6-7fa1-4bdd-ba9b-7e911cb30a32'),
('W-937BTX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','204e6e1c-8474-47a4-b9b8-06182599272f'),
('W-938BTX','Toyota','Prius+',2018,'Weiß','toyota-prius-05f4f085.png','ACTIVE','143d011e-a247-4e74-b661-1257c2f1310e'),
('W-946BTX','Toyota','Prius+',2024,'Weiß','toyota-prius-05f4f085.png','ACTIVE','5f7ef16f-2ec9-41d8-ba48-0b670317c122'),
('W-955BTX','Toyota','Auris Touring Sports',2018,'Weiß','toyota-auris-hybrid-touring-sports-8fb84e1a.png','ACTIVE','7f7017c5-d7c9-417a-b2b7-8ce533b340dd'),
('W-961BTX','Mercedes-Benz','Vito Tourer',2018,'Schwarz','mercedes-benz-vito-tourer-2bce4926.png','ACTIVE','e7071144-3703-4be3-a9b8-617b81022736'),
('W-972BTX','Toyota','Corolla Touring Sports Hybrid',2020,'Weiß','toyota-corolla-touring-sports-hybrid-8da04d1d.png','ACTIVE','8ddf3f40-b9a3-4ae2-a92b-3d7e2fc0ce2e'),
('W-973BTX','Toyota','Corolla',2022,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','7fa80abd-49c7-4229-b1e6-84eff0e9a6ae'),
('W-977ATX','Toyota','Corolla',2023,'Weiß','toyota-corolla-965fac6e.png','ACTIVE','57800c31-ce85-4471-bace-6adaca5b10d8'),
('W-9911TX','Toyota','Prius+',2021,'Weiß','toyota-prius-05f4f085.png','ACTIVE','c850ced0-b0df-479e-996c-53c8c7518bdd'),
('W844ATX','Hyundai','Tucson',2024,'Weiß','hyundai-tucson-0c9fa552.png','ACTIVE','0c343d16-76c5-4a37-b8ea-5fefbbf30948')
) as d(kz, marke, modell, baujahr, farbe, bild, status, uuid)
where d.kz is not null
on conflict (kennzeichen_key) do update set kennzeichen = excluded.kennzeichen, marke = excluded.marke, modell = excluded.modell,
  baujahr = excluded.baujahr, farbe = excluded.farbe, bild = excluded.bild, status = excluded.status,
  vehicle_uuid = excluded.vehicle_uuid, org_id = excluded.org_id, aktualisiert_am = now();

drop function if exists public.fahrer_app_profil(integer);

create function public.fahrer_app_profil(p_fahrer_id integer default null)
 returns table(fahrer_id integer, fahrer_nr integer, name text, kennzeichen text, mietmodell text,
               fahrzeug_modell text, vorschau boolean, nr_eindeutig boolean, app_zugang text,
               fahrzeug_vin text, fahrzeug_bild text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select f.id, f.notion_fahrer_id, f.name, f.kennzeichen, f.mietmodell,
         fp.modell,
         (p_fahrer_id is not null and public.is_app_user()),
         (f.notion_fahrer_id is not null
          and (select count(*) from public.fahrer x where x.aktiv and x.notion_fahrer_id = f.notion_fahrer_id) = 1),
         case when z.notion_fahrer_id is null then 'kein_zugang'
              when z.gesperrt then 'gesperrt' else 'aktiv' end,
         nullif(trim(fp.vin), ''),
         ub.bild
  from public.fahrer f
  left join public.fuhrpark fp
    on fp.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen,'') <> ''
  left join public.uber_fahrzeuge ub
    on ub.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen,'') <> ''
  left join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id)
$function$;

revoke all on function public.fahrer_app_profil(integer) from public, anon;
grant execute on function public.fahrer_app_profil(integer) to authenticated, service_role;
