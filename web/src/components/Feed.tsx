import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AgentDTO, MessageDTO, UserDTO } from '../../../shared/types';
import { clockTime } from '../time';
import { Avatar } from './Brand';

export type FeedTab = 'all' | 'tasks' | 'questions' | 'decisions' | 'handoffs' | 'brief';
type MessageTab = Exclude<FeedTab, 'tasks' | 'brief'>;

const excerpt = (text: string, limit = 140) => {
  const plain = text.replace(/`/g, '');
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
};

/** `inline code` spans inside a run of plain text. React escapes everything else. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part,
  );
  return <>{parts}</>;
}

/** Message text: fenced ``` blocks become code blocks, the rest is plain text with inline code. */
function RichText({ text }: { text: string }) {
  const blocks = text.split(/```[\w-]*\n?([\s\S]*?)```/g);
  return (
    <>
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="codeblock">
            {block.replace(/\n$/, '')}
          </pre>
        ) : (
          <Inline key={index} text={index > 0 ? block.replace(/^\n/, '') : block} />
        ),
      )}
    </>
  );
}

interface ItemProps {
  message: MessageDTO;
  me: UserDTO;
  agents: Map<string, AgentDTO>;
  question?: MessageDTO;
  onAnswer: (question: MessageDTO) => void;
  onPatch: (message: MessageDTO, patch: { pinned?: boolean; resolved?: boolean }) => void;
}

/**
 * One line of the room log: time, who, what kind, then the text. Decisions
 * belong to everyone, so they're drawn as a boxed block instead.
 */
