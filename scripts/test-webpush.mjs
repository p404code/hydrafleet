// node --test scripts/test-webpush.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { verschluesseln, vapidKopf, vonB64u, b64u } from '../supabase/functions/_shared/webpush.ts';

const te = new TextEncoder();

test('aes128gcm: genau das Beispiel aus RFC 8291 (Abschnitt 5 / Anhang A)', async () => {
  const abo = { endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const out = await verschluesseln(abo, te.encode('When I grow up, I want to be a watermelon'), {
    salt: vonB64u('DGv6ra1nlYgDCS1FRnbzlw'),
    asPublic: vonB64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    asPrivate: vonB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('aes128gcm: mit Zufallsschluesseln, unabhaengig mit node:crypto entschluesselt', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  const abo = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const nutzlast = JSON.stringify({ title: 'HYDRAlink', body: 'Boyko: Fahr zur Werkstatt – äöü 🚕' });
  const body = Buffer.from(await verschluesseln(abo, te.encode(nutzlast)));
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const ecdh = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const chiffre = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(chiffre.subarray(-16));
  const klar = Buffer.concat([d.update(chiffre.subarray(0, -16)), d.final()]);
  assert.equal(klar[klar.length - 1], 2, 'Trenner 0x02 am Ende');
  assert.equal(klar.subarray(0, -1).toString('utf8'), nutzlast);
});

test('VAPID: JWT fuer den Push-Dienst, mit dem oeffentlichen Schluessel pruefbar', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  const kopf = await vapidKopf('https://fcm.googleapis.com/fcm/send/abc', { publicKey: pub, privateKey: j.d, subject: 'mailto:sw.hydrafleet@gmail.com' }, 1000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(kopf);
  assert.ok(m, kopf);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(m[2], 'base64url')), { aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:sw.hydrafleet@gmail.com' });
  assert.equal(m[4], pub);
  assert.ok(verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});
