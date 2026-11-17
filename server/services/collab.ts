import { and, desc, eq, gt, ilike, inArray, isNull, lt, max, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AgentDTO, AgentState, ClaimDTO, MessageDTO, MessageKind, TaskDTO } from '../../shared/types';
import type { Db } from '../db/client';
import { agents, claims, messages, rooms, users, type AgentRow, type MessageRow } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { normalizePath, pathsOverlap } from '../lib/paths';
import { iso, isoOrNull, type Ctx } from './context';
import { getAgentDTO, listAgents } from './dto';
import { listTasks } from './taskRead';

/**
 * The collaboration core: the feed, agent status, file claims and catch-up.
 *
 * Both front doors call these same functions — the MCP tools (a Claude acting)
 * and the REST API (a person clicking in the dashboard) — so the rules live in
 * exactly one place and every change is announced on the event bus the same way.
 */

export const DEFAULT_CLAIM_MINUTES = 120;
/** Claims made by the edit hook are short: they renew on every edit and lapse soon after the agent stops. */
export const AUTO_CLAIM_MINUTES = 45;
const CATCH_UP_LIMIT = 40;
const DIGEST_LIMIT = 8;

// ── Messages ────────────────────────────────────────────────────────────────

interface MessageJoinRow {
  message: MessageRow;
  agentName: string | null;
  agentHue: number | null;
  userName: string;
}

const toMessageDTO = ({ message, agentName, agentHue, userName }: MessageJoinRow): MessageDTO => ({
  id: message.id,
  roomId: message.roomId,
  authorKind: message.authorKind,
  agentId: message.agentId,
  userId: message.userId,
  authorName: message.authorKind === 'agent' ? (agentName ?? `${userName}'s Claude`) : userName,
  authorHue: message.authorKind === 'agent' ? agentHue : null,
  kind: message.kind,
  title: message.title,
  body: message.body,
  replyTo: message.replyTo,
  toAgentId: message.toAgentId,
  resolvedAt: isoOrNull(message.resolvedAt),
  pinned: message.pinned,
  createdAt: iso(message.createdAt),
});

function selectMessages(db: Db) {
  return db
    .select({ message: messages, agentName: agents.name, agentHue: agents.hue, userName: users.displayName })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .innerJoin(users, eq(messages.userId, users.id));
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

export interface MessageQuery {
  limit: number;
  beforeId?: number;
  afterId?: number;
  search?: string;
  kinds?: MessageKind[];
  /** Leave out messages this agent wrote itself. */
  excludeAgentId?: string;
}

function messageFilters(roomId: string, query: Omit<MessageQuery, 'limit'>): SQL | undefined {
  const filters: (SQL | undefined)[] = [eq(messages.roomId, roomId)];
  if (query.beforeId !== undefined) filters.push(lt(messages.id, query.beforeId));
  if (query.afterId !== undefined) filters.push(gt(messages.id, query.afterId));
  if (query.kinds?.length) filters.push(inArray(messages.kind, query.kinds));
  if (query.excludeAgentId) {
    filters.push(or(isNull(messages.agentId), ne(messages.agentId, query.excludeAgentId)));
  }
  if (query.search?.trim()) {
    const pattern = `%${escapeLike(query.search.trim())}%`;
    filters.push(or(ilike(messages.body, pattern), ilike(messages.title, pattern)));
  }
  return and(...filters);
}

/** The newest `limit` messages matching the query, returned oldest-first. */
export async function listMessages(db: Db, roomId: string, query: MessageQuery): Promise<MessageDTO[]> {
  const rows = await selectMessages(db)
    .where(messageFilters(roomId, query))
    .orderBy(desc(messages.id))
    .limit(query.limit);
  return rows.reverse().map(toMessageDTO);
}

async function countMessages(db: Db, roomId: string, query: Omit<MessageQuery, 'limit'>): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .where(messageFilters(roomId, query));
  return Number(row?.total ?? 0);
}

async function getMessage(db: Db, id: number): Promise<MessageDTO> {
  const [row] = await selectMessages(db).where(eq(messages.id, id));
  if (!row) throw notFound(`Message #${id} does not exist.`);
  return toMessageDTO(row);
}

export async function listPinnedDecisions(db: Db, roomId: string): Promise<MessageDTO[]> {
  const rows = await selectMessages(db)
    .where(and(eq(messages.roomId, roomId), eq(messages.kind, 'decision'), eq(messages.pinned, true)))
    .orderBy(messages.id);
  return rows.map(toMessageDTO);
}

