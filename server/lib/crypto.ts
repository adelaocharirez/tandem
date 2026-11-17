import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** Hash a password with scrypt and a per-password salt. Format: `scrypt$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltPart, hashPart] = stored.split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;
  const expected = Buffer.from(hashPart, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltPart, 'base64url'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Tokens (session cookies, agent tokens) are high-entropy random strings, so a
 * plain SHA-256 is the right way to store them: fast to look up, and a
 * database leak doesn't reveal anything usable.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export const AGENT_TOKEN_PREFIX = 'tdm_';

export function newAgentToken(): { token: string; prefix: string; hash: string } {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, 10), hash: sha256(token) };
}

/** Invite codes are read aloud and typed by hand, so no look-alike characters. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(): string {
  const pick = () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `${block()}-${block()}`;
}
