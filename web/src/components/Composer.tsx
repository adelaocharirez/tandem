import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentDTO, MessageDTO } from '../../../shared/types';
import type { NewMessageInput } from '../api';

type Mode = 'note' | 'question' | 'decision';

const MODES: { id: Mode; label: string; action: string; placeholder: string }[] = [
  { id: 'note', label: 'note', action: 'post', placeholder: 'tell both claudes something' },
  { id: 'question', label: 'question', action: 'ask', placeholder: 'what do you need to know?' },
  { id: 'decision', label: 'decision', action: 'record', placeholder: 'the specifics, and why' },
];

interface Props {
  agents: AgentDTO[];
  /** Set when the person clicked "Answer" on a question. */
  answering: MessageDTO | null;
  onCancelAnswer: () => void;
  onSend: (input: NewMessageInput) => Promise<void>;
}

/** Where a person joins the conversation. Whatever they post reaches the Claudes on their next catch-up. */
export function Composer({ agents, answering, onCancelAnswer, onSend }: Props) {
  const [mode, setMode] = useState<Mode>('note');
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [toAgentId, setToAgentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (answering) textarea.current?.focus();
  }, [answering]);

  const current = MODES.find((m) => m.id === mode)!;
  const action = answering ? 'answer' : current.action;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (answering) await onSend({ kind: 'answer', body, replyTo: answering.id });
      else if (mode === 'question') await onSend({ kind: 'question', body, toAgentId: toAgentId || undefined });
      else if (mode === 'decision') await onSend({ kind: 'decision', body, title: title.trim() || undefined });
      else await onSend({ kind: 'note', body });
      setBody('');
      setTitle('');
      if (answering) onCancelAnswer();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {answering ? (
        <div className="composer-context">
          <span>
            answering {answering.authorName}: {answering.body.length > 90 ? `${answering.body.slice(0, 90)}…` : answering.body}
          </span>
          <button type="button" className="link" onClick={onCancelAnswer}>
            cancel
          </button>
        </div>
      ) : (
        <div className="composer-modes">
          <div className="segmented" role="radiogroup" aria-label="What are you posting?">
            {MODES.map(({ id, label }) => (
              <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'question' && agents.length > 0 && (
            <label className="composer-to">
              <span>ask</span>
              <select value={toAgentId} onChange={(e) => setToAgentId(e.target.value)}>
                <option value="">anyone</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {mode === 'decision' && !answering && (
        <input
          className="composer-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="the decision in a few words"
          aria-label="Decision title"
          maxLength={120}
          required
        />
      )}

      <div className="composer-row">
        <span className="composer-prompt" aria-hidden="true">
          &gt;
        </span>
        <textarea
          ref={textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={answering ? 'your answer' : current.placeholder}
          aria-label="Message"
          rows={2}
          maxLength={8000}
        />
        <button className="btn btn-primary" disabled={busy || !body.trim()}>
          {action}
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