export async function listOpenQuestions(db: Db, roomId: string): Promise<MessageDTO[]> {
  const rows = await selectMessages(db)
    .where(and(eq(messages.roomId, roomId), eq(messages.kind, 'question'), isNull(messages.resolvedAt)))
    .orderBy(messages.id);
  return rows.map(toMessageDTO);
}

export type Author = { kind: 'agent'; agent: AgentRow } | { kind: 'human'; userId: string };

export interface NewMessage {
  kind: MessageKind;
  body: string;
  title?: string;
  /** Required for answers: the id of the question being answered. */
  replyTo?: number;
  /** For questions: who is being asked. Omit to ask the whole room. */
  toAgentId?: string;
}

export async function postMessage(ctx: Ctx, roomId: string, author: Author, input: NewMessage): Promise<MessageDTO> {
  const { db, bus } = ctx;

  let question: MessageRow | undefined;
  if (input.kind === 'answer') {
    if (input.replyTo === undefined) throw badRequest('An answer needs the id of the question it answers.');
    [question] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.replyTo), eq(messages.roomId, roomId)));
    if (!question || question.kind !== 'question') {
      throw notFound(`There is no question #${input.replyTo} in this room.`);
    }
  }

  if (input.toAgentId) {
    const [target] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.toAgentId), eq(agents.roomId, roomId), isNull(agents.revokedAt)));
    if (!target) throw notFound('The agent you addressed is not connected to this room.');
  }

  const [row] = await db
    .insert(messages)
    .values({
      roomId,
      authorKind: author.kind,
      agentId: author.kind === 'agent' ? author.agent.id : null,
      userId: author.kind === 'agent' ? author.agent.userId : author.userId,
      kind: input.kind,
      title: input.title?.trim() || null,
      body: input.body.trim(),
      replyTo: input.kind === 'answer' ? input.replyTo : null,
      toAgentId: input.kind === 'question' ? (input.toAgentId ?? null) : null,
      // Decisions start pinned: the point of logging one is that everyone keeps seeing it.
      pinned: input.kind === 'decision',
    })
    .returning();

  const message = await getMessage(db, row!.id);
  bus.publish(roomId, { type: 'message.created', message });

  if (question && !question.resolvedAt) {
    await db.update(messages).set({ resolvedAt: new Date() }).where(eq(messages.id, question.id));
    bus.publish(roomId, { type: 'message.updated', message: await getMessage(db, question.id) });
  }
  return message;
}

/** Dashboard actions on an existing message: pin/unpin a decision, close/reopen a question. */
export async function updateMessage(
  ctx: Ctx,
  roomId: string,
  messageId: number,
  patch: { pinned?: boolean; resolved?: boolean },
): Promise<MessageDTO> {
  const [existing] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.roomId, roomId)));
  if (!existing) throw notFound(`Message #${messageId} is not in this room.`);

  const changes: Partial<Pick<MessageRow, 'pinned' | 'resolvedAt'>> = {};
  if (patch.pinned !== undefined) {
    if (existing.kind !== 'decision') throw badRequest('Only decisions can be pinned.');
    changes.pinned = patch.pinned;
  }
  if (patch.resolved !== undefined) {
    if (existing.kind !== 'question') throw badRequest('Only questions can be resolved.');
    changes.resolvedAt = patch.resolved ? (existing.resolvedAt ?? new Date()) : null;
  }
  if (Object.keys(changes).length > 0) {
    await ctx.db.update(messages).set(changes).where(eq(messages.id, messageId));
  }
  const message = await getMessage(ctx.db, messageId);
  ctx.bus.publish(roomId, { type: 'message.updated', message });
  return message;
}

// ── Agent presence and status ───────────────────────────────────────────────

/** Record that an agent just did something, so the dashboard can show it live. */
export async function touchAgent(ctx: Ctx, agent: AgentRow, tool: string | null): Promise<void> {
  const now = new Date();
  await ctx.db
    .update(agents)
    .set(tool ? { lastSeenAt: now, lastTool: tool } : { lastSeenAt: now })
    .where(eq(agents.id, agent.id));
  if (tool) ctx.bus.publish(agent.roomId, { type: 'agent.activity', agentId: agent.id, tool, at: iso(now) });
}

