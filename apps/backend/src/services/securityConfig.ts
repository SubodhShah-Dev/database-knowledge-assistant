import { createCipheriv } from 'node:crypto';

const WEAK_SECRETS = new Set([
  'replace_with_a_strong_secret',
  'change_me',
  'secret',
  'development',
  'default',
  '',
]);

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigError';
  }
}

function decodeKeyLength(raw: string): number {
  try {
    const buffer = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
    return buffer.length;
  } catch {
    return -1;
  }
}

export function validateSecurityConfig(): void {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    throw new SecurityConfigError(
      'JWT_SECRET is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  if (WEAK_SECRETS.has(jwtSecret.trim())) {
    throw new SecurityConfigError(
      'JWT_SECRET must not be a placeholder or weak value. Generate a strong random secret.',
    );
  }
  if (jwtSecret.length < 32) {
    throw new SecurityConfigError(
      'JWT_SECRET must be at least 32 characters long for production use.',
    );
  }

  const encryptionKey = process.env.CONNECTION_ENCRYPTION_KEY || '';
  if (!encryptionKey) {
    throw new SecurityConfigError(
      'CONNECTION_ENCRYPTION_KEY is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const keyLen = decodeKeyLength(encryptionKey);
  if (keyLen !== 32) {
    throw new SecurityConfigError(
      'CONNECTION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex).',
    );
  }

  // In production, additionally refuse to start with an insecure default database password.
  const databaseUrl = process.env.DATABASE_URL || '';
  if (isProduction && /local_dev_password|postgres:.*@localhost/i.test(databaseUrl)) {
    throw new SecurityConfigError(
      'DATABASE_URL appears to use a default local development password. Set a strong production password.',
    );
  }

  // Proactively validate the encryption key can instantiate a cipher (catch malformed keys early).
  try {
    createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, encryptionKey.length === 64 ? 'hex' : 'base64'), Buffer.alloc(12));
  } catch {
    throw new SecurityConfigError('CONNECTION_ENCRYPTION_KEY is malformed and cannot initialize AES-256-GCM.');
  }

  // In production, a recovery passphrase is required so credentials can be recovered if the
  // encryption key is lost. Generate one and store it offline, separate from the app database.
  const recoveryPassphrase = process.env.CONNECTION_RECOVERY_PASSPHRASE || '';
  if (isProduction && !recoveryPassphrase) {
    throw new SecurityConfigError(
      'CONNECTION_RECOVERY_PASSPHRASE is required in production. Set a strong passphrase and back it up offline.'
    );
  }
  if (recoveryPassphrase.length < 12) {
    throw new SecurityConfigError(
      'CONNECTION_RECOVERY_PASSPHRASE must be at least 12 characters long.'
    );
  }
}
