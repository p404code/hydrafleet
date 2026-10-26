(async function () {
  // Browser-Test Fotos/Sprache in der Fahrerapp – Attrappen statt Supabase, Telegram und Mikrofon (laeuft ueber scripts/shot.js)
  const ergebnis = {};
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const aufrufe = [];
  let sendenAntwort = { status: 200, body: { id: 77 } };
  const echtesFetch = window.fetch;
  // echtes 600x400-Bild: die Blase waechst beim Laden (wie in echt)
  const bc = document.createElement('canvas'); bc.width = 600; bc.height = 400; bc.getContext('2d').fillRect(0, 0, 600, 400);
  const echtesBild = await new Promise((r) => bc.toBlob(r, 'image/png'));
  window.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/functions/v1/anhang-senden')) {
      aufrufe.push({ url: u, art: init.body.get('art'), datei: init.body.get('datei'), dauer: init.body.get('dauer'), auth: (init.headers || {}).Authorization });
      return new Response(JSON.stringify(sendenAntwort.body), { status: sendenAntwort.status });
    }
    if (u.includes('/functions/v1/anhang?')) {
      aufrufe.push({ url: u, auth: (init.headers || {}).Authorization });
      if (u.includes('id=99')) return new Response('{"fehler":"nicht mehr verfügbar"}', { status: 404 });
      if (u.includes('id=12')) return new Response(new Blob([new Uint8Array([79, 103, 103, 83])], { type: 'audio/ogg' }), { status: 200, headers: { 'Content-Type': 'audio/ogg' } });
      return new Response(echtesBild, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return echtesFetch(url, init);
  };
  sb.rpc = (name) => Promise.resolve({ data: name === 'fahrer_app_nachrichten' ? S.na.rows : [], error: null });
  sb.auth.getSession = async () => ({ data: { session: { access_token: 'TOKEN-ANNA' } } });

  S.mode = 'fahrer';
  S.profil = { fahrer_id: 1, fahrer_nr: 101, name: 'Anna Fahr', kennzeichen: 'W-1111TX' };
  const jetzt = new Date().toISOString();
  S.na.rows = [{ id: 11, richtung: 'team', team_name: 'Büro', text: 'so sieht das aus', anhang: 'foto', erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true },
               { id: 12, richtung: 'team', team_name: 'Büro', text: '', anhang: 'sprache', dauer: 12, erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true },
               { id: 99, richtung: 'fahrer', text: '', anhang: 'foto', erstellt_am: jetzt, zugestellt: true }];
  S.na.loadedAt = Date.now();
  show('shell'); location.hash = '#nachrichten'; await warte(50); render(); await warte(400);

  // 1) Anzeige: Foto als Bild (aus der Function, mit Fahrer-JWT), Sprache als Abspielknopf mit Dauer, Bildunterschrift
  const blasen = [...document.querySelectorAll('#naListe .bubble')];
  const img = blasen[0].querySelector('img[data-anhang="11"]');
  ergebnis.foto_bild = !!img && img.src.startsWith('blob:');
  ergebnis.foto_mit_jwt = aufrufe.some((a) => a.url.includes('anhang?id=11') && a.auth === 'Bearer TOKEN-ANNA');
  ergebnis.foto_caption = /so sieht das aus/.test(blasen[0].textContent);
  ergebnis.ton_knopf = /0:12/.test((blasen[1].querySelector('[data-act="ton"]') || {}).textContent || '');
  ergebnis.foto_weg = /nicht mehr verfügbar/.test(blasen[2].textContent);

  // 1b) Fotos laden nach dem Runterscrollen nach: die Liste muss danach trotzdem ganz unten stehen
  S.na.rows = Array.from({ length: 15 }, (_, i) => ({ id: 200 + i, richtung: 'team', team_name: 'Büro', text: 'Zeile ' + i, erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true }))
    .concat([{ id: 13, richtung: 'team', team_name: 'Büro', text: '', anhang: 'foto', erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true }]);
  listeZeichnen(); nachUnten(); await warte(400);
  const liste = document.getElementById('naListe');
  ergebnis.unten_nach_fotos = Math.abs(liste.scrollTop + liste.clientHeight - liste.scrollHeight) <= 2;
  S.na.rows = [{ id: 11, richtung: 'team', team_name: 'Büro', text: 'so sieht das aus', anhang: 'foto', erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true },
               { id: 12, richtung: 'team', team_name: 'Büro', text: '', anhang: 'sprache', dauer: 12, erstellt_am: jetzt, gelesen_am: jetzt, zugestellt: true },
               { id: 99, richtung: 'fahrer', text: '', anhang: 'foto', erstellt_am: jetzt, zugestellt: true }];
  listeZeichnen(); await warte(100);
  const blasen2 = [...document.querySelectorAll('#naListe .bubble')];

  // 2) Foto gross und wieder zu
  blasen2[0].querySelector('[data-act="foto"]').click(); await warte(50);
  const gross = document.getElementById('naFotoGross');
  ergebnis.foto_gross = !!gross && !gross.hidden && gross.querySelector('img').src.startsWith('blob:');
  gross.click(); await warte(50);
  ergebnis.foto_gross_zu = document.getElementById('naFotoGross').hidden;

  // 3) OGG, das das Geraet nicht kann: Dekoder-Weg (Attrappe), sonst direkt
  let dekodiert = 0;
  S.oggDekoder = async () => { dekodiert++; return new Blob([new Uint8Array(44)], { type: 'audio/wav' }); };
  const kann = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = () => '';
  const q1 = await tonQuelle(new Blob([new Uint8Array(4)], { type: 'audio/ogg' }));
  HTMLMediaElement.prototype.canPlayType = () => 'probably';
  const q2 = await tonQuelle(new Blob([new Uint8Array(4)], { type: 'audio/ogg' }));
  HTMLMediaElement.prototype.canPlayType = kann;
  ergebnis.ogg_dekodiert = dekodiert === 1 && q1.type === 'audio/wav' && q2.type === 'audio/ogg';

  // 4) Foto verkleinern: laengste Seite hoechstens 1600, JPEG
  const c = document.createElement('canvas'); c.width = 3200; c.height = 2000;
  c.getContext('2d').fillRect(0, 0, 10, 10);
  const gross3200 = await new Promise((r) => c.toBlob(r, 'image/png'));
  const klein = await bildVerkleinern(new File([gross3200], 'x.png', { type: 'image/png' }));
  const bm = await createImageBitmap(klein);
  ergebnis.verkleinert = klein.type === 'image/jpeg' && Math.max(bm.width, bm.height) === 1600;

  // 5) Upload: FormData an anhang-senden mit JWT; Fehler 429 erscheint unter dem Feld
  await anhangHochladen('foto', klein);
  const up = aufrufe.find((a) => a.art === 'foto');
  ergebnis.upload = !!up && up.auth === 'Bearer TOKEN-ANNA' && up.datei instanceof Blob;
  sendenAntwort = { status: 429, body: { fehler: 'Zu viele Nachrichten – bitte kurz warten' } };
  await anhangHochladen('foto', klein);
  ergebnis.upload_fehler = /Zu viele/.test(document.getElementById('naFehler').textContent);
  sendenAntwort = { status: 200, body: { id: 78 } };

  // 6) Aufnahme: 🎤 → Leiste mit Zeit, Senden schickt Sprache mit Dauer; ✖ verwirft
  class FakeRecorder {
    constructor(stream, opt) { this.mimeType = (opt && opt.mimeType) || 'audio/mp4'; this.state = 'inactive'; }
    static isTypeSupported(t) { return t === 'audio/mp4'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(500)], { type: this.mimeType }) }); this.onstop && this.onstop(); }
  }
  window.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  document.querySelector('[data-act="mikro"]').click(); await warte(1200);
  const leiste = document.getElementById('naAufnahme');
  ergebnis.aufnahme_leiste = !leiste.hidden && /0:0[1-2]/.test(document.getElementById('naZeit').textContent);
  document.querySelector('[data-act="aufnahme-senden"]').click(); await warte(200);
  const sp = aufrufe.find((a) => a.art === 'sprache');
  ergebnis.aufnahme_gesendet = !!sp && sp.datei.type === 'audio/mp4' && Number(sp.dauer) >= 1 && document.getElementById('naAufnahme').hidden;
  const vorher = aufrufe.filter((a) => a.art === 'sprache').length;
  document.querySelector('[data-act="mikro"]').click(); await warte(300);
  document.querySelector('[data-act="aufnahme-weg"]').click(); await warte(200);
  ergebnis.aufnahme_verworfen = aufrufe.filter((a) => a.art === 'sprache').length === vorher && document.getElementById('naAufnahme').hidden;

  ergebnis.alle = Object.values(ergebnis).every(Boolean);
  return JSON.stringify(ergebnis);
})()
