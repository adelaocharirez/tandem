import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { MemoryEventBus, type EventBus } from './lib/bus';
import { HttpError } from './lib/http';
import { registerAuthRoutes } from './routes/auth';
import { createRouteEnv } from './routes/env';
import { registerHookRoutes } from './routes/hooks';
import { registerMcpRoutes } from './routes/mcp';
import { registerRealtimeRoutes } from './routes/realtime';
import { registerRoomRoutes } from './routes/rooms';

export interface AppOptions {
  config: Config;
  db: Db;
  bus?: EventBus;
}

/** Agent tokens can appear in URLs (`/mcp/t/<token>`); keep them out of the logs. */
export const redactUrl = (url: string) => url.replace(/\/mcp\/t\/[^/?#]+/, '/mcp/t/[redacted]');

function findWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, 'web'), path.resolve(here, '../dist/web')];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

/**
 * Assemble the HTTP server. Kept separate from index.ts so tests can build an
 * app around an in-memory database and call it without opening a port.
 */
export async function buildApp({ config, db, bus = new MemoryEventBus() }: AppOptions): Promise<FastifyInstance> {
  const isTest = config.NODE_ENV === 'test';
  const isProd = config.NODE_ENV === 'production';

  const app = Fastify({
    // Hosting platforms and tunnels terminate TLS in front of us; trust their
    // X-Forwarded-* headers so we see the real protocol, host and client IP.
    trustProxy: true,
    bodyLimit: 256 * 1024,
    logger: isTest
      ? false
      : {
          level: isProd ? 'info' : 'warn',
          serializers: {
            req: (request) => ({ method: request.method, url: redactUrl(request.url), ip: request.ip }),
          },
        },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // People run this over plain http on localhost and LANs too.
        upgradeInsecureRequests: null,
      },
    },
    hsts: isProd,
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  if (!isTest) {
    await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const message = status === 429 ? 'Too many requests. Wait a minute and try again.' : (error as Error).message;
      return reply.code(status).send({ error: message });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  const env = createRouteEnv({ db, bus }, config);

  app.get('/healthz', async () => ({ ok: true }));
  registerAuthRoutes(app, env);
  registerRoomRoutes(app, env);
  registerRealtimeRoutes(app, env);
  registerMcpRoutes(app, env);
  registerHookRoutes(app, env);

  // In production the same process serves the built dashboard, so the whole
  // product is one URL: the page at /, the API at /api, agents at /mcp.
  const webRoot = findWebRoot();
  if (webRoot && !isTest) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const isPage = request.method === 'GET' && !/^\/(api|mcp|ws|assets|setup\.js)(\/|$)/.test(request.url);
    if (webRoot && !isTest && isPage) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found.' });
  });

  return app;
}