export async function setStatus(
  ctx: Ctx,
  agent: AgentRow,
  status: { state: AgentState; task: string | null },
): Promise<AgentDTO> {
  await ctx.db
    .update(agents)
    .set({ state: status.state, task: status.task?.trim() || null, statusUpdatedAt: new Date() })
    .where(eq(agents.id, agent.id));
  const dto = await getAgentDTO(ctx.db, agent.id);
  ctx.bus.publish(agent.roomId, { type: 'agent.updated', agent: dto });
  return dto;
}

// ── File claims ─────────────────────────────────────────────────────────────

export async function listActiveClaims(db: Db, roomId: string): Promise<ClaimDTO[]> {
  const rows = await db
    .select({ claim: claims })
    .from(claims)
    .innerJoin(agents, eq(claims.agentId, agents.id))
    .where(
      and(
        eq(claims.roomId, roomId),
        isNull(claims.releasedAt),
        gt(claims.expiresAt, new Date()),
        isNull(agents.revokedAt),
      ),
    )
    .orderBy(claims.createdAt);
  return rows.map(({ claim }) => ({
    id: claim.id,
    roomId: claim.roomId,
    agentId: claim.agentId,
    path: claim.path,
    note: claim.note,
    auto: claim.auto,
    createdAt: iso(claim.createdAt),
    expiresAt: iso(claim.expiresAt),
  }));
}

export interface ClaimConflict {
  /** The path this agent asked for. */
  requested: string;
  /** The overlapping path somebody else already holds. */
  heldPath: string;
  heldByAgentId: string;
  note: string | null;
  since: string;
}

export interface ClaimResult {
  claimed: ClaimDTO[];
  conflicts: ClaimConflict[];
}

/**
 * Claim paths for an agent. Paths that overlap someone else's live claim are
 * *not* claimed — they come back as conflicts so the agent can tell its human
 * or ask the other agent, instead of both editing the same file.
 */
export async function claimFiles(
  ctx: Ctx,
  agent: AgentRow,
  paths: string[],
  note: string | undefined,
  ttlMinutes = DEFAULT_CLAIM_MINUTES,
): Promise<ClaimResult> {
  const active = await listActiveClaims(ctx.db, agent.roomId);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  const wanted = [...new Set(paths.map(normalizePath).filter(Boolean))];

  const conflicts: ClaimConflict[] = [];
  let changed = false;

  for (const path of wanted) {
    const blocking = active.filter((claim) => claim.agentId !== agent.id && pathsOverlap(claim.path, path));
    if (blocking.length > 0) {
      for (const claim of blocking) {
        conflicts.push({
          requested: path,
          heldPath: claim.path,
          heldByAgentId: claim.agentId,
          note: claim.note,
          since: claim.createdAt,
        });
      }
      continue;
    }

    const mine = active.find((claim) => claim.agentId === agent.id && claim.path === path);
    if (mine) {
      // Claiming again is how an agent says "still on it": push the expiry out.
      await ctx.db
        .update(claims)
        .set({ expiresAt, note: note ?? mine.note, auto: false })
        .where(eq(claims.id, mine.id));
    } else {
      await ctx.db.insert(claims).values({ roomId: agent.roomId, agentId: agent.id, path, note: note ?? null, expiresAt });
    }
    changed = true;
  }

  const all = await listActiveClaims(ctx.db, agent.roomId);
  if (changed) ctx.bus.publish(agent.roomId, { type: 'claims.changed', claims: all });
  return {
    claimed: all.filter((claim) => claim.agentId === agent.id && wanted.includes(claim.path)),
    conflicts,
  };
}

/** Release some of an agent's claims, or all of them when `paths` is omitted. */
export async function releaseFiles(ctx: Ctx, agent: AgentRow, paths?: string[]): Promise<string[]> {
  const filters: (SQL | undefined)[] = [eq(claims.agentId, agent.id), isNull(claims.releasedAt)];
  if (paths?.length) filters.push(inArray(claims.path, paths.map(normalizePath)));

  const released = await ctx.db
    .update(claims)
    .set({ releasedAt: new Date() })
    .where(and(...filters))
    .returning({ path: claims.path, expiresAt: claims.expiresAt });

  if (released.length > 0) {
    ctx.bus.publish(agent.roomId, { type: 'claims.changed', claims: await listActiveClaims(ctx.db, agent.roomId) });
  }
  return released.filter((claim) => claim.expiresAt > new Date()).map((claim) => claim.path);
}

