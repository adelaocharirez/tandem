import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  CreatedAgentDTO,
  MemberDTO,
  RoomDTO,
  RoomSnapshotDTO,
  RoomSummaryDTO,
} from '../../shared/types';
import type { Db } from '../db/client';
import { agents, memberships, messages, rooms, tasks, users, type AgentRow, type RoomRow, type UserRow } from '../db/schema';
import { newAgentToken, newInviteCode, sha256 } from '../lib/crypto';
import { forbidden, notFound } from '../lib/http';
import { listActiveClaims, listMessages, listOpenQuestions, listPinnedDecisions } from './collab';
import type { Ctx } from './context';
import { toAgentDTO, toRoomDTO, toUserDTO, listAgents } from './dto';
import { listTasks } from './taskRead';

export { getAgentDTO, listAgents, toAgentDTO, toRoomDTO, toUserDTO } from './dto';

/** Number of distinct agent colours the dashboard knows how to draw. */
export const AGENT_HUES = 6;
const SNAPSHOT_MESSAGES = 150;

// ── Rooms and membership ────────────────────────────────────────────────────

export async function createRoom(db: Db, user: UserRow, name: string): Promise<RoomDTO> {
  return db.transaction(async (tx) => {
    const [room] = await tx.insert(rooms).values({ name, inviteCode: newInviteCode(), createdBy: user.id }).returning();
    await tx.insert(memberships).values({ roomId: room!.id, userId: user.id, role: 'owner' });
    return toRoomDTO(room!);
  });
}

export async function joinRoom(ctx: Ctx, user: UserRow, inviteCode: string): Promise<RoomDTO> {
  const code = inviteCode.trim().toUpperCase();
  const [room] = await ctx.db.select().from(rooms).where(eq(rooms.inviteCode, code));
  if (!room) throw notFound('No room uses that invite code. Check it with whoever sent it.');

  const inserted = await ctx.db
    .insert(memberships)
    .values({ roomId: room.id, userId: user.id, role: 'member' })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    ctx.bus.publish(room.id, { type: 'member.joined', member: { ...toUserDTO(user), role: 'member' } });
  }
  return toRoomDTO(room);
}

export async function listRoomsForUser(db: Db, userId: string): Promise<RoomSummaryDTO[]> {
  const rows = await db
    .select({
      room: rooms,
      memberCount: sql<number>`(select count(*)::int from ${memberships} m where m.room_id = ${rooms.id})`,
      agentCount: sql<number>`(select count(*)::int from ${agents} a where a.room_id = ${rooms.id} and a.revoked_at is null)`,
      lastMessageAt: sql<string | null>`(select max(created_at) from ${messages} msg where msg.room_id = ${rooms.id})`,
      activeAgents: sql<number>`(select count(*)::int from ${agents} a where a.room_id = ${rooms.id} and a.revoked_at is null and a.last_seen_at > now() - interval '5 minutes')`,
      openTasks: sql<number>`(select count(*)::int from ${tasks} t where t.room_id = ${rooms.id} and t.status <> 'done')`,
      // "Unread" means written by anyone or anything other than this person typing in the dashboard.
      unread: sql<number>`(select count(*)::int from ${messages} msg where msg.room_id = ${rooms.id} and msg.id > ${memberships.lastReadMessageId} and not (msg.author_kind = 'human' and msg.user_id = ${memberships.userId}))`,
    })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(rooms.createdAt));

  return rows.map((row) => ({
    ...toRoomDTO(row.room),
    memberCount: Number(row.memberCount),
    agentCount: Number(row.agentCount),
    activeAgents: Number(row.activeAgents),
    openTasks: Number(row.openTasks),
    unread: Number(row.unread),
    lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt).toISOString() : null,
  }));
}

/** Throws 404 (not 403) for non-members so room ids can't be probed. */
export async function requireMembership(db: Db, roomId: string, userId: string): Promise<RoomRow> {
  const [row] = await db
    .select({ room: rooms })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .where(and(eq(memberships.roomId, roomId), eq(memberships.userId, userId)));
  if (!row) throw notFound('That room does not exist, or you are not a member of it.');
  return row.room;
}

