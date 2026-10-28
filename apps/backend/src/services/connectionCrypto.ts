import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function key(): Buffer {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) throw new Error('CONNECTION_ENCRYPTION_KEY is required');

  const buffer = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
  if (buffer.length !== 32) {
    throw new Error('CONNECTION_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buffer;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64')
  ].join(':');
}

export function decryptSecret(value: string): string {
  const [version, ivB64, tagB64, dataB64] = value.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]);
  return plain.toString('utf8');
}
