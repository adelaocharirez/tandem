/**
 * Types shared between the server and the dashboard. Everything the browser
 * receives (REST responses and WebSocket events) is described here, so the
 * two sides can't drift apart without the type checker noticing.
 */

export type MessageKind = 'note' | 'question' | 'answer' | 'decision' | 'handoff' | 'task';
export type TaskStatus = 'todo' | 'doing' | 'done';
export type AgentState = 'working' | 'blocked' | 'idle';
export type AuthorKind = 'agent' | 'human';

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
}

export interface RoomDTO {
  id: string;
  name: string;
  inviteCode: string;
  /** Shared project context every agent reads when it starts a session. */
  brief: string;
  createdAt: string;
}

export interface RoomSummaryDTO extends RoomDTO {
  memberCount: number;
  agentCount: number;
  /** Agents heard from in the last few minutes. */
  activeAgents: number;
  /** Tasks not done yet. */
  openTasks: number;
  /** Messages from others since this person last opened the room. */
  unread: number;
  lastMessageAt: string | null;
}

export interface MemberDTO extends UserDTO {
  role: 'owner' | 'member';
}

export interface AgentDTO {
  id: string;
  roomId: string;
  userId: string;
  ownerName: string;
  name: string;
  /** Index into the dashboard's agent palette; stable for the agent's lifetime. */
  hue: number;
  state: AgentState;
  task: string | null;
  statusUpdatedAt: string | null;
  lastSeenAt: string | null;
  lastTool: string | null;
  createdAt: string;
}

export interface MessageDTO {
  id: number;
  roomId: string;
  authorKind: AuthorKind;
  agentId: string | null;
  userId: string;
  authorName: string;
  /** Palette index of the agent that wrote this (kept even after the agent disconnects). Null for people. */
  authorHue: number | null;
  kind: MessageKind;
  title: string | null;
  body: string;
  replyTo: number | null;
  toAgentId: string | null;
  resolvedAt: string | null;
  pinned: boolean;
  createdAt: string;
}

export interface ClaimDTO {
  id: string;
  roomId: string;
  agentId: string;
  path: string;
  note: string | null;
  /** Claimed by the edit hook as the agent touched the file. */
  auto: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface TaskDTO {
  id: number;
  roomId: string;
  title: string;
  detail: string | null;
  status: TaskStatus;
  assigneeAgentId: string | null;
  createdByName: string;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RoomSnapshotDTO {
  room: RoomDTO;
  me: UserDTO;
  members: MemberDTO[];
  agents: AgentDTO[];
  claims: ClaimDTO[];
  tasks: TaskDTO[];
  /** Newest message this person had seen before this visit. */
  lastReadMessageId: number;
  messages: MessageDTO[];
  /** Pinned decisions, which may be older than the loaded message window. */
  decisions: MessageDTO[];
  /** Unresolved questions, which may be older than the loaded message window. */
  openQuestions: MessageDTO[];
  hasMore: boolean;
}

export type RoomEvent =
  | { type: 'message.created'; message: MessageDTO }
  | { type: 'message.updated'; message: MessageDTO }
  | { type: 'agent.updated'; agent: AgentDTO }
  | { type: 'agent.removed'; agentId: string }
  | { type: 'agent.activity'; agentId: string; tool: string; at: string }
  | { type: 'claims.changed'; claims: ClaimDTO[] }
  | { type: 'member.joined'; member: MemberDTO }
  | { type: 'task.updated'; task: TaskDTO }
  | { type: 'task.removed'; taskId: number }
  | { type: 'room.updated'; room: RoomDTO };

/** How this server accepts new accounts. 'first' means nobody has signed up yet. */
export interface AuthConfigDTO {
  signup: 'open' | 'invite' | 'first';
}

export interface CreatedAgentDTO {
  agent: AgentDTO;
  /** Shown exactly once. Only a hash is stored. */
  token: string;
  mcpUrl: string;
}

export interface ApiError {
  error: string;
}
