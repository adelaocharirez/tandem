import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedAgentDTO, RoomDTO } from '../shared/types';
import { repoRelative } from '../server/lib/paths';
import { call, connectMcp, Person, startTestServer, type TestServer } from './helpers';

/**
 * The "hub" features: the task board, the project brief, read markers,
 * invite-only signup, and the Claude Code hooks (driven here by posting the
 * same JSON payloads Claude Code sends).
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
  room = await angel.createRoom('hub');
  await dylan.joinRoom(room.inviteCode);
  angelAgent = await angel.connectAgent(room.id, "Angel's Claude");
  dylanAgent = await dylan.connectAgent(room.id, "Dylan's Claude");
  angelClaude = await connectMcp(server, angelAgent.token);
  dylanClaude = await connectMcp(server, dylanAgent.token);
});

afterAll(async () => {
  await angelClaude?.close();
  await dylanClaude?.close();
  await server.close();
});

/**
 * Run a child process without blocking the event loop. The children here call
 * back into the test server, which lives in this same process, so a
 * synchronous spawn would deadlock.
 */
function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

const snapshot = async (who: Person = angel) => (await who.request('GET', `/api/rooms/${room.id}`)).json;

/** Post a Claude Code hook payload the way the installed curl hook does. */
async function hook(name: string, token: string, payload: unknown, root?: string) {
  const response = await fetch(`${server.baseUrl}/api/agent/hooks/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(root ? { 'x-tandem-root': root } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const editPayload = (file: string, cwd = '/home/angel/capstone') => ({
  session_id: 's1',
  cwd,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
});

describe('task board', () => {
  let seedTask: number;

  it('people add tasks and both Claudes see them', async () => {
    const created = await angel.request('POST', `/api/rooms/${room.id}/tasks`, {
      title: 'Seed script creates 20 test orders',
      detail: 'Put it in scripts/seed.ts',
    });
    expect(created.status).toBe(201);
    seedTask = created.json.task.id;
    expect(created.json.task).toMatchObject({ status: 'todo', assigneeAgentId: null, createdByName: 'Angel' });

    const board = await call(dylanClaude, 'list_tasks');
    expect(board.text).toContain(`T${seedTask} [todo] Seed script creates 20 test orders`);
    expect(board.text).toContain('Up for grabs');
    expect((await call(dylanClaude, 'catch_up')).text).toContain('## Task board');
  });

  it('taking a task marks it, sets status, and locks the other Claude out', async () => {
    const taken = await call(dylanClaude, 'take_task', { task_id: seedTask });
    expect(taken.isError).toBe(false);
    expect(taken.text).toContain(`T${seedTask} is yours`);

    const state = await snapshot();
    const task = state.tasks.find((t: { id: number }) => t.id === seedTask);
    expect(task).toMatchObject({ status: 'doing', assigneeAgentId: dylanAgent.agent.id });
    const desk = state.agents.find((a: { id: string }) => a.id === dylanAgent.agent.id);
    expect(desk).toMatchObject({ state: 'working', task: `T${seedTask}: Seed script creates 20 test orders` });
    expect(state.messages.at(-1)).toMatchObject({ kind: 'task', body: `Took T${seedTask}: Seed script creates 20 test orders` });

    const second = await call(angelClaude, 'take_task', { task_id: seedTask });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("already being done by Dylan's Claude");
    const finish = await call(angelClaude, 'complete_task', { task_id: seedTask, summary: 'not mine' });
    expect(finish.isError).toBe(true);

    expect((await call(angelClaude, 'list_tasks')).text).toContain('Being done by someone else');
  });

  it('finishing posts the summary to the log; dropping puts a task back', async () => {
    const done = await call(dylanClaude, 'complete_task', { task_id: seedTask, summary: 'Added scripts/seed.ts; run `npm run seed`.' });
    expect(done.isError).toBe(false);

    let state = await snapshot();
    expect(state.tasks.find((t: { id: number }) => t.id === seedTask)).toMatchObject({ status: 'done', result: 'Added scripts/seed.ts; run `npm run seed`.' });
    expect(state.messages.at(-1)).toMatchObject({ kind: 'task', title: `Finished T${seedTask}: Seed script creates 20 test orders` });
    // The other Claude hears about it on its next catch-up.
    expect((await call(angelClaude, 'catch_up')).text).toContain(`Finished T${seedTask}`);

    const added = await call(angelClaude, 'add_task', { title: 'Test the 400 on ?page=' });
    const id = Number(/T(\d+)/.exec(added.text)![1]);
    await call(angelClaude, 'take_task', { task_id: id });
    const dropped = await call(angelClaude, 'drop_task', { task_id: id, reason: 'Blocked on the pagination merge.' });
    expect(dropped.text).toContain('back on the board');
    state = await snapshot();
    expect(state.tasks.find((t: { id: number }) => t.id === id)).toMatchObject({ status: 'todo', assigneeAgentId: null });
    expect((await call(dylanClaude, 'drop_task', { task_id: id, reason: 'x' })).isError).toBe(true);
  });

  it('people can assign, move and delete tasks from the dashboard', async () => {
    const { task } = (await angel.request('POST', `/api/rooms/${room.id}/tasks`, { title: 'Write the README' })).json;
    const base = `/api/rooms/${room.id}/tasks/${task.id}`;

    // Assigning a waiting task starts it.
    let patched = (await angel.request('PATCH', base, { assigneeAgentId: angelAgent.agent.id })).json.task;
    expect(patched).toMatchObject({ status: 'doing', assigneeAgentId: angelAgent.agent.id });
    patched = (await dylan.request('PATCH', base, { status: 'done' })).json.task;
    expect(patched.completedAt).not.toBeNull();
    // Reopening clears the owner.
    patched = (await dylan.request('PATCH', base, { status: 'todo' })).json.task;
    expect(patched).toMatchObject({ status: 'todo', assigneeAgentId: null, completedAt: null });

    expect((await angel.request('DELETE', base)).status).toBe(200);
    expect((await snapshot()).tasks.some((t: { id: number }) => t.id === task.id)).toBe(false);

    const outsider = await Person.register(server, 'task-outsider');
    expect((await outsider.request('POST', `/api/rooms/${room.id}/tasks`, { title: 'nope' })).status).toBe(404);
  });
});

describe('project brief', () => {
  it('is editable by members and handed to every Claude', async () => {
    const brief = 'Stack: Fastify + React. Run tests with `npm test`. Never commit to main directly.';
    const patched = await angel.request('PATCH', `/api/rooms/${room.id}`, { brief, name: 'hub-renamed' });
    expect(patched.json.room).toMatchObject({ brief, name: 'hub-renamed' });

    const caught = await call(dylanClaude, 'catch_up');
    expect(caught.text).toContain('## Project brief');
    expect(caught.text).toContain('Never commit to main directly.');
    expect(caught.text).toContain('Tandem room "hub-renamed"');
  });
});

describe('read markers', () => {
  it('tracks what each person has seen and counts the rest as unread', async () => {
    const before = (await dylan.request('GET', '/api/rooms')).json.rooms[0];
    expect(before.unread).toBeGreaterThan(0);
    expect(before.openTasks).toBeGreaterThan(0);
    expect(before.activeAgents).toBe(2);

    const latest = (await snapshot(dylan)).messages.at(-1).id;
    await dylan.request('POST', `/api/rooms/${room.id}/read`, { messageId: latest });
    expect((await dylan.request('GET', '/api/rooms')).json.rooms[0].unread).toBe(0);
    expect((await snapshot(dylan)).lastReadMessageId).toBe(latest);

    // Your own dashboard message is never unread for you, but is for your teammate.
    await dylan.request('POST', `/api/rooms/${room.id}/messages`, { body: 'brb' });
    expect((await dylan.request('GET', '/api/rooms')).json.rooms[0].unread).toBe(0);
    expect((await angel.request('GET', '/api/rooms')).json.rooms[0].unread).toBeGreaterThan(0);

    // The marker never moves backwards.
    await dylan.request('POST', `/api/rooms/${room.id}/read`, { messageId: 1 });
    expect((await snapshot(dylan)).lastReadMessageId).toBe(latest);
  });
});

describe('Claude Code hooks', () => {
  const root = '/home/angel/capstone';

  it('claims a file automatically the first time a Claude edits it', async () => {
    const first = await hook('pre-edit', angelAgent.token, editPayload(`${root}/src/api/orders.ts`), root);
    expect(first.status).toBe(204);

    const claims = (await snapshot()).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ path: 'src/api/orders.ts', agentId: angelAgent.agent.id, auto: true });

    // Editing it again renews the claim rather than adding another.
    await hook('pre-edit', angelAgent.token, editPayload(`${root}/src/api/orders.ts`), root);
    expect((await snapshot()).claims).toHaveLength(1);
  });

  it("blocks the other Claude's edit with a reason it can act on", async () => {
    // Dylan's machine has the repo somewhere else entirely; the relative path is what matters.
    const dylanRoot = 'C:/Users/dylan/code/capstone';
    const blocked = await hook('pre-edit', dylanAgent.token, editPayload('C:\\Users\\Dylan\\code\\capstone\\src\\api\\orders.ts', dylanRoot), dylanRoot);
    expect(blocked.status).toBe(200);
    expect(blocked.json.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(blocked.json.hookSpecificOutput.permissionDecisionReason).toContain("src/api/orders.ts is claimed by Angel's Claude");
    expect(blocked.json.hookSpecificOutput.permissionDecisionReason).toContain('ask_peer');

    // A different file is fine, and gets claimed for Dylan's Claude.
    const allowed = await hook('pre-edit', dylanAgent.token, editPayload('C:\\Users\\Dylan\\code\\capstone\\web\\App.tsx', dylanRoot), dylanRoot);
    expect(allowed.status).toBe(204);
    expect((await snapshot()).claims.map((c: { path: string }) => c.path).sort()).toEqual(['src/api/orders.ts', 'web/App.tsx']);
  });

  it('respects deliberate folder claims and ignores files outside the project', async () => {
    await call(dylanClaude, 'claim_files', { paths: ['migrations/'], note: 'adding role column' });
    const blocked = await hook('pre-edit', angelAgent.token, editPayload(`${root}/migrations/0008_role.sql`), root);
    expect(blocked.json.hookSpecificOutput.permissionDecisionReason).toContain('their claim covers migrations');
    expect(blocked.json.hookSpecificOutput.permissionDecisionReason).toContain('adding role column');

    // Dylan's own edits inside his folder claim don't pile up extra claims.
    const before = (await snapshot()).claims.length;
    await hook('pre-edit', dylanAgent.token, editPayload('/repo/migrations/0008_role.sql', '/repo'));
    expect((await snapshot()).claims).toHaveLength(before);

    // Outside the repo, or no path at all: not our business, never blocked.
    expect((await hook('pre-edit', angelAgent.token, editPayload('/tmp/scratch.txt'), root)).status).toBe(204);
    expect((await hook('pre-edit', angelAgent.token, { cwd: root, tool_name: 'Edit', tool_input: {} }, root)).status).toBe(204);
    expect((await snapshot()).claims).toHaveLength(before);
  });

  it('falls back to the session folder when no project root is sent', async () => {
    const res = await hook('pre-edit', angelAgent.token, { ...editPayload(`${root}/docs/api.md`), tool_name: 'Write' });
    expect(res.status).toBe(204);
    expect((await snapshot()).claims.some((c: { path: string }) => c.path === 'docs/api.md')).toBe(true);
  });

  it('tells a Claude about news on its next prompt, once', async () => {
    await call(dylanClaude, 'catch_up');
    expect((await hook('prompt', dylanAgent.token, { prompt: 'hi' })).status).toBe(204);

    await call(angelClaude, 'post_message', { text: 'Rebased onto main, pull before you continue.' });
    const news = await hook('prompt', dylanAgent.token, { prompt: 'continue' });
    expect(news.json.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(news.json.hookSpecificOutput.additionalContext).toContain('Rebased onto main');
    expect((await hook('prompt', dylanAgent.token, { prompt: 'again' })).status).toBe(204);
  });

  it('briefs a new session without marking anything read', async () => {
    const { task } = (await angel.request('POST', `/api/rooms/${room.id}/tasks`, { title: 'Wire the orders table' })).json;
    await call(dylanClaude, 'take_task', { task_id: task.id });
    await call(angelClaude, 'post_message', { text: 'One more thing for later.' });

    const start = await hook('session-start', dylanAgent.token, { source: 'startup' });
    const context: string = start.json.hookSpecificOutput.additionalContext;
    expect(start.json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain('You are "Dylan\'s Claude"');
    expect(context).toContain('Never commit to main directly.'); // the brief
    expect(context).toContain(`T${task.id} Wire the orders table`);
    expect(context).toContain('unread message');
    // Still unread afterwards.
    expect((await call(dylanClaude, 'catch_up')).text).toContain('One more thing for later.');
  });

  it('ending a session idles the desk and drops automatic claims, but keeps deliberate ones', async () => {
    await call(dylanClaude, 'set_status', { state: 'working', task: 'something' });
    expect((await hook('session-end', dylanAgent.token, { reason: 'clear' })).status).toBe(204);
    let state = await snapshot();
    expect(state.agents.find((a: { id: string }) => a.id === dylanAgent.agent.id).state).toBe('working'); // /clear isn't leaving

    await hook('session-end', dylanAgent.token, { reason: 'prompt_input_exit' });
    state = await snapshot();
    expect(state.agents.find((a: { id: string }) => a.id === dylanAgent.agent.id)).toMatchObject({ state: 'idle', task: null });
    const dylans = state.claims.filter((c: { agentId: string }) => c.agentId === dylanAgent.agent.id);
    expect(dylans.map((c: { path: string }) => c.path)).toEqual(['migrations']);
  });

  it('rejects hook calls without a valid token', async () => {
    expect((await hook('pre-edit', 'tdm_nope', editPayload('/x/y.ts'))).status).toBe(401);
    expect((await hook('session-start', 'tdm_nope', {})).status).toBe(401);
  });
});

describe('repoRelative', () => {
  it('maps absolute paths from either OS onto repo-relative ones', () => {
    expect(repoRelative('/home/a/proj', '/home/a/proj/src/x.ts')).toBe('src/x.ts');
    expect(repoRelative('/home/a/proj/', '/home/a/proj/x.ts')).toBe('x.ts');
    expect(repoRelative('C:/Users/A/proj', 'c:\\users\\a\\proj\\src\\x.ts')).toBe('src/x.ts');
    expect(repoRelative('/home/a/proj', '/home/a/project2/x.ts')).toBeNull();
    expect(repoRelative('/home/a/proj', '/etc/hosts')).toBeNull();
    expect(repoRelative(undefined, '/home/a/proj/x.ts')).toBeNull();
    expect(repoRelative('/home/a/proj', 'src/x.ts')).toBe('src/x.ts');
    expect(repoRelative('/home/a/proj', '../other/x.ts')).toBeNull();
  });
});

describe('one-command setup script', () => {
  it('installs hooks, registers the MCP server, and keeps the token out of git', async () => {
    const script = await (await fetch(`${server.baseUrl}/setup.js`)).text();
    expect(script).toContain(JSON.stringify(server.baseUrl));

    // A throwaway project with existing settings that must survive, and a fake `claude` on PATH.
    const project = mkdtempSync(path.join(tmpdir(), 'tandem-setup-'));
    execFileSync('git', ['init', '-q'], { cwd: project });
    mkdirSync(path.join(project, '.claude'));
    const settingsFile = path.join(project, '.claude', 'settings.local.json');
    writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    );
    const bin = mkdtempSync(path.join(tmpdir(), 'tandem-bin-'));
    const log = path.join(bin, 'calls.log');
    writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);

    const runSetup = () =>
      runProcess('node', ['-', angelAgent.token], {
        cwd: project,
        input: script,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });

    const first = await runSetup();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`Angel's Claude is set up for the room "hub-renamed"`);
    expect(first.stdout).toContain('[ok] added the tandem MCP server');

    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('mcp remove tandem');
    expect(calls).toContain(`mcp add --transport http tandem ${server.baseUrl}/mcp --header Authorization: Bearer ${angelAgent.token}`);

    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    expect(settings.hooks.PreToolUse).toHaveLength(2); // theirs + ours
    const ours = settings.hooks.PreToolUse[1];
    expect(ours.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(ours.hooks[0].command).toContain(`${server.baseUrl}/api/agent/hooks/pre-edit`);
    expect(ours.hooks[0].command).toContain('X-Tandem-Root:');
    expect(readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/settings.local.json');

    // Running it again replaces our hooks instead of stacking them.
    expect((await runSetup()).status).toBe(0);
    const again = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(again.hooks.PreToolUse).toHaveLength(2);
    expect(again.hooks.SessionStart).toHaveLength(1);

    // The installed hook command really works: pipe a payload through it, as Claude Code would.
    await call(dylanClaude, 'claim_files', { paths: ['locked.ts'] });
    const realRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project }).toString().trim();
    const piped = await runProcess('sh', ['-c', ours.hooks[0].command], {
      input: JSON.stringify(editPayload(path.join(realRoot, 'locked.ts'), realRoot)),
    });
    expect(piped.status).toBe(0);
    expect(JSON.parse(piped.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('refuses a bad token before changing anything', async () => {
    const script = await (await fetch(`${server.baseUrl}/setup.js`)).text();
    const project = mkdtempSync(path.join(tmpdir(), 'tandem-setup-bad-'));
    const result = await runProcess('node', ['-', 'tdm_not_real'], { cwd: project, input: script });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('that token is not valid');
    expect(() => readFileSync(path.join(project, '.claude', 'settings.local.json'))).toThrow();
  });
});

describe('invite-only signup', () => {
  let locked: TestServer;
  beforeAll(async () => {
    locked = await startTestServer({ SIGNUP_MODE: 'invite' });
  });
  afterAll(() => locked.close());

  const config = async () => ((await (await fetch(`${locked.baseUrl}/api/auth/config`)).json()) as { signup: string }).signup;
  const tryRegister = (username: string, inviteCode?: string) =>
    fetch(`${locked.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct horse battery', inviteCode }),
    });

  it('gives the first account away, then requires a real room invite', async () => {
    expect(await config()).toBe('first');
    const owner = await Person.register(locked, 'owner');
    expect(await config()).toBe('invite');

    const noCode = await tryRegister('stranger');
    expect(noCode.status).toBe(403);
    expect(((await noCode.json()) as { error: string }).error).toContain('invite-only');
    expect((await tryRegister('guesser', 'ZZZZ-ZZZZ')).status).toBe(403);

    const invite = (await owner.createRoom('private')).inviteCode;
    const friend = await Person.register(locked, 'friend', 'Friend', invite.toLowerCase());
    expect((await friend.request('GET', '/api/auth/me')).status).toBe(200);
  });

  it('defaults to invite-only in production and open in development', async () => {
    const { loadConfig } = await import('../server/config');
    expect(loadConfig({ NODE_ENV: 'production' }).SIGNUP_MODE).toBe('invite');
    expect(loadConfig({ NODE_ENV: 'development' }).SIGNUP_MODE).toBe('open');
    expect(loadConfig({ NODE_ENV: 'production', SIGNUP_MODE: 'open' }).SIGNUP_MODE).toBe('open');
    expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://tandem.onrender.com' }).PUBLIC_URL).toBe('https://tandem.onrender.com');
  });
});
