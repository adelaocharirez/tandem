import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { AuthConfigDTO } from '../../shared/types';
import type { Db } from '../db/client';
import { rooms, sessions, users, type UserRow } from '../db/schema';
import { hashPassword, newSessionToken, sha256, verifyPassword } from '../lib/crypto';
import { conflict, forbidden, unauthorized } from '../lib/http';

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// Checked against when the username doesn't exist, so a login attempt takes
// the same time either way and doesn't reveal which usernames are registered.
const DUMMY_HASH = hashPassword('not-a-real-password');

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newSessionToken();
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_MS) });
  // Opportunistic cleanup; cheap, and keeps the table from growing forever.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return token;
}

async function hasUsers(db: Db): Promise<boolean> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(users);
  return Number(row?.total ?? 0) > 0;
}

export async function signupState(db: Db, mode: 'open' | 'invite'): Promise<AuthConfigDTO['signup']> {
  if (mode === 'open') return 'open';
  return (await hasUsers(db)) ? 'invite' : 'first';
}

/**
 * Invite-only signup, without anyone managing a secret: the very first
 * account on a server is free (that's whoever set it up), and after that a
 * new account needs the invite code of a real room. So the only way in is to
 * be invited by someone who is already inside.
 */
async function assertMayRegister(db: Db, mode: 'open' | 'invite', inviteCode: string | undefined): Promise<void> {
  if (mode === 'open' || !(await hasUsers(db))) return;
  const code = inviteCode?.trim().toUpperCase();
  const [room] = code ? await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.inviteCode, code)) : [];
  if (!room) {
    throw forbidden(
      code
        ? 'That invite code does not match any room. Check it with whoever sent it.'
        : 'This Tandem is invite-only. Ask a teammate for their room invite link.',
    );
  }
}

export async function register(
  db: Db,
  input: { username: string; displayName: string; password: string; inviteCode?: string },
  mode: 'open' | 'invite' = 'open',
): Promise<{ user: UserRow; sessionToken: string }> {
  await assertMayRegister(db, mode, input.inviteCode);
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
    })
    .onConflictDoNothing({ target: users.username })
    .returning();
  if (!user) throw conflict('That username is taken. Pick another.');
  return { user, sessionToken: await createSession(db, user.id) };
}

export async function login(
  db: Db,
  username: string,
  password: string,
): Promise<{ user: UserRow; sessionToken: string }> {
  const [user] = await db.select().from(users).where(eq(users.username, username));
  const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
  if (!user || !ok) throw unauthorized('Wrong username or password.');
  return { user, sessionToken: await createSession(db, user.id) };
}

export async function userFromSession(db: Db, token: string | undefined): Promise<UserRow | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}
