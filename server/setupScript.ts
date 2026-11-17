/**
 * The one-command setup, served at GET /setup.js and run as:
 *
 *   curl -fsSL https://your-tandem/setup.js | node - tdm_yourtoken
 *
 * It runs on the developer's machine, inside their project folder, and does
 * what used to be three manual steps: registers the MCP server with Claude
 * Code, installs the hooks, and keeps the token out of git.
 *
 * The hooks it installs are deliberately dumb pipes: each one forwards Claude
 * Code's hook payload to this server with curl and prints whatever comes
 * back. All the logic (is this file claimed? is there news?) lives on the
 * server, so improving a hook never means re-running setup on two laptops.
 *
 * Written as plain CommonJS with no template literals so it can be embedded
 * here verbatim and piped straight into `node -`.
 */
const SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const BASE = __BASE__;
const token = process.argv[2];

function fail(message) {
  console.error('\n  tandem setup failed: ' + message + '\n');
  process.exit(1);
}

function run(command, args) {
  const windows = process.platform === 'win32';
  const quoted = windows ? args.map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }) : args;
  return cp.spawnSync(command, quoted, { encoding: 'utf8', shell: windows });
}

async function main() {
  if (!token || !/^tdm_[A-Za-z0-9_-]+$/.test(token)) {
    fail('pass your agent token, like this:\n    curl -fsSL ' + BASE + '/setup.js | node - tdm_...');
  }

  // 1. Check the token before touching anything.
  let who;
  try {
    const res = await fetch(BASE + '/api/agent/whoami', { headers: { authorization: 'Bearer ' + token } });
    if (res.status === 401) fail('that token is not valid. Was this Claude disconnected? Connect it again from the room dashboard.');
    if (!res.ok) fail(BASE + ' answered ' + res.status);
    who = await res.json();
  } catch (error) {
    fail('cannot reach ' + BASE + ' (' + error.message + ')');
  }

  const cwd = process.cwd();
  let root = cwd;
  try {
    root = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || cwd;
  } catch (error) {
    // Not a git repository; paths will be relative to this folder.
  }
  root = root.replace(/\\/g, '/');

  // 2. Hooks, merged into .claude/settings.local.json (personal, never committed).
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      fail(settingsPath + ' is not valid JSON. Fix or remove it, then run this again.');
    }
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const isOurs = function (entry) {
    return JSON.stringify(entry).indexOf('/api/agent/hooks/') !== -1;
  };
  Object.keys(hooks).forEach(function (event) {
    if (Array.isArray(hooks[event])) hooks[event] = hooks[event].filter(function (entry) { return !isOurs(entry); });
  });

  // The project root travels in a header so both teammates' paths agree even
  // if one starts Claude in a subfolder. Skipped if it has characters a shell
  // could misread; the server then falls back to the session's own folder.
  const rootHeader = /^[\x20-\x7E]+$/.test(root) && !/["$\x60\\!%]/.test(root) ? ' -H "X-Tandem-Root: ' + root + '"' : '';
  const call = function (name) {
    return 'curl -sf -m 6 -X POST -H "Authorization: Bearer ' + token + '" -H "Content-Type: application/json"' +
      rootHeader + ' --data-binary @- "' + BASE + '/api/agent/hooks/' + name + '"';
  };
  const add = function (event, name, matcher) {
    const entry = { hooks: [{ type: 'command', command: call(name), timeout: 10 }] };
    if (matcher) entry.matcher = matcher;
    hooks[event] = (hooks[event] || []).concat([entry]);
  };
  add('SessionStart', 'session-start');
  add('UserPromptSubmit', 'prompt');
  add('PreToolUse', 'pre-edit', 'Edit|Write|MultiEdit|NotebookEdit');
  add('SessionEnd', 'session-end');
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // 3. Keep the token out of git without changing any tracked file.
  let ignored = false;
  const gitDir = path.join(cwd, '.git');
  try {
    if (fs.statSync(gitDir).isDirectory()) {
      const exclude = path.join(gitDir, 'info', 'exclude');
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (current.indexOf('.claude/settings.local.json') === -1) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '.claude/settings.local.json\n');
      }
      ignored = true;
    }
  } catch (error) {
    // No .git folder here; nothing to protect.
  }

  // 4. Register the MCP server with Claude Code.
  const addArgs = ['mcp', 'add', '--transport', 'http', 'tandem', BASE + '/mcp', '--header', 'Authorization: Bearer ' + token];
  run('claude', ['mcp', 'remove', 'tandem']);
  const added = run('claude', addArgs);
  const mcpOk = !added.error && added.status === 0;

  console.log('');
  console.log('  tandem: ' + who.agent + ' is set up for the room "' + who.room + '"');
  console.log('');
  if (mcpOk) {
    console.log('  [ok] added the tandem MCP server to Claude Code');
  } else {
    console.log('  [!!] could not run the claude command, so add the MCP server yourself:');
    console.log('       claude mcp add --transport http tandem ' + BASE + '/mcp --header "Authorization: Bearer ' + token + '"');
  }
  console.log('  [ok] installed hooks in .claude/settings.local.json');
  console.log('         - Claude is told about new room messages on every prompt');
  console.log('         - edits to files another Claude holds are blocked');
  console.log('         - files are claimed as Claude edits them, and released when the session ends');
  if (ignored) console.log('  [ok] kept that file out of git (.git/info/exclude)');
  console.log('');
  console.log('  next: start claude in this folder and say "catch up with the tandem room"');
  console.log('');
}

main().catch(function (error) { fail(error && error.message ? error.message : String(error)); });
`;

export function renderSetupScript(baseUrl: string): string {
  return SCRIPT.replace('__BASE__', JSON.stringify(baseUrl));
}
