import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  serial,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** A human with a dashboard login. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

/** Browser sessions. The id is the SHA-256 of the cookie value, never the value itself. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  inviteCode: text('invite_code').notNull().unique(),
  /** Shared project context every agent reads at the start of a session. */
  brief: text('brief').notNull().default(''),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Newest message this person has seen in the dashboard; drives "new since you were here". */
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('memberships_user_idx').on(t.userId)],
);

/**
 * One connected Claude. An agent belongs to exactly one user and one room, and
 * its token is the credential the MCP endpoint accepts — so a tool call never
 * has to say which room or whose Claude it is.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hue: integer('hue').notNull().default(0),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    state: text('state', { enum: ['working', 'blocked', 'idle'] }).notNull().default('idle'),
    task: text('task'),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastTool: text('last_tool'),
    /** Highest message id this agent has been shown by `catch_up`. */
    readCursor: bigint('read_cursor', { mode: 'number' }).notNull().default(0),
    /** Highest message id the prompt hook has already announced. */
    notifiedCursor: bigint('notified_cursor', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('agents_room_idx').on(t.roomId)],
);

/**
 * The room feed. Notes, questions, answers, decisions and handoffs all live in
 * one table so the feed is a single ordered stream; `kind` says which is which.
 */
export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    authorKind: text('author_kind', { enum: ['agent', 'human'] }).notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['note', 'question', 'answer', 'decision', 'handoff', 'task'] })
      .notNull()
      .default('note'),
    title: text('title'),
    body: text('body').notNull(),
    replyTo: bigint('reply_to', { mode: 'number' }),
    /** For questions: the agent being asked. Null means "anyone in the room". */
    toAgentId: uuid('to_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('messages_room_id_idx').on(t.roomId, t.id)],
);

/** "I'm editing this path" — advisory locks that stop two Claudes colliding. */
export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    note: text('note'),
    /** True when the edit hook claimed this as the agent touched the file, rather than the agent asking. */
    auto: boolean('auto').notNull().default(false),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('claims_room_idx').on(t.roomId)],
);

/** The shared to-do list both people and agents work from. */
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    detail: text('detail'),
    status: text('status', { enum: ['todo', 'doing', 'done'] }).notNull().default('todo'),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** What was done, written by whoever finished it. */
    result: text('result'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('tasks_room_idx').on(t.roomId)],
);

export type UserRow = typeof users.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
