// Web-Push ohne Bibliothek: Verschluesselung aes128gcm (RFC 8291 / RFC 8188) und VAPID (RFC 8292), nur WebCrypto.
// Laeuft unter Deno (Edge Function push-senden) und Node (Tests: node --test scripts/test-webpush.mjs).

export type Abo = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string }; // base64url: 65-Byte-Punkt / 32-Byte d
// Nur fuer den Test mit festen Werten (RFC 8291 Anhang A); im Betrieb zufaellig
export type Fest = { salt: Uint8Array; asPublic: Uint8Array; asPrivate: Uint8Array };
const te = new TextEncoder();
export function b64u(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function vonB64u(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const r = atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="));
  return Uint8Array.from(r, (c) => c.charCodeAt(0));
}
function verbinde(...teile: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(teile.reduce((n, t) => n + t.length, 0));
  let i = 0; for (const t of teile) { out.set(t, i); i += t.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, laenge: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, laenge * 8));
}
function privatKey(d: Uint8Array, pub: Uint8Array, art: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: art, namedCurve: "P-256" }, false, art === "ECDH" ? ["deriveBits"] : ["sign"]);
}
export async function verschluesseln(abo: Abo, klartext: Uint8Array, fest?: Fest): Promise<Uint8Array> {
  const uaPublic = vonB64u(abo.p256dh), authSecret = vonB64u(abo.auth);
  let asPublic: Uint8Array, asKey: CryptoKey;
  if (fest) { asPublic = fest.asPublic; asKey = await privatKey(fest.asPrivate, fest.asPublic, "ECDH"); }
  else {
    const paar = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", paar.publicKey)); asKey = paar.privateKey;
  }
  const salt = fest ? fest.salt : crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKey, 256));
  const ikm = await hkdf(authSecret, ecdh, verbinde(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, verbinde(klartext, new Uint8Array([2]))));
  const kopf = new Uint8Array(86);
  kopf.set(salt, 0); new DataView(kopf.buffer).setUint32(16, 4096); kopf[20] = 65; kopf.set(asPublic, 21);
  return verbinde(kopf, chiffre);
}
export async function vapidKopf(endpoint: string, v: Vapid, jetzt = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const kopf = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const nutz = b64u(te.encode(JSON.stringify({ aud, exp: jetzt + 12 * 3600, sub: v.subject })));
  const key = await privatKey(vonB64u(v.privateKey), vonB64u(v.publicKey), "ECDSA");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${kopf}.${nutz}`)));
  return `vapid t=${kopf}.${nutz}.${b64u(sig)}, k=${v.publicKey}`;
}

// Eine Nachricht an ein Abo schicken. Rueckgabe: HTTP-Status des Push-Dienstes (404/410 = Abo tot).
export async function pushSenden(abo: Abo, nutzlast: string, v: Vapid, ttl = 86400): Promise<number> {
  const body = await verschluesseln(abo, te.encode(nutzlast));
  const r = await fetch(abo.endpoint, {
    method: "POST", body,
    headers: { Authorization: await vapidKopf(abo.endpoint, v), "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high" } });
  await r.body?.cancel();
  return r.status;
}
