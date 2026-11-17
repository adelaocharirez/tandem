import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rooms } from '../db/schema';
import { formatDigest } from '../mcp/format';
import { buildMcpServer } from '../mcp/server';
import { peekDigest, touchAgent } from '../services/collab';
import { authenticateAgent } from '../services/rooms';
import { bearerToken, type RouteEnv } from './env';

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Where the Claudes connect.
 *
 *   POST /mcp                 Authorization: Bearer tdm_…   (Claude Code, anything that can send headers)
 *   POST /mcp/t/tdm_…                                       (connector UIs that only accept a URL)
 *
 * The second form puts the secret in the URL, which is how hosted connector
 * setups that can't send custom headers have to work. It is equivalent in
 * power, but URLs leak more easily (logs, screenshots), so the request logger
 * redacts it and the README says to prefer the header form where possible.
 */
export function registerMcpRoutes(app: FastifyInstance, env: RouteEnv): void {
  const { ctx } = env;

  const handle = async (request: FastifyRequest, reply: FastifyReply, token: string | null) => {
    const agent = token ? await authenticateAgent(ctx.db, token) : null;
    if (!agent) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="tandem"')
        .send(rpcError(-32001, 'Missing, wrong, or revoked Tandem agent token. Create a new one from the room dashboard.'));
    }
    const [room] = await ctx.db.select().from(rooms).where(eq(rooms.id, agent.roomId));
    if (!room) return reply.code(404).send(rpcError(-32001, 'The room this token belonged to no longer exists.'));

    // Stateless: one server + transport per request, plain JSON responses.
    // Every tool here is request/response, so there's nothing to stream and
    // no session to pin to an instance.
    const server = buildMcpServer(ctx, agent, room);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal server error')));
      }
    }
  };

  app.post('/mcp', (request, reply) => handle(request, reply, bearerToken(request)));
  app.post<{ Params: { token: string } }>('/mcp/t/:token', (request, reply) => handle(request, reply, request.params.token));

  // We never push server-initiated messages, so there is no SSE stream to open
  // and no session to delete. Say so the way the MCP spec expects.
  const notAllowed = (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('Allow', 'POST').send(rpcError(-32000, 'Method not allowed. This server is stateless; use POST.'));
  for (const url of ['/mcp', '/mcp/t/:token']) {
    app.get(url, notAllowed);
    app.delete(url, notAllowed);
  }

  /**
   * "Anything new?" for the Claude Code prompt hook (see README). Returns plain
   * text that the hook prints into the model's context, or nothing at all when
   * there is no news — so on a quiet day the hook is invisible.
   */
  app.get('/api/agent/digest', async (request, reply) => {
    const token = bearerToken(request);
    const agent = token ? await authenticateAgent(ctx.db, token) : null;
    if (!agent) return reply.code(401).type('text/plain').send('');
    const [room] = await ctx.db.select().from(rooms).where(eq(rooms.id, agent.roomId));
    await touchAgent(ctx, agent, null);
    const digest = await peekDigest(ctx, agent);
    return reply.type('text/plain; charset=utf-8').send(formatDigest(room?.name ?? 'room', digest));
  });
}
