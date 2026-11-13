// client/audio-crypto.js
var encoder = new TextEncoder();
var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var AUDIO_PROFILE = "wss-opus-v1";
var AUDIO_URL = "wss://vellivex-audio.vellivex-call.workers.dev/connect";
var encode = (b) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
var invalid = () => new Error("The private audio connection could not be verified.");
function decode(s) {
  if (typeof s !== "string" || s.length > 6e4 || !/^[A-Za-z0-9_-]+$/.test(s)) throw invalid();
  const b = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (encode(b) !== s) throw invalid();
  return b;
}
function valid(i) {
  if (!i || !ID.test(i.id) || decode(i.joinToken).length !== 32 || decode(i.secretKey).length !== 32) throw invalid();
  return i;
}
function audioInvitation() {
  return Object.freeze({ id: crypto.randomUUID(), joinToken: encode(crypto.getRandomValues(new Uint8Array(32))), secretKey: encode(crypto.getRandomValues(new Uint8Array(32))) });
}
function audioLink(i, origin = location.origin) {
  valid(i);
  const u = new URL("/call.html", origin);
  u.hash = new URLSearchParams({ v: "2", r: i.id, j: i.joinToken, k: i.secretKey }).toString();
  return u.href;
}
function parseAudioLink(value, origin = location.origin) {
  if (typeof value !== "string" || value.length > 1024 || /[^\\x21-\\x7e]/.test(value)) throw invalid();
  const u = new URL(value.startsWith("#") ? "/call.html" + value : value, origin), p = new URLSearchParams(u.hash.slice(1));
  if (u.origin !== new URL(origin).origin || u.pathname !== "/call.html" || u.username || u.password || u.search || p.size !== 4 || p.get("v") !== "2" || !["v", "r", "j", "k"].every((k) => p.getAll(k).length === 1)) throw invalid();
  return Object.freeze(valid({ id: p.get("r"), joinToken: p.get("j"), secretKey: p.get("k") }));
}
async function audioJoinDigest(token) {
  if (decode(token).length !== 32) throw invalid();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode("vellivex-audio-room-join-v1\\n" + token))), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function audioFingerprint(i) {
  valid(i);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode("vellivex-audio-key-v1\\n" + i.id + "\\n" + i.secretKey)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
var aad = (id, role, sequence) => encoder.encode("vellivex-audio-v1\\n" + id + "\\n" + AUDIO_PROFILE + "\\n" + role + "\\n" + sequence);
async function audioEnvelope(i, role, cipher = null) {
  valid(i);
  if (!["caller", "receiver"].includes(role)) throw invalid();
  const key = await crypto.subtle.importKey("raw", decode(i.secretKey), "AES-GCM", false, [cipher === null ? "encrypt" : "decrypt"]);
  const hello = encoder.encode(AUDIO_PROFILE + "\\n" + role);
  if (cipher === null) {
    const iv = crypto.getRandomValues(new Uint8Array(12)), data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(i.id, role, "envelope") }, key, hello));
    const bytes2 = new Uint8Array(12 + data.length);
    bytes2.set(iv);
    bytes2.set(data, 12);
    return "VSE1." + encode(bytes2);
  }
  if (typeof cipher !== "string" || !cipher.startsWith("VSE1.") || cipher.length > 200) throw invalid();
  const bytes = decode(cipher.slice(5));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(i.id, role, "envelope") }, key, bytes.slice(12));
  if (new TextDecoder("utf-8", { fatal: true }).decode(plain) !== new TextDecoder().decode(hello)) throw invalid();
  return true;
}
var AudioCipher = class _AudioCipher {
  static async create(i, role) {
    valid(i);
    if (!["caller", "receiver"].includes(role)) throw invalid();
    const root = await crypto.subtle.importKey("raw", decode(i.secretKey), "HKDF", false, ["deriveKey"]);
    const derive = (r) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(i.id), info: encoder.encode("vellivex-audio-direction-v1\\n" + r) }, root, { name: "AES-GCM", length: 256 }, false, [r === role ? "encrypt" : "decrypt"]);
    const c = new _AudioCipher();
    c.id = i.id;
    c.role = role;
    c.other = role === "caller" ? "receiver" : "caller";
    c.sendKey = await derive(role);
    c.receiveKey = await derive(c.other);
    c.sent = 0;
    c.received = 0;
    return c;
  }
  async seal(type, payload = new Uint8Array()) {
    if (!this.sendKey || ![1, 2, 3, 4, 5, 6].includes(type) || !(payload instanceof Uint8Array) || payload.length > 1500 || this.sent >= 18e3) throw invalid();
    const sequence = ++this.sent, plain = new Uint8Array(1 + payload.length);
    plain[0] = type;
    plain.set(payload, 1);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(this.id, this.role, sequence) }, this.sendKey, plain));
    const result = new Uint8Array(17 + encrypted.length);
    result[0] = 1;
    new DataView(result.buffer).setUint32(1, sequence);
    result.set(iv, 5);
    result.set(encrypted, 17);
    return result.buffer;
  }
  async open(packet) {
    if (!this.receiveKey || !(packet instanceof ArrayBuffer) || packet.byteLength < 34 || packet.byteLength > 1600) throw invalid();
    const bytes = new Uint8Array(packet), sequence = new DataView(packet).getUint32(1);
    if (bytes[0] !== 1 || sequence !== this.received + 1 || sequence > 18e3) throw invalid();
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(5, 17), additionalData: aad(this.id, this.other, sequence) }, this.receiveKey, bytes.slice(17)));
    if (![1, 2, 3, 4, 5, 6].includes(plain[0])) throw invalid();
    this.received = sequence;
    return { type: plain[0], payload: plain.slice(1) };
  }
  clear() {
    this.sendKey = this.receiveKey = null;
  }
};
