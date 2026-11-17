/**
 * Fills a room with a realistic exchange between two agents, so you can see
 * the dashboard working before you connect a real Claude.
 *
 *   npm run demo                       # against http://localhost:8787
 *   npm run demo -- https://your.host  # against a deployed server
 *
 * It signs up two demo people, connects a Claude for each over real MCP, and
 * plays out a short session. Sign in as  demo-angel / tandem-demo  to watch.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '');
const PASSWORD = 'tandem-demo';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function person(username: string, displayName: string) {
  const send = (path: string, body: unknown, cookie?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  let response = await send('/api/auth/register', { username, displayName, password: PASSWORD });
  if (response.status === 409) response = await send('/api/auth/login', { username, password: PASSWORD });
  if (!response.ok) throw new Error(`Could not sign in as ${username}: ${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
  const call = (method: string) => async (path: string, body: unknown) => {
    const result = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!result.ok) throw new Error(`${path}: ${result.status} ${await result.text()}`);
    return result.json() as Promise<any>;
  };
  return { post: call('POST'), patch: call('PATCH') };
}

async function claude(token: string) {
  const client = new Client({ name: 'tandem-demo', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
    console.log(`  ${name} → ${text.split('\n')[0]}`);
    await pause(400);
    return text;
  };
}

const angel = await person('demo-angel', 'Angel');
const dylan = await person('demo-dylan', 'Dylan');

const { room } = await angel.post('/api/rooms', { name: 'capstone-api' });
await dylan.post('/api/rooms/join', { inviteCode: room.inviteCode });
const a = await angel.post(`/api/rooms/${room.id}/agents`, { name: "Angel's Claude" });
const d = await dylan.post(`/api/rooms/${room.id}/agents`, { name: "Dylan's Claude" });
const angelClaude = await claude(a.token);
const dylanClaude = await claude(d.token);

/** Stand in for the Claude Code edit hook: "this agent is about to edit this file". */
const edits = (token: string, file: string) =>
  fetch(`${base}/api/agent/hooks/pre-edit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tandem-root': '/repo' },
    body: JSON.stringify({ cwd: '/repo', tool_name: 'Edit', tool_input: { file_path: `/repo/${file}` } }),
  });

await angel.patch(`/api/rooms/${room.id}`, {
  brief:
    'What this is: order management API + dashboard for our capstone.\n\nStack: Fastify, Postgres (Drizzle), React + Vite.\n\nRun: `npm run dev`. Test: `npm test`.\n\nRules: one migration per feature branch. Never push to main; open a PR.',
});
const pagination = (await angel.post(`/api/rooms/${room.id}/tasks`, {
  title: 'Cursor pagination on GET /orders',
  detail: 'Replace ?page= with ?cursor=. Return { items, nextCursor }.',
})).task;
const table = (await dylan.post(`/api/rooms/${room.id}/tasks`, { title: 'Orders table in the dashboard' })).task;
await angel.post(`/api/rooms/${room.id}/tasks`, { title: 'Seed script with 20 test orders' });
await dylan.post(`/api/rooms/${room.id}/tasks`, { title: 'Empty state for the orders page' });

console.log(`\nRoom ready: ${base}/r/${room.id}\nSign in as demo-angel / ${PASSWORD}\n`);

await angelClaude('catch_up');
await angelClaude('take_task', { task_id: pagination.id });
await angelClaude('claim_files', { paths: ['migrations/'], note: 'orders pagination' });
await edits(a.token, 'src/api/orders.ts');
await edits(a.token, 'src/api/cursor.ts');
await angelClaude('log_decision', {
  title: 'API fields are camelCase',
  detail: 'Convert at the database boundary. Responses never expose snake_case column names.',
});

await dylanClaude('catch_up');
await dylanClaude('take_task', { task_id: table.id });
await edits(d.token, 'web/src/pages/Orders.tsx');
const blocked = await (await edits(d.token, 'src/api/orders.ts')).json();
console.log(`  edit hook → ${blocked.hookSpecificOutput.permissionDecision}: ${blocked.hookSpecificOutput.permissionDecisionReason.slice(0, 80)}…`);
const asked = await dylanClaude('ask_peer', {
  question: 'What does the paginated response look like? I need the shape to type the table in `Orders.tsx`.',
  to: "Angel's Claude",
});
const questionId = Number(/#(\d+)/.exec(asked)![1]);

await angelClaude('catch_up');
await angelClaude('answer_question', {
  question_id: questionId,
  answer: '`{ items: Order[], nextCursor: string | null }`. Pass `?cursor=` back to get the next page; `null` means you are at the end.',
});
await angelClaude('post_message', {
  text: 'Heads up: `GET /orders` no longer accepts `?page=`. Old callers get a 400 with a message pointing at `cursor`.',
});

await dylan.post(`/api/rooms/${room.id}/messages`, {
  kind: 'question',
  body: 'Can one of you add a seed script so we both have the same test orders?',
});

await dylanClaude('catch_up');
await dylanClaude('set_status', { state: 'blocked', task: 'Waiting for the pagination branch to merge before wiring the table' });
await angelClaude('complete_task', {
  task_id: pagination.id,
  summary: 'Cursor pagination is in. `GET /orders?cursor=` returns `{ items, nextCursor }`. Migration 0007 adds the index.',
});
await angelClaude('post_message', {
  kind: 'handoff',
  text: 'Stopping for today. Done: cursor pagination + migration 0007. Left: the 400 for `?page=` has no test yet. Branch `orders-pagination` is pushed.',
});

console.log('\nDone. Open the room to see the result.');
process.exit(0);
