import type { FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { UserRow } from '../db/schema';
import { unauthorized } from '../lib/http';
import { userFromSession } from '../services/auth';
import type { Ctx } from '../services/context';

export const SESSION_COOKIE = 'tandem_session';

/** What every route module is handed. */
export interface RouteEnv {
  ctx: Ctx;
  config: Config;
  /** The signed-in user for this request, or a 401. */
  currentUser(request: FastifyRequest): Promise<UserRow>;
  /** The address people and agents reach this server at. */
  publicUrl(request: FastifyRequest): string;
}

export function createRouteEnv(ctx: Ctx, config: Config): RouteEnv {
  return {
    ctx,
    config,
    async currentUser(request) {
      const user = await userFromSession(ctx.db, request.cookies[SESSION_COOKIE]);
      if (!user) throw unauthorized();
      return user;
    },
    publicUrl(request) {
      if (config.PUBLIC_URL) return config.PUBLIC_URL.replace(/\/+$/, '');
      return `${request.protocol}://${request.host}`;
    },
  };
}

/** Pull a bearer token out of an Authorization header. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}