export function MessageItem({ message, agents, question, onAnswer, onPatch }: ItemProps) {
  let kind: string | null = null;
  if (message.kind === 'question') {
    const target = message.toAgentId ? (agents.get(message.toAgentId)?.name ?? 'an agent who left') : 'anyone';
    kind = `asks ${target}`;
  } else if (message.kind === 'answer') kind = `answers #${message.replyTo}`;
  else if (message.kind === 'decision') kind = 'decision';
  else if (message.kind === 'handoff') kind = 'handoff';
  else if (message.kind === 'task') kind = 'task';

  return (
    <li
      id={`m${message.id}`}
      className="line"
      data-hue={message.authorHue ?? undefined}
      data-kind={message.kind}
      data-human={message.authorKind === 'human'}
    >
      <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
      <div className="line-main">
        <div className="line-head">
          <span className="who">
            <Avatar hue={message.authorHue} name={message.authorName} />
            {message.authorName}
          </span>
          {kind && <span className="tag">{kind}</span>}
          {message.kind === 'question' && (
            <span className={message.resolvedAt ? 'chip chip-done' : 'chip chip-open'}>
              {message.resolvedAt ? 'answered' : 'open'}
            </span>
          )}
          <span className="line-id">#{message.id}</span>
        </div>

        {message.kind === 'answer' && question && (
          <a className="quote" href={`#m${question.id}`}>
            {question.authorName}: {excerpt(question.body)}
          </a>
        )}

        {message.title && <p className="line-title">{message.title}</p>}
        <div className="line-body">
          <RichText text={message.body} />
        </div>

        {message.kind === 'question' && (
          <div className="line-actions">
            {!message.resolvedAt && (
              <button type="button" className="link" onClick={() => onAnswer(message)}>
                answer
              </button>
            )}
            <button type="button" className="link" onClick={() => onPatch(message, { resolved: !message.resolvedAt })}>
              {message.resolvedAt ? 'reopen' : 'mark answered'}
            </button>
          </div>
        )}
        {message.kind === 'decision' && (
          <div className="line-actions">
            <button type="button" className="link" onClick={() => onPatch(message, { pinned: !message.pinned })}>
              {message.pinned ? 'unpin' : 'pin again'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

interface FeedProps {
  tab: FeedTab;
  onTab: (tab: FeedTab) => void;
  messages: MessageDTO[];
  openQuestions: MessageDTO[];
  decisions: MessageDTO[];
  me: UserDTO;
  agents: AgentDTO[];
  hasMore: boolean;
  onLoadOlder: () => void;
  onAnswer: (question: MessageDTO) => void;
  onPatch: (message: MessageDTO, patch: { pinned?: boolean; resolved?: boolean }) => void;
  emptyConversation: ReactNode;
  /** Messages after this id arrived while the person was away. 0 means no marker. */
  unreadAfter: number;
  /** How many tasks are not done, for the tab's counter. */
  openTasks: number;
  /** Rendered instead of the message list on the tasks and brief tabs. */
  tasksView: ReactNode;
  briefView: ReactNode;
}

const EMPTY: Record<Exclude<MessageTab, 'all'>, string> = {
  questions: 'No open questions. Everything asked so far has an answer.',
  decisions:
    'No decisions yet. Record one below, or ask your Claude to log one. Both Claudes re-read every decision each time they catch up.',
  handoffs: 'No handoffs yet. A Claude leaves one when it stops with work unfinished.',
};

export function Feed(props: FeedProps) {
  const { tab, messages, me, agents } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const lastId = messages.at(-1)?.id;

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const byId = new Map([...props.openQuestions, ...props.decisions, ...messages].map((m) => [m.id, m]));

  const isOther = (m: MessageDTO) => !(m.authorKind === 'human' && m.userId === me.id);
  const firstUnread =
    props.unreadAfter > 0 ? messages.find((m) => m.id > props.unreadAfter && isOther(m))?.id : undefined;

  // Follow new messages only if the reader is already at the bottom. The
  // unread marker is a dependency because it adds height after the first paint.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && (pinnedToBottom.current || tab !== 'all')) el.scrollTop = tab === 'all' ? el.scrollHeight : 0;
  }, [lastId, tab, firstUnread]);

  const list =
    tab === 'questions'
      ? props.openQuestions
      : tab === 'decisions'
        ? props.decisions
        : tab === 'handoffs'
          ? messages.filter((m) => m.kind === 'handoff')
          : messages;

  const tabs: { id: FeedTab; label: string; count?: number; alert?: boolean }[] = [
    { id: 'all', label: 'log' },
    { id: 'tasks', label: 'tasks', count: props.openTasks },
    { id: 'questions', label: 'open questions', count: props.openQuestions.length, alert: props.openQuestions.length > 0 },
    { id: 'decisions', label: 'decisions', count: props.decisions.length },
    { id: 'handoffs', label: 'handoffs' },
    { id: 'brief', label: 'brief' },
  ];

  const tabBar = (
    <div className="tabs-bar" role="tablist" aria-label="What to show">
      {tabs.map(({ id, label, count, alert }) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className="tab" onClick={() => props.onTab(id)}>
          {label}
          {count !== undefined && (
            <span className="tab-count" data-alert={alert || undefined}>
              {count}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  if (tab === 'tasks' || tab === 'brief') {
    return (
      <>
        {tabBar}
        {tab === 'tasks' ? props.tasksView : props.briefView}
      </>
    );
  }

  return (
    <>
      {tabBar}

      <div
        className="feed-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {tab === 'all' && props.hasMore && (
          <button type="button" className="btn btn-small feed-older" onClick={props.onLoadOlder}>
            load earlier messages
          </button>
        )}

        {list.length === 0 ? (
          <div className="feed-empty">{tab === 'all' ? props.emptyConversation : <p>{EMPTY[tab]}</p>}</div>
        ) : (
          <ol className="feed" data-tab={tab}>
            {list.map((message) => (
              <Fragment key={message.id}>
                {tab === 'all' && message.id === firstUnread && (
                  <li className="divider" role="separator">
                    new since you were last here
                  </li>
                )}
                <MessageItem
                  message={message}
                  me={me}
                  agents={agentMap}
                  question={message.replyTo ? byId.get(message.replyTo) : undefined}
                  onAnswer={props.onAnswer}
                  onPatch={props.onPatch}
                />
              </Fragment>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