/** Rename the room or rewrite its brief. Any member can; it's a room for people who trust each other. */
export async function updateRoom(ctx: Ctx, room: RoomRow, patch: { name?: string; brief?: string }): Promise<RoomDTO> {
  const [updated] = await ctx.db
    .update(rooms)
    .set({ name: patch.name?.trim() || room.name, brief: patch.brief ?? room.brief })
    .where(eq(rooms.id, room.id))
    .returning();
  const dto = toRoomDTO(updated!);
  ctx.bus.publish(room.id, { type: 'room.updated', room: dto });
  return dto;
}

/** Remember how far this person has read. Only ever moves forward. */
export async function markRead(db: Db, roomId: string, userId: string, messageId: number): Promise<void> {
  await db
    .update(memberships)
    .set({ lastReadMessageId: sql`greatest(${memberships.lastReadMessageId}, ${messageId})` })
    .where(and(eq(memberships.roomId, roomId), eq(memberships.userId, userId)));
}

export async function listMembers(db: Db, roomId: string): Promise<MemberDTO[]> {
  const rows = await db
    .select({ user: users, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.roomId, roomId))
    .orderBy(asc(memberships.joinedAt));
  return rows.map((row) => ({ ...toUserDTO(row.user), role: row.role }));
}

// ── Agents ──────────────────────────────────────────────────────────────────

export async function createAgent(
  ctx: Ctx,
  room: RoomRow,
  user: UserRow,
  name: string,
  publicUrl: string,
): Promise<CreatedAgentDTO> {
  const { token, prefix, hash } = newAgentToken();
  // Count revoked agents too, so a new agent never inherits a colour that old
  // messages in the feed are still drawn with.
  const [{ total } = { total: 0 }] = await ctx.db
    .select({ total: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.roomId, room.id));

  const [row] = await ctx.db
    .insert(agents)
    .values({
      roomId: room.id,
      userId: user.id,
      name,
      hue: Number(total) % AGENT_HUES,
      tokenHash: hash,
      tokenPrefix: prefix,
    })
    .returning();

  const agent = toAgentDTO(row!, user.displayName);
  ctx.bus.publish(room.id, { type: 'agent.updated', agent });
  return { agent, token, mcpUrl: `${publicUrl}/mcp` };
}

/** Only the person who connected an agent can disconnect it. */
export async function revokeAgent(ctx: Ctx, roomId: string, agentId: string, userId: string): Promise<void> {
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.roomId, roomId), isNull(agents.revokedAt)));
  if (!agent) throw notFound('That agent is not connected to this room.');
  if (agent.userId !== userId) throw forbidden('Only the person who connected an agent can disconnect it.');

  await ctx.db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
  ctx.bus.publish(roomId, { type: 'agent.removed', agentId });
  ctx.bus.publish(roomId, { type: 'claims.changed', claims: await listActiveClaims(ctx.db, roomId) });
}

/** Resolve a bearer token to a live agent, or null. */
export async function authenticateAgent(db: Db, token: string): Promise<AgentRow | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.tokenHash, sha256(token)), isNull(agents.revokedAt)));
  return agent ?? null;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/** Everything the dashboard needs to draw a room, in one round trip. */
export async function roomSnapshot(db: Db, room: RoomRow, me: UserRow): Promise<RoomSnapshotDTO> {
  const [members, roomAgents, claims, recent, decisions, openQuestions, roomTasks, membership] = await Promise.all([
    listMembers(db, room.id),
    listAgents(db, room.id),
    listActiveClaims(db, room.id),
    listMessages(db, room.id, { limit: SNAPSHOT_MESSAGES + 1 }),
    listPinnedDecisions(db, room.id),
    listOpenQuestions(db, room.id),
    listTasks(db, room.id),
    db
      .select({ lastRead: memberships.lastReadMessageId })
      .from(memberships)
      .where(and(eq(memberships.roomId, room.id), eq(memberships.userId, me.id))),
  ]);
  const hasMore = recent.length > SNAPSHOT_MESSAGES;
  return {
    room: toRoomDTO(room),
    me: toUserDTO(me),
    members,
    agents: roomAgents,
    claims,
    tasks: roomTasks,
    lastReadMessageId: membership[0]?.lastRead ?? 0,
    messages: hasMore ? recent.slice(1) : recent,
    decisions,
    openQuestions,
    hasMore,
  };
}
