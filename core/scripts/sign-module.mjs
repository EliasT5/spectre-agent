#!/usr/bin/env node
/**
 * Module manifest signing CLI — the operator side of src/lib/modules/signing.ts.
 * Dependency-free (node:crypto only).
 *
 *   node scripts/sign-module.mjs keygen [keyfile]
 *       Generate an ed25519 keypair. Writes the private key PEM to <keyfile>
 *       (default ./module-signing.key, chmod 600) and prints the base64url
 *       public key — the value you add to SPECTRE_MODULE_TRUSTED_KEYS.
 *
 *   node scripts/sign-module.mjs sign <module.json> [keyfile]
 *       Embed author.pubkey + signature into the manifest IN PLACE. The
 *       signature is ed25519 over the JCS-canonicalized manifest (keys sorted
 *       recursively, `signature` field excluded) — byte-identical to what
 *       verifyManifestSignature checks.
 *
 *   node scripts/sign-module.mjs verify <module.json>
 *       Self-verify a signed manifest (signature vs its embedded pubkey).
 *       NOTE: trust additionally requires the pubkey to be in the core's
 *       SPECTRE_MODULE_TRUSTED_KEYS keyring.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// MUST mirror src/lib/modules/signing.ts canonicalize().
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function canonicalize(manifest) {
  const { signature: _drop, ...rest } = manifest;
  return Buffer.from(JSON.stringify(sortValue(rest)), "utf8");
}

/** base64url raw 32-byte ed25519 public key out of a KeyObject. */
function rawPubkeyB64url(publicKey) {
  const spki = publicKey.export({ format: "der", type: "spki" });
  // ed25519 SPKI = 12-byte prefix + 32-byte raw key.
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
}

/** Read JSON tolerating a UTF-8 BOM (Windows editors love to add one). */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === "keygen") {
  const keyfile = arg1 ?? "module-signing.key";
  if (existsSync(keyfile)) {
    console.error(`refusing to overwrite existing ${keyfile}`);
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyfile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  console.log(`private key  -> ${keyfile}  (keep it out of git)`);
  console.log(`public key   -> ${rawPubkeyB64url(publicKey)}`);
  console.log(`\nAdd the public key to the core env to enforce signing:`);
  console.log(`  SPECTRE_MODULE_TRUSTED_KEYS=${rawPubkeyB64url(publicKey)}`);
} else if (cmd === "sign") {
  if (!arg1) {
    console.error("usage: sign-module.mjs sign <module.json> [keyfile]");
    process.exit(1);
  }
  const keyfile = arg2 ?? "module-signing.key";
  const privateKey = createPrivateKey(readFileSync(keyfile, "utf8"));
  const publicKey = createPublicKey(privateKey);
  const manifest = readJson(arg1);

  manifest.author = { ...manifest.author, pubkey: rawPubkeyB64url(publicKey) };
  delete manifest.signature; // never sign over a stale signature
  manifest.signature = sign(null, canonicalize(manifest), privateKey).toString("base64url");

  writeFileSync(arg1, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`signed ${arg1} (module "${manifest.id}") as ${manifest.author.pubkey}`);
} else if (cmd === "verify") {
  if (!arg1) {
    console.error("usage: sign-module.mjs verify <module.json>");
    process.exit(1);
  }
  const manifest = readJson(arg1);
  const pubkey = manifest.author?.pubkey;
  if (!manifest.signature || !pubkey) {
    console.error("unsigned (missing signature or author.pubkey)");
    process.exit(1);
  }
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(pubkey, "base64url")]),
    format: "der",
    type: "spki",
  });
  const ok = verify(null, canonicalize(manifest), key, Buffer.from(manifest.signature, "base64url"));
  console.log(ok ? `valid signature by ${pubkey}` : "INVALID signature");
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: sign-module.mjs keygen|sign|verify …  (see file header)");
  process.exit(1);
}
