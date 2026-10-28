// Browser-Test (ueber test-fahrer-nachrichten.sh): neue Buero-Nachricht ausserhalb des Chats → Banner oben, Zaehler am Reiter,
// Zahl am App-Symbol; Antippen oeffnet den Chat; im Chat und in der Buero-Vorschau kein Banner.
(async function () {
  const ergebnis = {};
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const symbol = [];
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async (n) => { symbol.push(n); } });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => { symbol.push(0); } });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }),
    getRegistration: async () => null, addEventListener() {}, register: async () => ({}) } });
  let server = [];
  sb.rpc = function (name) {
    if (name === 'fahrer_app_nachrichten') return Promise.resolve({ data: server.map((m) => ({ ...m })), error: null });
    if (name === 'fahrer_app_nachrichten_gelesen') { server.forEach((m) => { m.gelesen_am = m.gelesen_am || 'x'; }); return Promise.resolve({ data: null, error: null }); }
    return Promise.resolve({ data: [], error: null });
  };
  const t = () => new Date().toISOString();
  const banner = () => document.getElementById('naHinweis');
  const sichtbar = () => !banner().hidden;
  const tabZahl = () => { const b = document.getElementById('naBadge'); return b.hidden ? 0 : Number(b.textContent); };

  S.mode = 'fahrer';
  S.profil = { fahrer_id: 1, fahrer_nr: 101, name: 'Anna Fahr', kennzeichen: 'W-1111TX' };
  show('shell'); location.hash = '#start'; await warte(50); render();

  // 1) App-Start ohne Ungelesenes: kein Banner
  server = [{ id: 1, richtung: 'team', text: 'alt', erstellt_am: t(), gelesen_am: t() }];
  await ladenNachrichten();
  ergebnis.start_ruhig = !sichtbar() && tabZahl() === 0;

  // 2) neue Nachricht auf "Start": Banner mit Text, Zaehler 1, App-Symbol 1
  server.push({ id: 2, richtung: 'team', text: 'Bitte morgen um 8 ins Büro', erstellt_am: t(), gelesen_am: null });
  await ladenNachrichten();
  ergebnis.banner_da = sichtbar() && /Büro/.test(banner().textContent) && /morgen um 8/.test(banner().textContent);
  ergebnis.tab_zaehler = tabZahl() === 1;
  ergebnis.app_symbol = symbol[symbol.length - 1] === 1;

  // 3) dieselbe Nachricht beim naechsten Laden: kein zweites Banner (nach ✖)
  banner().querySelector('[data-act="hinweis-zu"]').click();
  ergebnis.x_schliesst = !sichtbar() && location.hash === '#start';
  await ladenNachrichten();
  ergebnis.nicht_doppelt = !sichtbar();

  // 4) zwei neue, eine davon ein Foto: Sammeltext
  server.push({ id: 3, richtung: 'team', text: '', anhang: 'foto', erstellt_am: t(), gelesen_am: null },
              { id: 4, richtung: 'team', text: 'noch was', erstellt_am: t(), gelesen_am: null });
  await ladenNachrichten();
  ergebnis.sammeltext = sichtbar() && /2 neue Nachrichten vom Büro/.test(banner().textContent);
  ergebnis.tab_zaehler_3 = tabZahl() === 3;

  // 5) Antippen: Chat offen, Banner weg, alles gelesen, Symbol 0
  banner().click(); await warte(150);
  ergebnis.tippen_oeffnet_chat = location.hash === '#nachrichten' && !sichtbar();
  ergebnis.gelesen_symbol_0 = tabZahl() === 0 && symbol[symbol.length - 1] === 0;

  // 6) einzelnes Foto: "📷 Foto"; im Chat kein Banner
  location.hash = '#start'; await warte(50);
  server.push({ id: 5, richtung: 'team', text: '', anhang: 'foto', erstellt_am: t(), gelesen_am: null });
  await ladenNachrichten();
  ergebnis.foto_text = sichtbar() && /📷 Foto/.test(banner().textContent);
  location.hash = '#nachrichten'; await warte(150);
  server.push({ id: 6, richtung: 'team', text: 'im Chat', erstellt_am: t(), gelesen_am: null });
  await ladenNachrichten();
  ergebnis.im_chat_kein_banner = !sichtbar();

  // 7) Banner geht nach ~8 Sekunden von selbst
  location.hash = '#start'; await warte(50);
  server.push({ id: 7, richtung: 'team', text: 'kurz', erstellt_am: t(), gelesen_am: null });
  await ladenNachrichten();
  const war = sichtbar();
  await warte(8300);
  ergebnis.verschwindet_selbst = war && !sichtbar();

  // 8) Service Worker meldet neue Nachricht: App laedt sofort
  server.push({ id: 8, richtung: 'team', text: 'vom Push', erstellt_am: t(), gelesen_am: null });
  swNachricht({ data: { typ: 'neu' } }); await warte(100);
  ergebnis.push_laedt = sichtbar() && /vom Push/.test(banner().textContent);

  // 9) Abmelden: Banner weg, Symbol 0
  showLogin();
  ergebnis.abmelden_aufgeraeumt = !sichtbar() && symbol[symbol.length - 1] === 0;

  // 10) Buero-Vorschau: kein Banner, App-Symbol unberuehrt
  const vorher = symbol.length;
  S.mode = 'vorschau'; S.vorschauId = 1;
  S.profil = { fahrer_id: 1, fahrer_nr: 101, name: 'Anna Fahr', kennzeichen: 'W-1111TX' };
  show('shell'); location.hash = '#start'; await warte(50); render();
  server = [{ id: 9, richtung: 'team', text: 'ungelesen', erstellt_am: t(), gelesen_am: null }];
  await ladenNachrichten();
  ergebnis.vorschau_ruhig = !sichtbar() && symbol.length === vorher;

  ergebnis.alle = Object.values(ergebnis).every(Boolean);
  return JSON.stringify(ergebnis);
})()
