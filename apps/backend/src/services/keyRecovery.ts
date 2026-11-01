import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { pool } from '../db';
import { getKek, KEY_LENGTH, ALGORITHM, IV_LENGTH } from './connectionCrypto';

export class RecoveryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'RecoveryError';
  }
}

const RECOVERY_KEY_LENGTH = 32;
const RECOVERY_IV_LENGTH = 12;
const DEFAULT_ITERATIONS = 250_000;
const RECOVERY_KEY_VERSION = 1;

function deriveRecoveryKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, RECOVERY_KEY_LENGTH, 'sha256');
}

function wrapKekWithRecovery(kek: Buffer, passphrase: string): {
  wrappedKek: string;
  salt: string;
  iterations: number;
  wrapIv: string;
  wrapTag: string;
} {
  const salt = randomBytes(16);
  const iterations = DEFAULT_ITERATIONS;
  const recoveryKey = deriveRecoveryKey(passphrase, salt, iterations);
  const iv = randomBytes(RECOVERY_IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, recoveryKey, iv);
  const wrapped = Buffer.concat([cipher.update(kek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    wrappedKek: wrapped.toString('base64'),
    salt: salt.toString('base64'),
    iterations,
    wrapIv: iv.toString('base64'),
    wrapTag: tag.toString('base64')
  };
}

function unwrapKekWithRecovery(
  wrappedKek: string,
  salt: string,
  iterations: number,
  wrapIv: string,
  wrapTag: string,
  passphrase: string
): Buffer {
  const recoveryKey = deriveRecoveryKey(passphrase, Buffer.from(salt, 'base64'), iterations);
  const decipher = createDecipheriv(ALGORITHM, recoveryKey, Buffer.from(wrapIv, 'base64'));
  decipher.setAuthTag(Buffer.from(wrapTag, 'base64'));
  const kek = Buffer.concat([
    decipher.update(Buffer.from(wrappedKek, 'base64')),
    decipher.final()
  ]);
  if (kek.length !== KEY_LENGTH) {
    throw new RecoveryError('Recovery passphrase is incorrect.');
  }
  return kek;
}

export type RecoveryRecord = {
  id: string;
  user_id: string;
  wrapped_kek: string;
  salt: string;
  iterations: number;
  wrap_iv: string;
  wrap_tag: string;
  recovery_key_version: number;
  created_at: string;
  rotated_at: string | null;
};

export type RecoveryRowInput = {
  userId: string;
  kek: Buffer;
  passphrase: string;
};

export async function createRecoveryRecord(input: RecoveryRowInput): Promise<RecoveryRecord> {
  const { wrappedKek, salt, iterations, wrapIv, wrapTag } = wrapKekWithRecovery(input.kek, input.passphrase);
  const { rows } = await pool.query<RecoveryRecord>(
    `INSERT INTO recovery_keys
       (user_id, wrapped_kek, salt, iterations, wrap_iv, wrap_tag, recovery_key_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id, user_id, wrapped_kek, salt, iterations, wrap_iv, wrap_tag, recovery_key_version, created_at, rotated_at`,
    [input.userId, wrappedKek, salt, iterations, wrapIv, wrapTag, RECOVERY_KEY_VERSION]
  );
  if (!rows[0]) throw new RecoveryError('Failed to create recovery record.', 500);
  return rows[0];
}

export async function getRecoveryRecord(userId: string): Promise<RecoveryRecord | null> {
  const { rows } = await pool.query<RecoveryRecord>(
    `SELECT id, user_id, wrapped_kek, salt, iterations, wrap_iv, wrap_tag, recovery_key_version, created_at, rotated_at
     FROM recovery_keys
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getAnyRecoveryRecord(): Promise<RecoveryRecord | null> {
  const { rows } = await pool.query<RecoveryRecord>(
    `SELECT id, user_id, wrapped_kek, salt, iterations, wrap_iv, wrap_tag, recovery_key_version, created_at, rotated_at
     FROM recovery_keys
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function unwrapKekFromRecovery(userId: string, passphrase: string): Promise<Buffer> {
  const record = await getRecoveryRecord(userId);
  if (!record) throw new RecoveryError('No recovery record found for this user.', 404);
  return unwrapKekWithRecovery(
    record.wrapped_kek,
    record.salt,
    record.iterations,
    record.wrap_iv,
    record.wrap_tag,
    passphrase
  );
}

export async function validateRecoveryPassphrase(userId: string, passphrase: string): Promise<boolean> {
  try {
    await unwrapKekFromRecovery(userId, passphrase);
    return true;
  } catch {
    return false;
  }
}

export async function rotateRecoveryPassphrase(userId: string, currentPassphrase: string, newPassphrase: string): Promise<void> {
  const kek = await unwrapKekFromRecovery(userId, currentPassphrase);
  const { wrappedKek, salt, iterations, wrapIv, wrapTag } = wrapKekWithRecovery(kek, newPassphrase);
  await pool.query(
    `UPDATE recovery_keys
       SET wrapped_kek = $2, salt = $3, iterations = $4, wrap_iv = $5, wrap_tag = $6,
           recovery_key_version = $7, rotated_at = now()
     WHERE user_id = $1`,
    [userId, wrappedKek, salt, iterations, wrapIv, wrapTag, RECOVERY_KEY_VERSION]
  );
}

export function recoveryPassphraseConfigured(): boolean {
  return Boolean(process.env.CONNECTION_RECOVERY_PASSPHRASE);
}

export function getConfiguredRecoveryPassphrase(): string {
  const passphrase = process.env.CONNECTION_RECOVERY_PASSPHRASE;
  if (!passphrase) throw new RecoveryError('CONNECTION_RECOVERY_PASSPHRASE is not configured.', 500);
  return passphrase;
}
