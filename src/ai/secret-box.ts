import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_VERSION = 'v1';

function isErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}

/**
 * Encrypts API keys at rest with AES-256-GCM. The key material lives in a separate file
 * inside the WeaveMemory data directory, so database backups and exports never carry
 * plaintext credentials on their own.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async load(keyPath: string): Promise<SecretBox> {
    const existing = await readKeyFile(keyPath);
    if (existing) return new SecretBox(existing);
    const key = randomBytes(KEY_BYTES);
    try {
      await fs.writeFile(keyPath, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return new SecretBox(key);
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
      const raced = await readKeyFile(keyPath);
      if (!raced) throw new Error(`secret key file could not be created: ${keyPath}`);
      return new SecretBox(raced);
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PAYLOAD_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== PAYLOAD_VERSION || !iv || !tag || !ciphertext) throw new Error('unsupported secret payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}

async function readKeyFile(keyPath: string): Promise<Buffer | null> {
  let raw: string;
  try {
    raw = await fs.readFile(keyPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null;
    throw error;
  }
  const key = Buffer.from(raw.trim(), 'hex');
  if (key.length !== KEY_BYTES) throw new Error(`secret key file is invalid: ${keyPath}`);
  return key;
}
