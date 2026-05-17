import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, atomicWriteTextSync, readText } from "../io/atomic.js";
import { loadEnv } from "../env.js";

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

function defaultKeyDir(): string {
  const stateDir = loadEnv().ARBITER_STATE_DIR ?? join(homedir(), ".arbiter");
  return join(stateDir, "keys");
}

const PRIVATE_FILE = "ed25519.private.pem";
const PUBLIC_FILE = "ed25519.public.pem";

export async function loadOrCreateKeyPair(dir?: string): Promise<KeyPair> {
  const kdir = dir ?? defaultKeyDir();
  const priv = join(kdir, PRIVATE_FILE);
  const pub = join(kdir, PUBLIC_FILE);

  if (existsSync(priv) && existsSync(pub)) {
    const privPem = await readText(priv);
    const pubPem = await readText(pub);
    return {
      privateKey: createPrivateKey(privPem),
      publicKey: createPublicKey(pubPem),
    };
  }

  const generated = generateKeyPairSync("ed25519");
  const privPem = generated.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const pubPem = generated.publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  // RT-2026-04-30-008 — restrictive mode on the private key.
  await atomicWriteText(priv, privPem, { mode: 0o600 });
  await atomicWriteText(pub, pubPem, { mode: 0o644 });
  return { privateKey: generated.privateKey, publicKey: generated.publicKey };
}

let cachedDefault: KeyPair | undefined;

export function loadOrCreateKeyPairSync(dir?: string): KeyPair {
  const usingDefault = dir === undefined;
  if (usingDefault && cachedDefault !== undefined) return cachedDefault;

  const kdir = dir ?? defaultKeyDir();
  const priv = join(kdir, PRIVATE_FILE);
  const pub = join(kdir, PUBLIC_FILE);

  let kp: KeyPair;
  if (existsSync(priv) && existsSync(pub)) {
    kp = {
      privateKey: createPrivateKey(readFileSync(priv, "utf-8")),
      publicKey: createPublicKey(readFileSync(pub, "utf-8")),
    };
  } else {
    const generated = generateKeyPairSync("ed25519");
    const privPem = generated.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const pubPem = generated.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    atomicWriteTextSync(priv, privPem, { mode: 0o600 });
    atomicWriteTextSync(pub, pubPem, { mode: 0o644 });
    kp = { privateKey: generated.privateKey, publicKey: generated.publicKey };
  }

  if (usingDefault) cachedDefault = kp;
  return kp;
}

export function resetKeyPairCache(): void {
  cachedDefault = undefined;
}
