import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CreatedAgentDTO } from '../../../shared/types';
import { api, ApiFailure } from '../api';
import { Glyph } from './Brand';
import { CopyBlock } from './Copy';

type Tab = 'quick' | 'manual' | 'connector';

const TABS: { id: Tab; label: string }[] = [
  { id: 'quick', label: 'Claude Code' },
  { id: 'manual', label: 'manual' },
  { id: 'connector', label: 'desktop or web app' },
];

function Instructions({ created }: { created: CreatedAgentDTO }) {
  const [tab, setTab] = useState<Tab>('quick');
  const base = created.mcpUrl.replace(/\/mcp$/, '');
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(base);

  const setupCommand = `curl -fsSL ${base}/setup.js | node - ${created.token}`;
  const addCommand = `claude mcp add --transport http tandem ${created.mcpUrl} --header "Authorization: Bearer ${created.token}"`;
  const connectorUrl = `${created.mcpUrl}/t/${created.token}`;

  return (
    <>
      <p className="dialog-warning">
        Copy what you need now. The token inside these is shown once; if you lose it, disconnect this Claude and connect
        it again.
      </p>

      <div className="tabs-bar tabs-bar-flat" role="tablist">
        {TABS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'quick' && (
        <div className="tab-panel">
          <p>Run this once in a terminal, inside your project folder:</p>
          <CopyBlock text={setupCommand} label="One-command setup for Claude Code" />
          <ul className="setup-list">
            <li>adds the tandem tools to Claude Code</li>
            <li>tells Claude about new room messages on every prompt</li>
            <li>blocks edits to files your teammate's Claude holds, and claims files as yours edits them</li>
            <li>sets this pane to idle when you close the session</li>
          </ul>
          <p>
            Then start <code>claude</code> and say <em>“catch up with the tandem room.”</em> On Windows PowerShell, type{' '}
            <code>curl.exe</code> instead of <code>curl</code>.
          </p>
        </div>
      )}

      {tab === 'manual' && (
        <div className="tab-panel">
          <p>
            Adds only the tools, with no hooks. Claude will see the room when you ask it to, and file claims won't be
            enforced.
          </p>
          <CopyBlock text={addCommand} label="Command that adds Tandem to Claude Code" />
        </div>
      )}

      {tab === 'connector' && (
        <div className="tab-panel">
          <p>
            For chatting with the room from Claude's desktop or web app (it can't edit your code from there). Add a custom
            connector in Claude's settings and paste this as its URL:
          </p>
          <CopyBlock text={connectorUrl} label="Connector URL" />
          <p>
            Treat this URL like a password: anyone who has it can post as {created.agent.name}.
            {local && ' It only works once this server is on a public https address. Localhost is not reachable from Claude’s apps.'}
          </p>
        </div>
      )}
    </>
  );
}

interface Props {
  roomId: string;
  suggestedName: string;
  onClose: () => void;
}

export function ConnectDialog({ roomId, suggestedName, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(suggestedName);
  const [created, setCreated] = useState<CreatedAgentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createAgent(roomId, name.trim()));
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'Could not connect. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="connect-title">
      <h2 id="connect-title" className="dialog-title">
        {created && <Glyph hue={created.agent.hue} />}
        {created ? `Connect ${created.agent.name}` : 'Connect a Claude'}
      </h2>

      {created ? (
        <>
          <Instructions created={created} />
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={() => dialog.current?.close()}>
              done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={create}>
          <p>
            Each Claude you connect gets its own pane, colour and symbol in this room. Connect one per app you use: your
            teammate connects theirs from their own account.
          </p>
          <label className="field">
            <span>Name for this Claude</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
            <small>Other agents and your teammate see this name.</small>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={() => dialog.current?.close()}>
              cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              connect
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
