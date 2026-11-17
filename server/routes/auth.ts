import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http';
import { destroySession, login, register, SESSION_DAYS, signupState } from '../services/auth';
import { toUserDTO } from '../services/dto';
import { SESSION_COOKIE, type RouteEnv } from './env';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,23}$/, 'Use 3–24 letters, numbers, dashes or underscores.');

const registerBody = z.object({
  username,
  displayName: z.string().trim().min(1).max(40).optional(),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
  inviteCode: z.string().trim().max(20).optional(),
});

const loginBody = z.object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(200) });

// Slow down password guessing. Generous enough that a real person never hits it.
const authLimit = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };

export function registerAuthRoutes(app: FastifyInstance, env: RouteEnv): void {
  const setSession = (request: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });

  app.post('/api/auth/register', authLimit, async (request, reply) => {
    const body = parse(registerBody, request.body);
    const { user, sessionToken } = await register(
      env.ctx.db,
      {
        username: body.username,
        displayName: body.displayName ?? body.username,
        password: body.password,
        inviteCode: body.inviteCode,
      },
      env.config.SIGNUP_MODE,
    );
    setSession(request, reply, sessionToken);
    return reply.code(201).send({ user: toUserDTO(user) });
  });

  // Lets the sign-in page explain itself: open signup, invite-only, or a brand-new server.
  app.get('/api/auth/config', async () => ({ signup: await signupState(env.ctx.db, env.config.SIGNUP_MODE) }));

  app.post('/api/auth/login', authLimit, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const { user, sessionToken } = await login(env.ctx.db, body.username, body.password);
    setSession(request, reply, sessionToken);
    return { user: toUserDTO(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(env.ctx.db, request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ user: toUserDTO(await env.currentUser(request)) }));
}
