import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, parse } from '../lib/http';
import { requireMembership } from '../services/rooms';
import type { RouteEnv } from './env';

const query = z.object({ roomId: z.uuid() });
const PING_MS = 25_000;

/**
 * Live feed for the dashboard. One socket per open room; the server only ever
 * pushes (RoomEvent JSON) — anything a person does goes through the REST API,
 * so there's a single write path to validate and test.
 */
export function registerRealtimeRoutes(app: FastifyInstance, env: RouteEnv): void {
  const authorize = async (request: FastifyRequest): Promise<string> => {
    // Browsers attach cookies to WebSocket handshakes from any site, so check
    // the Origin ourselves — otherwise another page could read a member's feed.
    if (env.config.NODE_ENV === 'production') {
      const origin = request.headers.origin;
      const allowed = new Set([request.host, env.config.PUBLIC_URL ? new URL(env.config.PUBLIC_URL).host : '']);
      if (!origin || !allowed.has(new URL(origin).host)) throw forbidden('Cross-origin WebSocket connections are not allowed.');
    }
    const user = await env.currentUser(request);
    const { roomId } = parse(query, request.query);
    await requireMembership(env.ctx.db, roomId, user.id);
    return roomId;
  };

  app.get(
    '/ws',
    {
      websocket: true,
      // Runs before the upgrade, so a rejected client gets a normal HTTP error.
      preValidation: async (request) => {
        await authorize(request);
      },
    },
    (socket, request) => {
      const { roomId } = parse(query, request.query);

      const unsubscribe = env.ctx.bus.subscribe(roomId, (event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });

      // Keep idle connections open through proxies that drop quiet sockets.
      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, PING_MS);

      socket.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      socket.on('error', () => socket.close());
    },
  );
}
