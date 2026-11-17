import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { CreatedAgentDTO, RoomDTO } from '../shared/types';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { openDb } from '../server/db/client';

export interface TestServer {
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

/** A real server on a random port, backed by a throwaway in-memory Postgres. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const handle = await openDb({ memory: true });
  const app = await buildApp({ config, db: handle.db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/** A signed-in person: wraps fetch with their session cookie. */
export class Person {
  constructor(
    private readonly baseUrl: string,
    public readonly cookie: string,
  ) {}

  static async register(server: TestServer, username: string, displayName = username, inviteCode?: string): Promise<Person> {
    const response = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, displayName, password: 'correct horse battery', inviteCode }),
    });
    if (response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`);
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    return new Person(server.baseUrl, cookie);
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { cookie: this.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  async createRoom(name: string): Promise<RoomDTO> {
    return (await this.request('POST', '/api/rooms', { name })).json.room;
  }

  async joinRoom(inviteCode: string): Promise<RoomDTO> {
    return (await this.request('POST', '/api/rooms/join', { inviteCode })).json.room;
  }

  async connectAgent(roomId: string, name: string): Promise<CreatedAgentDTO> {
    const { status, json } = await this.request('POST', `/api/rooms/${roomId}/agents`, { name });
    if (status !== 201) throw new Error(`connectAgent failed: ${status}`);
    return json;
  }
}

/** A real MCP client, speaking Streamable HTTP to the server exactly as Claude Code would. */
export async function connectMcp(server: TestServer, token: string, via: 'header' | 'url' = 'header'): Promise<Client> {
  const client = new Client({ name: 'tandem-tests', version: '0.0.0' });
  const transport =
    via === 'header'
      ? new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        })
      : new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp/t/${token}`));
  await client.connect(transport);
  return client;
}

/** Call a tool and return its text, plus whether the tool reported an error. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true };
}
