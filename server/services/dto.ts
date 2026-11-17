import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AgentDTO, RoomDTO, UserDTO } from '../../shared/types';
import type { Db } from '../db/client';
import { agents, users, type AgentRow, type RoomRow, type UserRow } from '../db/schema';
import { notFound } from '../lib/http';
import { iso, isoOrNull } from './context';

export const toUserDTO = (user: UserRow): UserDTO => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
});

export const toRoomDTO = (room: RoomRow): RoomDTO => ({
  id: room.id,
  name: room.name,
  inviteCode: room.inviteCode,
  brief: room.brief,
  createdAt: iso(room.createdAt),
});

export const toAgentDTO = (agent: AgentRow, ownerName: string): AgentDTO => ({
  id: agent.id,
  roomId: agent.roomId,
  userId: agent.userId,
  ownerName,
  name: agent.name,
  hue: agent.hue,
  state: agent.state,
  task: agent.task,
  statusUpdatedAt: isoOrNull(agent.statusUpdatedAt),
  lastSeenAt: isoOrNull(agent.lastSeenAt),
  lastTool: agent.lastTool,
  createdAt: iso(agent.createdAt),
});

export async function listAgents(db: Db, roomId: string): Promise<AgentDTO[]> {
  const rows = await db
    .select({ agent: agents, ownerName: users.displayName })
    .from(agents)
    .innerJoin(users, eq(agents.userId, users.id))
    .where(and(eq(agents.roomId, roomId), isNull(agents.revokedAt)))
    .orderBy(asc(agents.createdAt));
  return rows.map((row) => toAgentDTO(row.agent, row.ownerName));
}

export async function getAgentDTO(db: Db, agentId: string): Promise<AgentDTO> {
  const [row] = await db
    .select({ agent: agents, ownerName: users.displayName })
    .from(agents)
    .innerJoin(users, eq(agents.userId, users.id))
    .where(eq(agents.id, agentId));
  if (!row) throw notFound('That agent no longer exists.');
  return toAgentDTO(row.agent, row.ownerName);
}
