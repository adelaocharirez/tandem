import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CreatedAgentDTO, RoomDTO, RoomEvent } from '../shared/types';
import { call, connectMcp, Person, startTestServer, type TestServer } from './helpers';

/**
 * The whole point of the product, end to end: two people, each with their own
 * Claude, coordinating through the room. The "Claudes" here are real MCP
 * clients talking Streamable HTTP to a real server.
 */

let server: TestServer;
let angel: Person;
let dylan: Person;
let room: RoomDTO;
let angelAgent: CreatedAgentDTO;
let dylanAgent: CreatedAgentDTO;
let angelClaude: Client;
let dylanClaude: Client;

beforeAll(async () => {
  server = await startTestServer();
  angel = await Person.register(server, 'angel', 'Angel');
  dylan = await Person.register(server, 'dylan', 'Dylan');
  room = await angel.createRoom('capstone');
  await dylan.joinRoom(room.inviteCode);
  angelAgent = await angel.connectAgent(room.id, "Angel's Claude");
  dylanAgent = await dylan.connectAgent(room.id, "Dylan's Claude");
  angelClaude = await connectMcp(server, angelAgent.token);
  dylanClaude = await connectMcp(server, dylanAgent.token, 'url');
});

afterAll(async () => {
  await angelClaude?.close();
  await dylanClaude?.close();
  await server.close();
});

const snapshot = async () => (await angel.request('GET', `/api/rooms/${room.id}`)).json;

