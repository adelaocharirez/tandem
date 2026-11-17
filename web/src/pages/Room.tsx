import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentDTO, ClaimDTO, MessageDTO, TaskDTO, TaskStatus } from '../../../shared/types';
import { api, type NewMessageInput } from '../api';
import { useAuth } from '../App';
import { AgentDesk, Seat } from '../components/AgentDesk';
import { Logo } from '../components/Brand';
import { Brief } from '../components/Brief';
import { Composer } from '../components/Composer';
import { ConnectDialog } from '../components/ConnectDialog';
import { CopyButton } from '../components/Copy';
import { Feed, type FeedTab } from '../components/Feed';
import { PeopleMenu } from '../components/PeopleMenu';
import { TaskBoard } from '../components/TaskBoard';
import { useRoom } from '../room/useRoom';
import { useNow } from '../time';

const LIVE_LABEL = { live: 'live', loading: 'connecting', reconnecting: 'reconnecting' } as const;

export function Room() {
  const { roomId = '' } = useParams();
  // Keyed by room, so switching rooms starts from a clean slate.
  return <RoomView key={roomId} roomId={roomId} />;
}

function RoomView({ roomId }: { roomId: string }) {
  const { setUser } = useAuth();
  const { state, connection, failure, loadOlder } = useRoom(roomId);
  const now = useNow();
  const [tab, setTab] = useState<FeedTab>('all');
  const [answering, setAnswering] = useState<MessageDTO | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Where the person had read up to when they arrived. Fixed for the visit,
  // so the "new since you were last here" marker doesn't jump around.
  const [unreadAfter, setUnreadAfter] = useState<number | null>(null);

  const loaded = state !== null;
  const arrivedAt = state?.lastReadMessageId;
  useEffect(() => {
    if (loaded && unreadAfter === null) setUnreadAfter(arrivedAt ?? 0);
  }, [loaded, arrivedAt, unreadAfter]);

  // Tell the server how far this person has read, whenever they're actually looking.
  const latestId = state?.messages.at(-1)?.id;
  useEffect(() => {
    if (!latestId) return;
    const mark = () => {
      if (document.visibilityState === 'visible') api.markRead(roomId, latestId).catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [roomId, latestId]);

  // A 401 means the session ended; dropping the user sends them to sign in.
  useEffect(() => {
    if (failure?.status === 401) setUser(null);
  }, [failure, setUser]);

  useEffect(() => {
    if (state) document.title = `${state.room.name} | Tandem`;
    return () => {
      document.title = 'Tandem';
    };
  }, [state?.room.name]);

  if (!state) {
    return (
      <div className="center-note" aria-busy={!failure}>
        {failure && (
          <>
            <p>{failure.message}</p>
            <Link to="/">Go to your rooms</Link>
          </>
        )}
      </div>
    );
  }

  const { room, me, agents, claims, members } = state;
  const liveClaims = claims.filter((claim) => new Date(claim.expiresAt).getTime() > now);

  /** Run a dashboard action; the result arrives over the socket, so only failure needs handling here. */
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      setNotice(null);
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That did not work. Try again.');
    }
  };

  const send = async (input: NewMessageInput) => {
    await api.postMessage(roomId, input);
  };
  const patch = (message: MessageDTO, change: { pinned?: boolean; resolved?: boolean }) =>
    void attempt(() => api.patchMessage(roomId, message.id, change));
  const disconnect = (agent: AgentDTO) => void attempt(() => api.revokeAgent(roomId, agent.id));
  const releaseClaim = (claim: ClaimDTO) => void attempt(() => api.releaseClaim(roomId, claim.id));
  const startAnswer = (question: MessageDTO) => {
    setAnswering(question);
    setTab('all');
  };
  const addTask = async (title: string, detail: string) => {
    await api.createTask(roomId, title, detail);
  };
  const patchTask = (task: TaskDTO, change: { status?: TaskStatus; assigneeAgentId?: string | null }) =>
    void attempt(() => api.patchTask(roomId, task.id, change));
  const removeTask = (task: TaskDTO) => void attempt(() => api.deleteTask(roomId, task.id));
  const saveBrief = async (change: { name: string; brief: string }) => {
    await api.updateRoom(roomId, change);
  };

  const mine = agents.filter((a) => a.userId === me.id);
  const theirs = agents.filter((a) => a.userId !== me.id);
  const teammates = members.filter((m) => m.id !== me.id);
  const suggestedName = mine.length === 0 ? `${me.displayName}'s Claude` : `${me.displayName}'s Claude ${mine.length + 1}`;

  const desk = (agent: AgentDTO) => (
    <AgentDesk
      key={agent.id}
      agent={agent}
      claims={liveClaims.filter((c) => c.agentId === agent.id)}
      mine={agent.userId === me.id}
      now={now}
      onDisconnect={disconnect}
      onReleaseClaim={releaseClaim}
    />
  );

  return (
    <div className="room">
      <header className="topbar">
        <Link to="/" aria-label="Tandem, back to your rooms" className="logo-link">
          <Logo />
        </Link>
        <h1 className="room-name">{room.name}</h1>
        <span className="live" data-connection={connection} role="status">
          {LIVE_LABEL[connection]}
        </span>
        <div className="topbar-actions">
          <PeopleMenu members={members} agents={agents} inviteCode={room.inviteCode} />
          <button type="button" className="btn btn-primary" onClick={() => setConnecting(true)}>
            + connect a claude
          </button>
        </div>
      </header>

      {notice && (
        <p className="notice" role="alert">
          {notice}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="stage">
        <section className="side side-left" aria-label="Your Claudes">
          {mine.length > 0 ? (
            mine.map(desk)
          ) : (
            <Seat title="your seat is empty">
              <p>Connect your Claude and its pane appears here: what it's working on, and which files it holds.</p>
              <button type="button" className="btn btn-primary" onClick={() => setConnecting(true)}>
                + connect a claude
              </button>
            </Seat>
          )}
        </section>

        <main className="center">
          <Feed
            tab={tab}
            onTab={setTab}
            messages={state.messages}
            openQuestions={state.openQuestions}
            decisions={state.decisions}
            me={me}
            agents={agents}
            hasMore={state.hasMore}
            onLoadOlder={() => void attempt(loadOlder)}
            onAnswer={startAnswer}
            onPatch={patch}
            unreadAfter={unreadAfter ?? 0}
            openTasks={state.tasks.filter((t) => t.status !== 'done').length}
            tasksView={
              <TaskBoard tasks={state.tasks} agents={agents} now={now} onAdd={addTask} onPatch={patchTask} onDelete={removeTask} />
            }
            briefView={<Brief room={room} onSave={saveBrief} />}
            emptyConversation={
              <>
                <p className="feed-empty-title">no messages yet</p>
                <p>
                  Once yours is connected, ask it to “catch up with the tandem room” or “post a note to the room”. You can
                  write here too. Both Claudes read it the next time they catch up.
                </p>
              </>
            }
          />
          {tab !== 'tasks' && tab !== 'brief' && (
            <Composer agents={agents} answering={answering} onCancelAnswer={() => setAnswering(null)} onSend={send} />
          )}
        </main>

        <section className="side side-right" aria-label="Your teammates' Claudes">
          {theirs.length > 0 ? (
            theirs.map(desk)
          ) : teammates.length === 0 ? (
            <Seat title="waiting for a teammate">
              <p>Send them the invite link. When they connect their Claude, its pane takes this side of the room.</p>
              <CopyButton text={`${location.origin}/join/${room.inviteCode}`} className="btn">
                copy invite link
              </CopyButton>
            </Seat>
          ) : (
            <Seat title={`${teammates.map((t) => t.displayName).join(' and ')} ${teammates.length === 1 ? "hasn't" : "haven't"} connected a Claude yet`}>
              <p>Their Claude's pane shows up here as soon as they connect it from their own account.</p>
            </Seat>
          )}
        </section>
      </div>

      {connecting && <ConnectDialog roomId={roomId} suggestedName={suggestedName} onClose={() => setConnecting(false)} />}
    </div>
  );
}
