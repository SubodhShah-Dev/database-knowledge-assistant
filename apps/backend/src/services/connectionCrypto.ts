import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm';
export const KEY_LENGTH = 32;
export const IV_LENGTH = 12;

const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';

function envKey(): Buffer {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) throw new Error('CONNECTION_ENCRYPTION_KEY is required');

  const buffer = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
  if (buffer.length !== KEY_LENGTH) {
    throw new Error('CONNECTION_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buffer;
}

export function getKek(): Buffer {
  return envKey();
}

export function keyVersion(): number {
  const v = Number(process.env.CONNECTION_ENCRYPTION_KEY_VERSION || 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export type EncryptedSecretV2 = {
  version: 2;
  kekVersion: number;
  wrapIv: string;
  wrapTag: string;
  wrappedDek: string;
  dataIv: string;
  dataTag: string;
  data: string;
};

function splitParts(value: string): string[] {
  return value.split(':');
}

function isV1(value: string): boolean {
  return value.startsWith(`${VERSION_V1}:`);
}

function isV2(value: string): boolean {
  return value.startsWith(`${VERSION_V2}:`);
}

function wrapDek(dek: Buffer, kek: Buffer): { iv: string; tag: string; wrapped: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), wrapped: wrapped.toString('base64') };
}

function unwrapDek(wrapped: string, iv: string, tag: string, kek: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const dek = Buffer.concat([
    decipher.update(Buffer.from(wrapped, 'base64')),
    decipher.final()
  ]);
  if (dek.length !== KEY_LENGTH) {
    throw new Error('Wrapped data encryption key has invalid length.');
  }
  return dek;
}

function encryptWithKey(plain: Buffer, key: Buffer): { iv: string; tag: string; data: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
}

function decryptWithKey(data: string, iv: string, tag: string, key: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final()
  ]);
}

export function encryptSecret(plain: string): string {
  const kek = envKey();
  const kekVersion = keyVersion();
  const dek = randomBytes(KEY_LENGTH);
  const dataPlain = Buffer.from(plain, 'utf8');
  const { iv: dataIv, tag: dataTag, data } = encryptWithKey(dataPlain, dek);
  const { iv: wrapIv, tag: wrapTag, wrapped } = wrapDek(dek, kek);
  return [
    VERSION_V2,
    String(kekVersion),
    wrapIv,
    wrapTag,
    wrapped,
    dataIv,
    dataTag,
    data
  ].join(':');
}

export function decryptSecret(value: string): string {
  if (isV1(value)) {
    return decryptLegacy(value);
  }
  if (isV2(value)) {
    return decryptV2(value);
  }
  throw new Error('Malformed encrypted secret.');
}

function decryptV2(value: string): string {
  const parts = splitParts(value);
  // v2:kekVersion:wrapIv:wrapTag:wrappedDek:dataIv:dataTag:data
  if (parts.length !== 8 || parts[0] !== VERSION_V2) {
    throw new Error('Malformed encrypted secret.');
  }
  const kek = envKey();
  const dek = unwrapDek(parts[4], parts[2], parts[3], kek);
  const plain = decryptWithKey(parts[7], parts[5], parts[6], dek);
  return plain.toString('utf8');
}

function decryptLegacy(value: string): string {
  const parts = splitParts(value);
  // v1:iv:tag:data
  if (parts.length !== 4 || parts[0] !== VERSION_V1) {
    throw new Error('Malformed encrypted secret.');
  }
  const kek = envKey();
  const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64')),
    decipher.final()
  ]);
  return plain.toString('utf8');
}

export function reEncryptSecret(value: string): string {
  const plain = decryptSecret(value);
  return encryptSecret(plain);
}

export function isLegacyEncryptedSecret(value: string): boolean {
  return isV1(value);
}

export function currentKeyVersion(): number {
  return keyVersion();
}
