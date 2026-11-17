import { useState, type FormEvent } from 'react';
import type { AgentDTO, TaskDTO, TaskStatus } from '../../../shared/types';
import { ago } from '../time';
import { Glyph } from './Brand';

interface Props {
  tasks: TaskDTO[];
  agents: AgentDTO[];
  now: number;
  onAdd: (title: string, detail: string) => Promise<void>;
  onPatch: (task: TaskDTO, patch: { status?: TaskStatus; assigneeAgentId?: string | null }) => void;
  onDelete: (task: TaskDTO) => void;
}

const COLUMNS: { status: TaskStatus; label: string; empty: string }[] = [
  { status: 'todo', label: 'todo', empty: 'nothing waiting' },
  { status: 'doing', label: 'doing', empty: 'nobody is on a task' },
  { status: 'done', label: 'done', empty: 'nothing finished yet' },
];

function TaskCard({ task, agents, now, onPatch, onDelete }: { task: TaskDTO } & Omit<Props, 'tasks' | 'onAdd'>) {
  const assignee = agents.find((a) => a.id === task.assigneeAgentId);

  return (
    <li className="task" data-hue={assignee?.hue} data-status={task.status}>
      <div className="task-head">
        <span className="task-id">T{task.id}</span>
        <span className="task-title">{task.title}</span>
      </div>
      {task.detail && <p className="task-detail">{task.detail}</p>}

      {task.status === 'doing' && (
        <p className="task-owner">
          {assignee ? (
            <>
              <Glyph hue={assignee.hue} /> {assignee.name}
            </>
          ) : (
            'a person'
          )}
          <span className="pane-dim"> since {ago(task.updatedAt, now)}</span>
        </p>
      )}
      {task.status === 'done' && (
        <>
          {task.result && <p className="task-result">{task.result}</p>}
          <p className="pane-dim">
            {assignee ? `${assignee.name}, ` : ''}
            {ago(task.completedAt, now)}
          </p>
        </>
      )}

      <div className="task-actions">
        {task.status === 'todo' && agents.length > 0 && (
          <label className="task-assign">
            <span>give to</span>
            <select
              value=""
              aria-label={`Assign T${task.id} to an agent`}
              onChange={(event) => event.target.value && onPatch(task, { assigneeAgentId: event.target.value })}
            >
              <option value="">…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {task.status === 'doing' && (
          <>
            <button type="button" className="link" onClick={() => onPatch(task, { status: 'done' })}>
              mark done
            </button>
            <button type="button" className="link" onClick={() => onPatch(task, { status: 'todo' })}>
              put back
            </button>
          </>
        )}
        {task.status === 'done' && (
          <button type="button" className="link" onClick={() => onPatch(task, { status: 'todo' })}>
            reopen
          </button>
        )}
        {task.status === 'todo' && (
          <button type="button" className="link" onClick={() => onPatch(task, { status: 'done' })}>
            mark done
          </button>
        )}
        <button
          type="button"
          className="link link-danger"
          onClick={() => window.confirm(`Delete T${task.id} "${task.title}"? This can't be undone.`) && onDelete(task)}
        >
          delete
        </button>
      </div>
    </li>
  );
}

/**
 * The shared plan. You add tasks here (or a Claude does); a Claude takes one
 * when asked "what's next?", and the board shows who is on what.
 */
export function TaskBoard({ tasks, agents, now, onAdd, onPatch, onDelete }: Props) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(title.trim(), detail.trim());
      setTitle('');
      setDetail('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not add the task. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="board-scroll">
      <form className="task-add" onSubmit={submit}>
        <div className="task-add-row">
          <span className="composer-prompt" aria-hidden="true">
            +
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="add a task, written as an outcome"
            aria-label="Task title"
            maxLength={140}
          />
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            add task
          </button>
        </div>
        {title.trim() && (
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="optional: what done looks like, which files, anything a Claude needs to start cold"
            aria-label="Task detail"
            rows={2}
            maxLength={2000}
          />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>

      {tasks.length === 0 ? (
        <div className="feed-empty">
          <p className="feed-empty-title">no tasks yet</p>
          <p>
            Add the things you want built. Then tell your Claude “take the next task from the tandem board”. It claims
            one, so your teammate's Claude won't start the same work, and reports back here when it's done.
          </p>
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map(({ status, label, empty }) => {
            const column = tasks.filter((t) => t.status === status);
            return (
              <section key={status} className="board-col" aria-label={label}>
                <h2>
                  {label} <span className="tab-count">{column.length}</span>
                </h2>
                {column.length === 0 ? (
                  <p className="board-empty">{empty}</p>
                ) : (
                  <ul>
                    {column.map((task) => (
                      <TaskCard key={task.id} task={task} agents={agents} now={now} onPatch={onPatch} onDelete={onDelete} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
