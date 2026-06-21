// NTAG 424 DNA - SDM (Secure Dynamic Messaging / SUN) verification.
// Implements AES-CMAC (RFC 4493) and the NXP AN12196 SDM MAC so a tag's
// signed URL (?uid=..&ctr=..&cmac=..) can be proven genuine and not cloned.
//
// This is the cryptographic counterpart to provisioning the tag's
// SDMFileReadKey. Until tags are provisioned with that key (and NTAG_SDM_KEY
// is set to match), the resolver treats tags as unverified plain URLs.
//
// NOTE: byte order of the read counter follows AN12196 (LSB-first in SV2).
// Verify against a real provisioned tag before trusting in production.
const crypto = require("crypto");

function xor(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }
function leftShift(buf) {
  const o = Buffer.alloc(buf.length); let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) { const b = buf[i]; o[i] = ((b << 1) & 0xff) | carry; carry = (b & 0x80) ? 1 : 0; }
  return o;
}
function aesEncryptBlock(key, block) {
  const c = crypto.createCipheriv("aes-128-ecb", key, null); c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
function generateSubkeys(key) {
  const Rb = Buffer.from("00000000000000000000000000000087", "hex");
  const L = aesEncryptBlock(key, Buffer.alloc(16));
  let K1 = leftShift(L); if (L[0] & 0x80) K1 = xor(K1, Rb);
  let K2 = leftShift(K1); if (K1[0] & 0x80) K2 = xor(K2, Rb);
  return { K1, K2 };
}
// AES-CMAC over an arbitrary-length message (RFC 4493)
function aesCmac(key, message) {
  const { K1, K2 } = generateSubkeys(key);
  if (message.length === 0) {
    let M = Buffer.alloc(16); M[0] = 0x80; M = xor(M, K2);
    return aesEncryptBlock(key, M);
  }
  const n = Math.ceil(message.length / 16);
  const lastLen = message.length - (n - 1) * 16;
  let lastBlock;
  if (lastLen === 16) { lastBlock = xor(message.slice((n - 1) * 16), K1); }
  else { const pad = Buffer.alloc(16); message.copy(pad, 0, (n - 1) * 16); pad[lastLen] = 0x80; lastBlock = xor(pad, K2); }
  let X = Buffer.alloc(16);
  for (let i = 0; i < n - 1; i++) X = aesEncryptBlock(key, xor(X, message.slice(i * 16, (i + 1) * 16)));
  return aesEncryptBlock(key, xor(X, lastBlock));
}
// SDM truncation: take the odd-indexed bytes (1,3,..,15) of the full CMAC
function sdmTruncate(mac) { const o = Buffer.alloc(8); for (let i = 0; i < 8; i++) o[i] = mac[2 * i + 1]; return o; }

// Verify a plain-mirror SDM URL (UID + read counter in clear, then CMAC).
// opts: { keyHex (32 hex chars), uidHex (14 hex chars), ctrHex, cmacHex }
function verifySdm(opts) {
  try {
    const key = Buffer.from(opts.keyHex, "hex");
    const uid = Buffer.from(String(opts.uidHex || "").replace(/[^0-9a-fA-F]/g, ""), "hex");
    if (key.length !== 16 || uid.length !== 7) return { valid: false, reason: "bad key or uid length" };
    const ctrBE = Buffer.from(String(opts.ctrHex || "").replace(/[^0-9a-fA-F]/g, "").padStart(6, "0").slice(-6), "hex"); // 3 bytes
    const ctrLsb = Buffer.from([ctrBE[2], ctrBE[1], ctrBE[0]]); // AN12196: LSB-first in SV2
    const SV2 = Buffer.concat([Buffer.from([0x3C, 0xC2, 0x01, 0x00, 0x80]), uid, ctrLsb]);
    const kses = aesCmac(key, SV2);
    const full = aesCmac(kses, Buffer.alloc(0));
    const expected = sdmTruncate(full).toString("hex").toUpperCase();
    const given = String(opts.cmacHex || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    return { valid: !!given && expected === given, expected, counter: ctrBE.readUIntBE(0, 3) };
  } catch (e) {
    return { valid: false, reason: String(e && e.message ? e.message : e) };
  }
}

module.exports = { aesCmac, verifySdm };
