import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http';
import { listMessages, postMessage, releaseClaimById, updateMessage } from '../services/collab';
import {
  createAgent,
  createRoom,
  joinRoom,
  listRoomsForUser,
  markRead,
  requireMembership,
  revokeAgent,
  roomSnapshot,
  updateRoom,
} from '../services/rooms';
import { createTask, deleteTask, updateTask } from '../services/tasks';
import type { RouteEnv } from './env';

const roomParams = z.object({ roomId: z.uuid() });
const createRoomBody = z.object({ name: z.string().trim().min(1).max(60) });
const joinRoomBody = z.object({ inviteCode: z.string().trim().min(4).max(20) });

const postMessageBody = z.object({
  kind: z.enum(['note', 'question', 'answer', 'decision']).default('note'),
  body: z.string().trim().min(1).max(8000),
  title: z.string().trim().max(120).optional(),
  replyTo: z.number().int().positive().optional(),
  toAgentId: z.uuid().optional(),
});

const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const patchMessageBody = z
  .object({ pinned: z.boolean().optional(), resolved: z.boolean().optional() })
  .refine((v) => v.pinned !== undefined || v.resolved !== undefined, 'Nothing to change.');

const createAgentBody = z.object({ name: z.string().trim().min(1).max(40) });

const patchRoomBody = z
  .object({ name: z.string().trim().min(1).max(60).optional(), brief: z.string().max(20_000).optional() })
  .refine((v) => v.name !== undefined || v.brief !== undefined, 'Nothing to change.');
const readBody = z.object({ messageId: z.number().int().nonnegative() });

const taskParams = roomParams.extend({ taskId: z.coerce.number().int().positive() });
const createTaskBody = z.object({ title: z.string().trim().min(1).max(140), detail: z.string().trim().max(2000).optional() });
const patchTaskBody = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  detail: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  assigneeAgentId: z.uuid().nullable().optional(),
});

export function registerRoomRoutes(app: FastifyInstance, env: RouteEnv): void {
  const { ctx } = env;

  app.get('/api/rooms', async (request) => {
    const user = await env.currentUser(request);
    return { rooms: await listRoomsForUser(ctx.db, user.id) };
  });

  app.post('/api/rooms', async (request, reply) => {
    const user = await env.currentUser(request);
    const { name } = parse(createRoomBody, request.body);
    return reply.code(201).send({ room: await createRoom(ctx.db, user, name) });
  });

  app.post('/api/rooms/join', async (request) => {
    const user = await env.currentUser(request);
    const { inviteCode } = parse(joinRoomBody, request.body);
    return { room: await joinRoom(ctx, user, inviteCode) };
  });

  app.get('/api/rooms/:roomId', async (request) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    const room = await requireMembership(ctx.db, roomId, user.id);
    return roomSnapshot(ctx.db, room, user);
  });

  app.patch('/api/rooms/:roomId', async (request) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    const room = await requireMembership(ctx.db, roomId, user.id);
    return { room: await updateRoom(ctx, room, parse(patchRoomBody, request.body)) };
  });

  app.post('/api/rooms/:roomId/read', async (request) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    await requireMembership(ctx.db, roomId, user.id);
    await markRead(ctx.db, roomId, user.id, parse(readBody, request.body).messageId);
    return { ok: true };
  });

  // ── Task board ────────────────────────────────────────────────────────────

  app.post('/api/rooms/:roomId/tasks', async (request, reply) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    await requireMembership(ctx.db, roomId, user.id);
    const task = await createTask(ctx, roomId, { kind: 'human', userId: user.id }, parse(createTaskBody, request.body));
    return reply.code(201).send({ task });
  });

  app.patch('/api/rooms/:roomId/tasks/:taskId', async (request) => {
    const user = await env.currentUser(request);
    const params = parse(taskParams, request.params);
    await requireMembership(ctx.db, params.roomId, user.id);
    return { task: await updateTask(ctx, params.roomId, params.taskId, parse(patchTaskBody, request.body)) };
  });

  app.delete('/api/rooms/:roomId/tasks/:taskId', async (request) => {
    const user = await env.currentUser(request);
    const params = parse(taskParams, request.params);
    await requireMembership(ctx.db, params.roomId, user.id);
    await deleteTask(ctx, params.roomId, params.taskId);
    return { ok: true };
  });

  // ── Feed ──────────────────────────────────────────────────────────────────

  app.get('/api/rooms/:roomId/messages', async (request) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    await requireMembership(ctx.db, roomId, user.id);
    const { before, limit } = parse(historyQuery, request.query);
    const page = await listMessages(ctx.db, roomId, { beforeId: before, limit: limit + 1 });
    const hasMore = page.length > limit;
    return { messages: hasMore ? page.slice(1) : page, hasMore };
  });

  app.post('/api/rooms/:roomId/messages', async (request, reply) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    await requireMembership(ctx.db, roomId, user.id);
    const body = parse(postMessageBody, request.body);
    const message = await postMessage(ctx, roomId, { kind: 'human', userId: user.id }, body);
    return reply.code(201).send({ message });
  });

  app.patch('/api/rooms/:roomId/messages/:messageId', async (request) => {
    const user = await env.currentUser(request);
    const params = parse(roomParams.extend({ messageId: z.coerce.number().int().positive() }), request.params);
    await requireMembership(ctx.db, params.roomId, user.id);
    const patch = parse(patchMessageBody, request.body);
    return { message: await updateMessage(ctx, params.roomId, params.messageId, patch) };
  });

  // ── Agents ────────────────────────────────────────────────────────────────

  app.post('/api/rooms/:roomId/agents', async (request, reply) => {
    const user = await env.currentUser(request);
    const { roomId } = parse(roomParams, request.params);
    const room = await requireMembership(ctx.db, roomId, user.id);
    const { name } = parse(createAgentBody, request.body);
    return reply.code(201).send(await createAgent(ctx, room, user, name, env.publicUrl(request)));
  });

  app.delete('/api/rooms/:roomId/agents/:agentId', async (request) => {
    const user = await env.currentUser(request);
    const params = parse(roomParams.extend({ agentId: z.uuid() }), request.params);
    await requireMembership(ctx.db, params.roomId, user.id);
    await revokeAgent(ctx, params.roomId, params.agentId, user.id);
    return { ok: true };
  });

  // ── Claims ────────────────────────────────────────────────────────────────

  app.delete('/api/rooms/:roomId/claims/:claimId', async (request) => {
    const user = await env.currentUser(request);
    const params = parse(roomParams.extend({ claimId: z.uuid() }), request.params);
    await requireMembership(ctx.db, params.roomId, user.id);
    await releaseClaimById(ctx, params.roomId, params.claimId);
    return { ok: true };
  });
}