/** A person clearing a stale claim from the dashboard. */
export async function releaseClaimById(ctx: Ctx, roomId: string, claimId: string): Promise<void> {
  const released = await ctx.db
    .update(claims)
    .set({ releasedAt: new Date() })
    .where(and(eq(claims.id, claimId), eq(claims.roomId, roomId), isNull(claims.releasedAt)))
    .returning({ id: claims.id });
  if (released.length === 0) throw notFound('That claim was already released.');
  ctx.bus.publish(roomId, { type: 'claims.changed', claims: await listActiveClaims(ctx.db, roomId) });
}

export type EditCheck =
  | { allowed: true; claimed: boolean }
  | { allowed: false; path: string; heldPath: string; heldByAgentId: string; holderName: string; note: string | null };

/**
 * Called by the Claude Code edit hook just before an agent writes a file.
 * This is what makes claims real instead of polite: if another agent holds
 * the path, the edit is refused. Otherwise the path is claimed for this agent
 * automatically, so nobody has to remember to call claim_files.
 */
export async function checkEdit(ctx: Ctx, agent: AgentRow, rawPath: string): Promise<EditCheck> {
  const path = normalizePath(rawPath);
  const active = await listActiveClaims(ctx.db, agent.roomId);

  const blocking = active.find((claim) => claim.agentId !== agent.id && pathsOverlap(claim.path, path));
  if (blocking) {
    const [holder] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, blocking.agentId));
    return {
      allowed: false,
      path,
      heldPath: blocking.path,
      heldByAgentId: blocking.agentId,
      holderName: holder?.name ?? 'another agent',
      note: blocking.note,
    };
  }

  const expiresAt = new Date(Date.now() + AUTO_CLAIM_MINUTES * 60_000);
  const covering = active.filter((claim) => claim.agentId === agent.id && pathsOverlap(claim.path, path));
  const exact = covering.find((claim) => claim.path === path && claim.auto);
  if (exact) {
    // Still editing: keep the claim alive. Not announced, to keep the feed quiet.
    await ctx.db.update(claims).set({ expiresAt }).where(eq(claims.id, exact.id));
    return { allowed: true, claimed: false };
  }
  if (covering.length > 0) return { allowed: true, claimed: false }; // already covered by a claim it made itself

  await ctx.db.insert(claims).values({ roomId: agent.roomId, agentId: agent.id, path, auto: true, expiresAt });
  ctx.bus.publish(agent.roomId, { type: 'claims.changed', claims: await listActiveClaims(ctx.db, agent.roomId) });
  return { allowed: true, claimed: true };
}

/**
 * The agent's Claude Code session ended. Its automatic claims go (nobody is
 * editing those files any more) and its desk goes idle, so the dashboard
 * never shows a Claude "working" in a terminal that was closed hours ago.
 * Claims it made deliberately are kept: those were a promise, not a side effect.
 */
export async function endSession(ctx: Ctx, agent: AgentRow): Promise<void> {
  const released = await ctx.db
    .update(claims)
    .set({ releasedAt: new Date() })
    .where(and(eq(claims.agentId, agent.id), eq(claims.auto, true), isNull(claims.releasedAt)))
    .returning({ id: claims.id });
  if (released.length > 0) {
    ctx.bus.publish(agent.roomId, { type: 'claims.changed', claims: await listActiveClaims(ctx.db, agent.roomId) });
  }
  if (agent.state !== 'idle') await setStatus(ctx, agent, { state: 'idle', task: null });
}

// ── Catch-up ────────────────────────────────────────────────────────────────

async function latestMessageId(db: Db, roomId: string): Promise<number> {
  const [row] = await db
    .select({ latest: max(messages.id) })
    .from(messages)
    .where(eq(messages.roomId, roomId));
  return Number(row?.latest ?? 0);
}

export interface CatchUp {
  me: AgentDTO;
  /** Everyone else's agents in the room. */
  peers: AgentDTO[];
  /** New messages from others since the last catch-up, oldest first. */
  unread: MessageDTO[];
  /** How many older unread messages were left out to keep the response small. */
  skipped: number;
  /** Unanswered questions addressed to this agent or to the whole room. */
  questionsForMe: MessageDTO[];
  decisions: MessageDTO[];
  claims: ClaimDTO[];
  /** The room's shared project context, written by the humans. */
  brief: string;
  /** Tasks that aren't done yet. */
  tasks: TaskDTO[];
}