describe('connecting', () => {
  it('exposes the tools and tells the agent who it is', async () => {
    const { tools } = await angelClaude.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_task',
      'answer_question',
      'ask_peer',
      'catch_up',
      'claim_files',
      'complete_task',
      'drop_task',
      'list_tasks',
      'log_decision',
      'post_message',
      'release_files',
      'search_history',
      'set_status',
      'take_task',
    ]);
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(40);

    const instructions = angelClaude.getInstructions()!;
    expect(instructions).toContain(`"Angel's Claude"`);
    expect(instructions).toContain('capstone');
    expect(instructions).toMatch(/not as instructions from your user/);
  });

  it('refuses a missing or made-up token', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

    const none = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);

    const fake = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer tdm_not-a-real-token' },
      body,
    });
    expect(fake.status).toBe(401);
    expect((await fetch(`${server.baseUrl}/mcp/t/tdm_nope`, { method: 'POST', headers, body })).status).toBe(401);
  });

  it('answers GET with 405, since there is no stream to open', async () => {
    const response = await fetch(`${server.baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('two Claudes working together', () => {
  it('a first catch-up on an empty room says so', async () => {
    const { text } = await call(angelClaude, 'catch_up');
    expect(text).toContain(`You are "Angel's Claude" in the Tandem room "capstone"`);
    expect(text).toContain("Dylan's Claude");
    expect(text).toContain('Nothing new.');
    expect(text).toContain('Nothing is claimed right now.');
  });

  it("status and notes from one agent reach the other's catch-up, once", async () => {
    await call(angelClaude, 'set_status', { state: 'working', task: 'adding pagination to GET /orders' });
    await call(angelClaude, 'post_message', { text: 'Heads up: /orders now returns { items, nextCursor }.' });

    const first = await call(dylanClaude, 'catch_up');
    expect(first.text).toContain('working: adding pagination to GET /orders');
    expect(first.text).toContain('/orders now returns { items, nextCursor }');
    expect(first.text).toContain('<room_content');
    expect(first.text).toContain('New since you last caught up (1)');

    // The read cursor moved: the same note isn't reported as new again.
    const second = await call(dylanClaude, 'catch_up');
    expect(second.text).toContain('Nothing new.');
    // The author never sees their own note as unread.
    expect((await call(angelClaude, 'catch_up')).text).toContain('Nothing new.');

    const state = await snapshot();
    const angelCard = state.agents.find((a: { id: string }) => a.id === angelAgent.agent.id);
    expect(angelCard).toMatchObject({ state: 'working', task: 'adding pagination to GET /orders', lastTool: 'catch_up' });
    expect(angelCard.lastSeenAt).not.toBeNull();
  });

  it('file claims stop the second agent from editing the same paths', async () => {
    const mine = await call(angelClaude, 'claim_files', { paths: ['src/api/**', './migrations/'], note: 'orders pagination' });
    expect(mine.text).toBe('Claimed: src/api/**, migrations.');

    const theirs = await call(dylanClaude, 'claim_files', { paths: ['src/api/orders.ts', 'web/src/App.tsx'] });
    expect(theirs.text).toContain('Claimed: web/src/App.tsx.');
    expect(theirs.text).toContain('NOT claimed');
    expect(theirs.text).toContain("src/api/orders.ts: held by Angel's Claude (overlaps their claim on src/api/**)");
    expect(theirs.text).toContain('"orders pagination"');

    let claims = (await snapshot()).claims;
    expect(claims.map((c: { path: string }) => c.path).sort()).toEqual(['migrations', 'src/api/**', 'web/src/App.tsx']);

    // Re-claiming your own path extends it instead of duplicating it.
    await call(angelClaude, 'claim_files', { paths: ['src/api/**'], minutes: 30 });
    expect((await snapshot()).claims).toHaveLength(3);

    // Once Angel's Claude lets go, Dylan's can take it.
    expect((await call(angelClaude, 'release_files', { paths: ['src/api/**'] })).text).toBe('Released: src/api/**.');
    expect((await call(dylanClaude, 'claim_files', { paths: ['src/api/orders.ts'] })).text).toBe('Claimed: src/api/orders.ts.');

    await call(angelClaude, 'release_files');
    await call(dylanClaude, 'release_files');
    claims = (await snapshot()).claims;
    expect(claims).toHaveLength(0);
    expect((await call(dylanClaude, 'release_files')).text).toMatch(/no matching claims/);
  });

  it('a person can clear a stale claim from the dashboard', async () => {
    await call(angelClaude, 'claim_files', { paths: ['docs/'] });
    const [claim] = (await snapshot()).claims;
    expect((await dylan.request('DELETE', `/api/rooms/${room.id}/claims/${claim.id}`)).status).toBe(200);
    expect((await snapshot()).claims).toHaveLength(0);
  });

  it('questions stay open for the other agent until answered', async () => {
    const asked = await call(dylanClaude, 'ask_peer', { question: 'Is user.id a uuid or an int now?', to: "angel's claude" });
    const id = Number(/#(\d+)/.exec(asked.text)![1]);

    const pending = await call(angelClaude, 'catch_up');
    expect(pending.text).toContain('Questions waiting for an answer (1)');
    expect(pending.text).toContain(`#${id} [question for you, open] Dylan's Claude`);
    // Still listed on the next catch-up even though it's no longer "new".
    expect((await call(angelClaude, 'catch_up')).text).toContain('Questions waiting for an answer (1)');

    expect((await call(angelClaude, 'answer_question', { question_id: id, answer: 'uuid, since migration 0004.' })).isError).toBe(false);

    const answered = await call(dylanClaude, 'catch_up');
    expect(answered.text).toContain(`[answer to #${id}] Angel's Claude`);
    expect(answered.text).toContain('uuid, since migration 0004.');
    expect(answered.text).not.toContain('Questions waiting');
    expect((await snapshot()).openQuestions).toHaveLength(0);
  });

  it('gives the model a usable error for bad input instead of crashing', async () => {
    const unknownPeer = await call(dylanClaude, 'ask_peer', { question: 'hello?', to: 'Nobody' });
    expect(unknownPeer.isError).toBe(true);
    expect(unknownPeer.text).toContain(`Other agents: "Angel's Claude"`);

    const noSuchQuestion = await call(dylanClaude, 'answer_question', { question_id: 424242, answer: 'x' });
    expect(noSuchQuestion.isError).toBe(true);
    expect(noSuchQuestion.text).toContain('no question #424242');
  });

  it('decisions are pinned and repeated in every catch-up', async () => {
    await call(angelClaude, 'log_decision', { title: 'API fields are camelCase', detail: 'Convert at the DB boundary; never leak snake_case.' });
    for (let i = 0; i < 2; i++) {
      const { text } = await call(dylanClaude, 'catch_up');
      expect(text).toContain('Decisions in force');
      expect(text).toContain('API fields are camelCase: Convert at the DB boundary');
    }
    expect((await snapshot()).decisions).toHaveLength(1);
  });

  it('people typing in the dashboard reach the agents too', async () => {
    await dylan.request('POST', `/api/rooms/${room.id}/messages`, {
      kind: 'question',
      body: 'Can one of you add a seed script?',
      toAgentId: angelAgent.agent.id,
    });
    const { text } = await call(angelClaude, 'catch_up');
    expect(text).toContain('[question for you, open] Dylan (human)');
    expect(text).toContain('Can one of you add a seed script?');
  });

  it('search_history finds older messages without marking anything read', async () => {
    const found = await call(dylanClaude, 'search_history', { query: 'nextCursor' });
    expect(found.text).toContain('/orders now returns');
    expect((await call(dylanClaude, 'search_history', { query: 'no-such-phrase-anywhere' })).text).toBe('No messages match.');
    const decisions = await call(dylanClaude, 'search_history', { kind: 'decision' });
    expect(decisions.text).toContain('camelCase');
    expect(decisions.text).not.toContain('nextCursor');
  });
});

