import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../server/app';
import { Person, startTestServer, type TestServer } from './helpers';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('accounts', () => {
  it('registers, then recognises the session cookie', async () => {
    const ada = await Person.register(server, 'ada', 'Ada');
    const me = await ada.request('GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ username: 'ada', displayName: 'Ada' });
  });

  it('sets an http-only, same-site cookie', async () => {
    const response = await post('/api/auth/register', { username: 'cookie-check', password: 'long enough pw' });
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects a taken username, a weak password and a bad username', async () => {
    await Person.register(server, 'taken');
    expect((await post('/api/auth/register', { username: 'taken', password: 'another password' })).status).toBe(409);
    expect((await post('/api/auth/register', { username: 'shorty', password: 'short' })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'no spaces!', password: 'long enough pw' })).status).toBe(400);
  });

  it('logs in with the right password only, and gives the same error either way', async () => {
    await Person.register(server, 'grace');
    const good = await post('/api/auth/login', { username: 'grace', password: 'correct horse battery' });
    expect(good.status).toBe(200);

    const wrongPassword = await post('/api/auth/login', { username: 'grace', password: 'nope nope nope' });
    const noSuchUser = await post('/api/auth/login', { username: 'nobody', password: 'nope nope nope' });
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await noSuchUser.json());
  });

  it('logging out ends the session', async () => {
    const linus = await Person.register(server, 'linus');
    await linus.request('POST', '/api/auth/logout');
    expect((await linus.request('GET', '/api/auth/me')).status).toBe(401);
  });

  it('requires a session for room routes', async () => {
    const response = await fetch(`${server.baseUrl}/api/rooms`);
    expect(response.status).toBe(401);
  });
});

describe('rooms', () => {
  it('lets a second person join by invite code, and keeps strangers out', async () => {
    const angel = await Person.register(server, 'angel-r');
    const dylan = await Person.register(server, 'dylan-r');
    const stranger = await Person.register(server, 'stranger-r');

    const room = await angel.createRoom('capstone');
    expect(room.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Invite codes are forgiving about case and whitespace.
    const joined = await dylan.joinRoom(`  ${room.inviteCode.toLowerCase()} `);
    expect(joined.id).toBe(room.id);

    const snapshot = await dylan.request('GET', `/api/rooms/${room.id}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.members.map((m: { username: string }) => m.username)).toEqual(['angel-r', 'dylan-r']);

    // A non-member gets the same 404 as for a room that doesn't exist.
    expect((await stranger.request('GET', `/api/rooms/${room.id}`)).status).toBe(404);
    expect((await stranger.request('POST', `/api/rooms/${room.id}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await stranger.request('POST', '/api/rooms/join', { inviteCode: 'ZZZZ-ZZZZ' })).status).toBe(404);

    const list = await dylan.request('GET', '/api/rooms');
    expect(list.json.rooms).toHaveLength(1);
    expect(list.json.rooms[0]).toMatchObject({ name: 'capstone', memberCount: 2, agentCount: 0 });
  });

  it('people can post, ask, answer, and pin from the dashboard', async () => {
    const angel = await Person.register(server, 'angel-m', 'Angel');
    const room = await angel.createRoom('feed');
    const base = `/api/rooms/${room.id}/messages`;

    const note = await angel.request('POST', base, { body: 'kicking off' });
    expect(note.status).toBe(201);
    expect(note.json.message).toMatchObject({ kind: 'note', authorKind: 'human', authorName: 'Angel' });

    const question = (await angel.request('POST', base, { kind: 'question', body: 'REST or tRPC?' })).json.message;
    expect(question.resolvedAt).toBeNull();

    await angel.request('POST', base, { kind: 'answer', body: 'REST', replyTo: question.id });
    const decision = (await angel.request('POST', base, { kind: 'decision', title: 'REST', body: 'Plain REST + zod.' })).json.message;
    expect(decision.pinned).toBe(true);

    let snapshot = (await angel.request('GET', `/api/rooms/${room.id}`)).json;
    expect(snapshot.openQuestions).toHaveLength(0); // answering resolved it
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(4);

    // Unpin the decision, reopen the question.
    await angel.request('PATCH', `${base}/${decision.id}`, { pinned: false });
    await angel.request('PATCH', `${base}/${question.id}`, { resolved: false });
    snapshot = (await angel.request('GET', `/api/rooms/${room.id}`)).json;
    expect(snapshot.decisions).toHaveLength(0);
    expect(snapshot.openQuestions).toHaveLength(1);

    // Guard rails.
    expect((await angel.request('PATCH', `${base}/${note.json.message.id}`, { pinned: true })).status).toBe(400);
    expect((await angel.request('POST', base, { kind: 'answer', body: 'to nothing', replyTo: 999_999 })).status).toBe(404);
    expect((await angel.request('POST', base, { body: '   ' })).status).toBe(400);
  });

  it('only the person who connected an agent can disconnect it', async () => {
    const angel = await Person.register(server, 'angel-a');
    const dylan = await Person.register(server, 'dylan-a');
    const room = await angel.createRoom('agents');
    await dylan.joinRoom(room.inviteCode);

    const created = await angel.connectAgent(room.id, "Angel's Claude");
    expect(created.token).toMatch(/^tdm_/);
    expect(created.mcpUrl).toBe(`${server.baseUrl}/mcp`);
    // The token itself is never part of the agent record that gets broadcast.
    expect(JSON.stringify(created.agent)).not.toContain(created.token);

    const path = `/api/rooms/${room.id}/agents/${created.agent.id}`;
    expect((await dylan.request('DELETE', path)).status).toBe(403);
    expect((await angel.request('DELETE', path)).status).toBe(200);
    expect((await angel.request('GET', `/api/rooms/${room.id}`)).json.agents).toHaveLength(0);
  });
});

describe('logging', () => {
  it('redacts agent tokens that appear in URLs', () => {
    expect(redactUrl('/mcp/t/tdm_supersecret')).toBe('/mcp/t/[redacted]');
    expect(redactUrl('/mcp/t/tdm_supersecret?x=1')).toBe('/mcp/t/[redacted]?x=1');
    expect(redactUrl('/api/rooms')).toBe('/api/rooms');
  });
});
