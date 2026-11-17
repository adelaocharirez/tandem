import type { AgentDTO, MessageDTO, RoomEvent, RoomSnapshotDTO } from '../../../shared/types';

export type RoomState = RoomSnapshotDTO;

export type RoomAction =
  | { type: 'snapshot'; snapshot: RoomSnapshotDTO }
  | { type: 'event'; event: RoomEvent }
  | { type: 'older'; messages: MessageDTO[]; hasMore: boolean };

const byId = (a: MessageDTO, b: MessageDTO) => a.id - b.id;

function upsertMessage(list: MessageDTO[], message: MessageDTO): MessageDTO[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index === -1) return [...list, message].sort(byId);
  const next = list.slice();
  next[index] = message;
  return next;
}

/** Keep a derived list (open questions, pinned decisions) in step with one message changing. */
function syncDerived(list: MessageDTO[], message: MessageDTO, belongs: boolean): MessageDTO[] {
  const without = list.filter((m) => m.id !== message.id);
  return belongs ? [...without, message].sort(byId) : without;
}

function upsertAgent(list: AgentDTO[], agent: AgentDTO): AgentDTO[] {
  return list.some((a) => a.id === agent.id) ? list.map((a) => (a.id === agent.id ? agent : a)) : [...list, agent];
}

function applyMessage(state: RoomState, message: MessageDTO, insert: boolean): RoomState {
  // An update for a message older than the loaded window shouldn't pull it into the feed.
  const known = state.messages.some((m) => m.id === message.id);
  return {
    ...state,
    messages: insert || known ? upsertMessage(state.messages, message) : state.messages,
    openQuestions: syncDerived(state.openQuestions, message, message.kind === 'question' && !message.resolvedAt),
    decisions: syncDerived(state.decisions, message, message.kind === 'decision' && message.pinned),
  };
}

/**
 * Every event is applied as an upsert, so replaying one (after a reconnect, or
 * because it raced the snapshot) is harmless.
 */
export function roomReducer(state: RoomState | null, action: RoomAction): RoomState | null {
  if (action.type === 'snapshot') return action.snapshot;
  if (!state) return state;

  if (action.type === 'older') {
    const seen = new Set(state.messages.map((m) => m.id));
    const fresh = action.messages.filter((m) => !seen.has(m.id));
    return { ...state, messages: [...fresh, ...state.messages].sort(byId), hasMore: action.hasMore };
  }

  const event = action.event;
  switch (event.type) {
    case 'message.created':
      return applyMessage(state, event.message, true);
    case 'message.updated':
      return applyMessage(state, event.message, false);
    case 'agent.updated':
      return { ...state, agents: upsertAgent(state.agents, event.agent) };
    case 'agent.removed':
      return { ...state, agents: state.agents.filter((a) => a.id !== event.agentId) };
    case 'agent.activity':
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === event.agentId ? { ...a, lastSeenAt: event.at, lastTool: event.tool } : a,
        ),
      };
    case 'claims.changed':
      return { ...state, claims: event.claims };
    case 'task.updated': {
      const exists = state.tasks.some((t) => t.id === event.task.id);
      const tasks = exists ? state.tasks.map((t) => (t.id === event.task.id ? event.task : t)) : [...state.tasks, event.task];
      return { ...state, tasks };
    }
    case 'task.removed':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== event.taskId) };
    case 'room.updated':
      return { ...state, room: event.room };
    case 'member.joined':
      return state.members.some((m) => m.id === event.member.id)
        ? state
        : { ...state, members: [...state.members, event.member] };
  }
}