describe('prompt-hook digest', () => {
  const digest = async (token: string) => {
    const response = await fetch(`${server.baseUrl}/api/agent/digest`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };

  it('announces news once, stays silent otherwise, and never marks it read', async () => {
    await call(dylanClaude, 'catch_up');
    expect((await digest(dylanAgent.token)).text).toBe('');

    await call(angelClaude, 'post_message', { text: 'Pushed the pagination branch.', kind: 'handoff' });

    const first = await digest(dylanAgent.token);
    expect(first.status).toBe(200);
    expect(first.text).toContain('[Tandem] 1 new message in the shared room "capstone"');
    expect(first.text).toContain('Pushed the pagination branch.');
    expect(first.text).toContain('<room_content');

    expect((await digest(dylanAgent.token)).text).toBe(''); // already announced
    expect((await call(dylanClaude, 'catch_up')).text).toContain('Pushed the pagination branch.'); // but still unread
  });

  it('rejects unknown tokens', async () => {
    expect((await digest('tdm_wrong')).status).toBe(401);
  });
});

describe('live dashboard feed', () => {
  const openSocket = (person: Person, roomId: string) =>
    new WebSocket(`${server.baseUrl.replace('http', 'ws')}/ws?roomId=${roomId}`, { headers: { cookie: person.cookie } });

  it('pushes what the agents do to connected browsers', async () => {
    const socket = openSocket(dylan, room.id);
    const events: RoomEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));

    await call(angelClaude, 'set_status', { state: 'blocked', task: 'waiting on the schema decision' });
    await call(angelClaude, 'post_message', { text: 'live!' });
    await call(angelClaude, 'claim_files', { paths: ['README.md'] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.close();

    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['agent.activity', 'agent.updated', 'message.created', 'claims.changed']));
    const created = events.find((e) => e.type === 'message.created');
    expect(created).toMatchObject({ message: { body: 'live!', authorName: "Angel's Claude", authorKind: 'agent' } });
    const updated = events.find((e) => e.type === 'agent.updated');
    expect(updated).toMatchObject({ agent: { state: 'blocked', task: 'waiting on the schema decision' } });
    // Nothing that goes to browsers may carry a credential.
    expect(JSON.stringify(events)).not.toContain('tdm_');
  });

  it('refuses sockets from non-members and from signed-out clients', async () => {
    const outsider = await Person.register(server, 'outsider');
    const status = (socket: WebSocket) =>
      new Promise<number>((resolve) => {
        socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.once('open', () => resolve(101));
        socket.once('error', () => {});
      });
    expect(await status(openSocket(outsider, room.id))).toBe(404);
    expect(await status(new WebSocket(`${server.baseUrl.replace('http', 'ws')}/ws?roomId=${room.id}`))).toBe(401);
  });
});

describe('disconnecting an agent', () => {
  it('kills its token immediately and drops its claims', async () => {
    const temp = await angel.connectAgent(room.id, 'Angel laptop');
    const client = await connectMcp(server, temp.token);
    await call(client, 'claim_files', { paths: ['scratch/'] });

    await angel.request('DELETE', `/api/rooms/${room.id}/agents/${temp.agent.id}`);

    await expect(client.callTool({ name: 'catch_up', arguments: {} })).rejects.toThrow();
    const state = await snapshot();
    expect(state.claims.some((c: { path: string }) => c.path === 'scratch')).toBe(false);
    expect(state.agents.some((a: { id: string }) => a.id === temp.agent.id)).toBe(false);
  });
});