/**
 * The one call that syncs an agent with the room. A Claude only acts when its
 * human prompts it, so instead of expecting it to poll, we keep a per-agent
 * read cursor on the server and hand over everything it missed in one go.
 */
export async function catchUp(ctx: Ctx, agent: AgentRow): Promise<CatchUp> {
  const { db } = ctx;
  const unreadQuery = { afterId: agent.readCursor, excludeAgentId: agent.id };

  const [allAgents, unread, unreadTotal, openQuestions, decisions, activeClaims, latest, allTasks, room] = await Promise.all([
    listAgents(db, agent.roomId),
    listMessages(db, agent.roomId, { ...unreadQuery, limit: CATCH_UP_LIMIT }),
    countMessages(db, agent.roomId, unreadQuery),
    listOpenQuestions(db, agent.roomId),
    listPinnedDecisions(db, agent.roomId),
    listActiveClaims(db, agent.roomId),
    latestMessageId(db, agent.roomId),
    listTasks(db, agent.roomId),
    db.select({ brief: rooms.brief }).from(rooms).where(eq(rooms.id, agent.roomId)),
  ]);

  await db.update(agents).set({ readCursor: latest, notifiedCursor: latest }).where(eq(agents.id, agent.id));

  const me = allAgents.find((a) => a.id === agent.id) ?? (await getAgentDTO(db, agent.id));
  return {
    me,
    peers: allAgents.filter((a) => a.id !== agent.id),
    unread,
    skipped: unreadTotal - unread.length,
    questionsForMe: openQuestions.filter(
      (q) => q.agentId !== agent.id && (q.toAgentId === null || q.toAgentId === agent.id),
    ),
    decisions,
    claims: activeClaims,
    brief: room[0]?.brief ?? '',
    tasks: allTasks.filter((task) => task.status !== 'done'),
  };
}

export interface SessionBriefing {
  peers: AgentDTO[];
  brief: string;
  /** Tasks this agent is in the middle of. */
  myTasks: TaskDTO[];
  openTasks: number;
  unread: number;
  questionsForMe: number;
}

/** What a brand-new session needs to know, without marking anything as read. */
export async function sessionBriefing(ctx: Ctx, agent: AgentRow): Promise<SessionBriefing> {
  const { db } = ctx;
  const [allAgents, allTasks, room, unread, openQuestions] = await Promise.all([
    listAgents(db, agent.roomId),
    listTasks(db, agent.roomId),
    db.select({ brief: rooms.brief }).from(rooms).where(eq(rooms.id, agent.roomId)),
    countMessages(db, agent.roomId, { afterId: agent.readCursor, excludeAgentId: agent.id }),
    listOpenQuestions(db, agent.roomId),
  ]);
  return {
    peers: allAgents.filter((a) => a.id !== agent.id),
    brief: room[0]?.brief ?? '',
    myTasks: allTasks.filter((t) => t.status === 'doing' && t.assigneeAgentId === agent.id),
    openTasks: allTasks.filter((t) => t.status === 'todo').length,
    unread,
    questionsForMe: openQuestions.filter((q) => q.agentId !== agent.id && (q.toAgentId === null || q.toAgentId === agent.id))
      .length,
  };
}

export interface Digest {
  /** The newest few messages this agent hasn't been told about yet, oldest first. */
  fresh: MessageDTO[];
  total: number;
}

/**
 * A lightweight "anything new?" for the Claude Code prompt hook. It never
 * marks messages as read — it only remembers what it has already announced,
 * so the same news isn't injected into every prompt.
 */
export async function peekDigest(ctx: Ctx, agent: AgentRow): Promise<Digest> {
  const query = { afterId: Math.max(agent.readCursor, agent.notifiedCursor), excludeAgentId: agent.id };
  const [fresh, total, latest] = await Promise.all([
    listMessages(ctx.db, agent.roomId, { ...query, limit: DIGEST_LIMIT }),
    countMessages(ctx.db, agent.roomId, query),
    latestMessageId(ctx.db, agent.roomId),
  ]);
  if (latest > agent.notifiedCursor) {
    await ctx.db.update(agents).set({ notifiedCursor: latest }).where(eq(agents.id, agent.id));
  }
  return { fresh, total };
}
