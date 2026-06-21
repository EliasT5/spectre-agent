/**
 * Module manifest signing — ed25519 over a JCS-canonicalized manifest.
 *
 * SERVER-ONLY. This uses node:crypto and must never enter the browser bundle
 * (only ever imported from route handlers / server code). Dependency-free.
 *
 * Wire format: both `author.pubkey` and `signature` are base64url strings.
 * The signed payload is the canonical JSON of the manifest WITHOUT its
 * `signature` field (JCS-style: keys sorted recursively, stable JSON, UTF-8).
 */
import { sign, verify, createPublicKey, type KeyObject } from "node:crypto";
import type { ModuleManifestV2 } from "./manifest";

/** Recursively sort object keys for a stable, canonical serialization. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * JCS-style canonical bytes of a manifest: drop the `signature` field, sort all
 * object keys recursively, stable JSON, encoded UTF-8. This is exactly what gets
 * signed and verified.
 */
export function canonicalize(manifest: ModuleManifestV2): Buffer {
  const { signature: _drop, ...rest } = manifest as ModuleManifestV2 & {
    signature?: string;
  };
  void _drop;
  return Buffer.from(JSON.stringify(sortValue(rest)), "utf8");
}

function toPublicKey(pubkey: string): KeyObject {
  // pubkey is the raw 32-byte ed25519 public key, base64url-encoded.
  const raw = Buffer.from(pubkey, "base64url");
  // Wrap the raw key in the SPKI DER prefix for ed25519 so createPublicKey
  // accepts it as a DER-encoded SubjectPublicKeyInfo.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([spkiPrefix, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Sign a manifest with an ed25519 private key (PEM string or KeyObject).
 * Returns the base64url signature over the canonicalized manifest.
 */
export function signManifest(
  manifest: ModuleManifestV2,
  privateKey: string | KeyObject,
): string {
  const key =
    typeof privateKey === "string"
      ? createPrivateKeyFromPem(privateKey)
      : privateKey;
  // ed25519 -> algorithm must be null; sign over the canonical bytes.
  const sig = sign(null, canonicalize(manifest), key);
  return sig.toString("base64url");
}

function createPrivateKeyFromPem(pem: string): KeyObject {
  // Lazy import keeps the surface minimal; node:crypto already loaded above.
  const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
  return createPrivateKey(pem);
}

/**
 * The trusted keyring: SPECTRE_MODULE_TRUSTED_KEYS, a comma/whitespace-separated
 * list of base64url ed25519 public keys (the output of
 * `node scripts/sign-module.mjs keygen`). When set, every NON-BUILTIN manifest
 * (DB-installed or data-dir drop-in) must carry a valid signature from one of
 * these keys before its backend routes/permissions are honored. When unset,
 * enforcement is off — today only service-role holders can write
 * module_installs and only the box owner can write the data dir, so the
 * single-operator trust model holds; configure a keyring before accepting
 * manifests from any channel you don't fully control (e.g. a registry).
 *
 * Verifying a manifest against its OWN embedded pubkey alone proves nothing
 * (anyone can self-sign) — trust comes from the pubkey being in this keyring.
 */
export function trustedModuleKeys(): Set<string> {
  const raw = process.env.SPECTRE_MODULE_TRUSTED_KEYS ?? "";
  return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

/**
 * Trust verdict for a manifest of untrusted provenance (DB row / data-dir file —
 * NEVER call this for the compiled-in BUILTINS; exemption is by provenance, not
 * by the spoofable `builtin` flag). Returns null when trusted, else the reason.
 */
export function manifestTrustError(manifest: unknown): string | null {
  const keys = trustedModuleKeys();
  if (keys.size === 0) return null; // enforcement off — no keyring configured

  if (!manifest || typeof manifest !== "object") return "not an object";
  const m = manifest as ModuleManifestV2 & {
    signature?: string;
    author?: { pubkey?: string };
  };
  if (!m.signature || !m.author?.pubkey) return "unsigned";
  if (!keys.has(m.author.pubkey)) return "signer not in SPECTRE_MODULE_TRUSTED_KEYS";
  if (!verifyManifestSignature(m)) return "bad signature";
  return null;
}

/**
 * Verify a manifest's signature using its own embedded `author.pubkey` and
 * `signature` (both base64url). Returns false on any missing field or bad key.
 * NOTE: a passing self-verification is necessary but NOT sufficient — callers
 * must also check the pubkey against the trusted keyring (see manifestTrustError).
 */
export function verifyManifestSignature(manifest: ModuleManifestV2): boolean {
  const m = manifest as ModuleManifestV2 & {
    signature?: string;
    author?: { pubkey?: string };
  };
  const sigB64 = m.signature;
  const pubkey = m.author?.pubkey;
  if (!sigB64 || !pubkey) return false;
  try {
    const pubKey = toPublicKey(pubkey);
    const sig = Buffer.from(sigB64, "base64url");
    return verify(null, canonicalize(manifest), pubKey, sig);
  } catch {
    return false;
  }
}
