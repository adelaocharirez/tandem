import { useEffect, useState, type FormEvent } from 'react';
import type { RoomDTO } from '../../../shared/types';

interface Props {
  room: RoomDTO;
  onSave: (patch: { name: string; brief: string }) => Promise<void>;
}

const STARTER = `What this project is:

Stack:

How to run it / test it:

Repo:

Rules (branching, naming, things never to touch):
`;

/**
 * The project brief: the context both Claudes start every session with.
 * It's the difference between a Claude that knows your project and one that
 * has to be told the stack again every morning.
 */
export function Brief({ room, onSave }: Props) {
  const [name, setName] = useState(room.name);
  const [brief, setBrief] = useState(room.brief);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== room.name || brief !== room.brief;

  // If a teammate saves while this is open and untouched, show their version.
  useEffect(() => {
    if (!dirty) {
      setName(room.name);
      setBrief(room.brief);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.name, room.brief]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim() || room.name, brief });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="brief" onSubmit={submit}>
      <p className="brief-lede">
        Every Claude in this room reads the brief when it starts a session and each time it catches up. Write it once
        here instead of explaining the project to each Claude every day.
      </p>

      <label className="field">
        <span>room name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
      </label>

      <label className="field brief-field">
        <span>brief</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={STARTER}
          maxLength={20000}
          spellCheck={false}
        />
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="brief-actions">
        {!brief.trim() && (
          <button type="button" className="btn" onClick={() => setBrief(STARTER)}>
            start from a template
          </button>
        )}
        <span className="pane-dim" aria-live="polite">
          {saved ? 'saved' : dirty ? 'unsaved changes' : ''}
        </span>
        <button className="btn btn-primary" disabled={busy || !dirty}>
          save brief
        </button>
      </div>
    </form>
  );
}
