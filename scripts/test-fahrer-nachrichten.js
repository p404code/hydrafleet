(async function () {
  const ergebnis = {};
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  // Attrappen: Supabase und Service Worker
  let gekuendigt = false, senden = null;
  const abo = { unsubscribe: async () => { gekuendigt = true; return true; },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }) };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    ready: Promise.resolve({ pushManager: { getSubscription: async () => abo } }),
    getRegistration: async () => ({ pushManager: { getSubscription: async () => abo } }), addEventListener() {}, register: async () => ({}) } });
  sb.rpc = function (name) {
    if (name === 'fahrer_app_nachricht_senden') return new Promise((r) => { senden = r; });
    return Promise.resolve({ data: name === 'fahrer_app_nachrichten' ? S.na.rows : [], error: null });
  };
  sb.auth.signOut = async () => ({ error: null });

  // 1) Entwurf bleibt beim Neuzeichnen
  S.mode = 'fahrer';
  S.profil = { fahrer_id: 1, fahrer_nr: 101, name: 'Anna Fahr', kennzeichen: 'W-1111TX' };
  S.na.rows = [{ id: 1, richtung: 'team', team_name: 'Boyko', text: 'Hallo Anna', erstellt_am: new Date().toISOString(), gelesen_am: null }];
  S.na.loadedAt = Date.now();
  show('shell'); location.hash = '#nachrichten'; await warte(50); render();
  document.getElementById('naText').value = 'halb getippt';
  render();
  ergebnis.entwurf_bleibt = document.getElementById('naText').value === 'halb getippt';

  // 2) Senden scheitert nach einem Neuzeichnen: Text steht im (neuen) Feld
  document.getElementById('naText').value = 'wichtige Nachricht';
  document.getElementById('naForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await warte(20);
  render();                                         // z. B. App-Fokus nach > 5 Minuten
  senden({ data: null, error: { message: 'Zu viele Nachrichten – bitte kurz warten' } });
  await warte(50);
  ergebnis.text_nach_fehler = document.getElementById('naText').value === 'wichtige Nachricht';
  ergebnis.fehler_sichtbar = /Zu viele/.test(document.getElementById('naFehler').textContent);

  // 3) Layout: Chat ist eine Flaeche in Bildschirmhoehe, nur die Liste scrollt, Feld sitzt direkt ueber der Tab-Leiste;
  //    beim Tippen verschwindet die Tab-Leiste und das Feld rutscht an den unteren Rand (ueber die Tastatur)
  const nah = (a, b) => Math.abs(a - b) <= 2;
  const form = () => document.getElementById('naForm').getBoundingClientRect();
  const leiste = document.getElementById('tabbar');
  ergebnis.liste_scrollt = getComputedStyle(document.getElementById('naListe')).overflowY === 'auto';
  ergebnis.feld_nicht_fixiert = getComputedStyle(document.getElementById('naForm')).position !== 'fixed';
  ergebnis.feld_ueber_leiste = nah(form().bottom, leiste.getBoundingClientRect().top);
  // Hinweis zu Benachrichtigungen erscheint spaeter (pushStatus ist async): die letzte Nachricht muss trotzdem sichtbar bleiben
  const liste = document.getElementById('naListe');
  S.na.rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 10, richtung: i % 2 ? 'team' : 'fahrer', team_name: 'Boyko',
    text: 'Zeile ' + i, erstellt_am: new Date().toISOString(), gelesen_am: 'x' }));
  liste.innerHTML = chatHtml(); nachUnten();
  S.push = 'aus'; pushZeichnen(); await warte(50);
  ergebnis.letzte_sichtbar_nach_hinweis = nah(liste.scrollTop + liste.clientHeight, liste.scrollHeight);
  document.getElementById('naText').focus(); await warte(400);
  ergebnis.tippen_leiste_weg = document.body.classList.contains('tippen') && getComputedStyle(leiste).display === 'none';
  ergebnis.tippen_feld_unten = nah(form().bottom, (window.visualViewport ? visualViewport.height : innerHeight));
  ergebnis.tippen_hinweis_weg = getComputedStyle(document.getElementById('naPush')).display === 'none';
  document.getElementById('naText').blur(); await warte(100);
  ergebnis.nach_tippen_leiste_da = getComputedStyle(leiste).display !== 'none' && nah(form().bottom, leiste.getBoundingClientRect().top);
  location.hash = '#start'; await warte(100);
  ergebnis.anderer_reiter_normal = !document.body.classList.contains('chat-modus') && !document.body.classList.contains('tippen');
  location.hash = '#nachrichten'; await warte(100);

  // 4) Abmelden: Push-Abo gekuendigt, Chat-Zustand des Fahrers weg
  S.aboGemeldet = true; S.push = 'an';
  await abmelden();
  await warte(50);
  ergebnis.abo_gekuendigt = gekuendigt;
  ergebnis.chat_leer = S.na.rows.length === 0 && !S.na.loadedAt;
  ergebnis.abo_neu_melden = S.aboGemeldet === false;

  ergebnis.alle = Object.values(ergebnis).every(Boolean);
  return JSON.stringify(ergebnis);
})()
