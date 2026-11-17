import type {
  AuthConfigDTO,
  CreatedAgentDTO,
  MessageDTO,
  MessageKind,
  RoomDTO,
  RoomSnapshotDTO,
  RoomSummaryDTO,
  TaskDTO,
  TaskStatus,
  UserDTO,
} from '../../shared/types';

/** A failed API call, carrying the server's own explanation. */
export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, "Can't reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiFailure(response.status, data?.error ?? `The server answered ${response.status}.`);
  }
  return data as T;
}

export interface NewMessageInput {
  kind: Exclude<MessageKind, 'handoff'>;
  body: string;
  title?: string;
  replyTo?: number;
  toAgentId?: string;
}

export const api = {
  me: () => request<{ user: UserDTO }>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: UserDTO }>('POST', '/api/auth/login', { username, password }),
  authConfig: () => request<AuthConfigDTO>('GET', '/api/auth/config'),
  register: (username: string, displayName: string, password: string, inviteCode?: string) =>
    request<{ user: UserDTO }>('POST', '/api/auth/register', {
      username,
      displayName: displayName || undefined,
      password,
      inviteCode: inviteCode || undefined,
    }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  rooms: () => request<{ rooms: RoomSummaryDTO[] }>('GET', '/api/rooms'),
  createRoom: (name: string) => request<{ room: RoomDTO }>('POST', '/api/rooms', { name }),
  joinRoom: (inviteCode: string) => request<{ room: RoomDTO }>('POST', '/api/rooms/join', { inviteCode }),
  room: (roomId: string) => request<RoomSnapshotDTO>('GET', `/api/rooms/${roomId}`),
  updateRoom: (roomId: string, patch: { name?: string; brief?: string }) =>
    request<{ room: RoomDTO }>('PATCH', `/api/rooms/${roomId}`, patch),
  markRead: (roomId: string, messageId: number) => request<{ ok: true }>('POST', `/api/rooms/${roomId}/read`, { messageId }),

  createTask: (roomId: string, title: string, detail?: string) =>
    request<{ task: TaskDTO }>('POST', `/api/rooms/${roomId}/tasks`, { title, detail: detail || undefined }),
  patchTask: (roomId: string, taskId: number, patch: { status?: TaskStatus; assigneeAgentId?: string | null }) =>
    request<{ task: TaskDTO }>('PATCH', `/api/rooms/${roomId}/tasks/${taskId}`, patch),
  deleteTask: (roomId: string, taskId: number) => request<{ ok: true }>('DELETE', `/api/rooms/${roomId}/tasks/${taskId}`),

  olderMessages: (roomId: string, before: number) =>
    request<{ messages: MessageDTO[]; hasMore: boolean }>('GET', `/api/rooms/${roomId}/messages?before=${before}&limit=100`),
  postMessage: (roomId: string, input: NewMessageInput) =>
    request<{ message: MessageDTO }>('POST', `/api/rooms/${roomId}/messages`, input),
  patchMessage: (roomId: string, messageId: number, patch: { pinned?: boolean; resolved?: boolean }) =>
    request<{ message: MessageDTO }>('PATCH', `/api/rooms/${roomId}/messages/${messageId}`, patch),

  createAgent: (roomId: string, name: string) =>
    request<CreatedAgentDTO>('POST', `/api/rooms/${roomId}/agents`, { name }),
  revokeAgent: (roomId: string, agentId: string) =>
    request<{ ok: true }>('DELETE', `/api/rooms/${roomId}/agents/${agentId}`),
  releaseClaim: (roomId: string, claimId: string) =>
    request<{ ok: true }>('DELETE', `/api/rooms/${roomId}/claims/${claimId}`),
};
