import { and, eq, isNull } from 'drizzle-orm';
import type { TaskDTO, TaskStatus } from '../../shared/types';
import { agents, tasks, type AgentRow, type TaskRow } from '../db/schema';
import { conflict, notFound } from '../lib/http';
import { postMessage, setStatus, type Author } from './collab';
import type { Ctx } from './context';
import { getTaskDTO } from './taskRead';

export { listTasks } from './taskRead';

/**
 * The shared task board. People manage it from the dashboard; agents take
 * tasks, finish them, or hand them back through MCP tools. Everything an
 * agent does to a task is also written to the room log, so the log stays the
 * one timeline of what happened.
 */

async function requireTask(ctx: Ctx, roomId: string, taskId: number): Promise<TaskRow> {
  const [task] = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.roomId, roomId)));
  if (!task) throw notFound(`There is no task T${taskId} in this room.`);
  return task;
}

async function announce(ctx: Ctx, taskId: number): Promise<TaskDTO> {
  const task = await getTaskDTO(ctx.db, taskId);
  ctx.bus.publish(task.roomId, { type: 'task.updated', task });
  return task;
}

export async function createTask(
  ctx: Ctx,
  roomId: string,
  author: Author,
  input: { title: string; detail?: string },
): Promise<TaskDTO> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      roomId,
      title: input.title.trim(),
      detail: input.detail?.trim() || null,
      createdByUserId: author.kind === 'agent' ? author.agent.userId : author.userId,
      createdByAgentId: author.kind === 'agent' ? author.agent.id : null,
    })
    .returning();
  return announce(ctx, row!.id);
}

export interface TaskPatch {
  title?: string;
  detail?: string | null;
  status?: TaskStatus;
  assigneeAgentId?: string | null;
}

/** A person editing or moving a task from the dashboard. */
export async function updateTask(ctx: Ctx, roomId: string, taskId: number, patch: TaskPatch): Promise<TaskDTO> {
  const task = await requireTask(ctx, roomId, taskId);
  const changes: Partial<TaskRow> = { updatedAt: new Date() };

  if (patch.title !== undefined) changes.title = patch.title.trim();
  if (patch.detail !== undefined) changes.detail = patch.detail?.trim() || null;

  if (patch.assigneeAgentId !== undefined) {
    if (patch.assigneeAgentId) {
      const [agent] = await ctx.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, patch.assigneeAgentId), eq(agents.roomId, roomId), isNull(agents.revokedAt)));
      if (!agent) throw notFound('That agent is not connected to this room.');
    }
    changes.assigneeAgentId = patch.assigneeAgentId;
  }

  const status = patch.status ?? task.status;
  if (patch.status !== undefined && patch.status !== task.status) {
    changes.status = patch.status;
    changes.completedAt = patch.status === 'done' ? new Date() : null;
    // Back on the pile means nobody owns it.
    if (patch.status === 'todo') changes.assigneeAgentId = null;
  }
  // Assigning a waiting task to an agent starts it.
  if (patch.assigneeAgentId && status === 'todo' && patch.status === undefined) changes.status = 'doing';

  await ctx.db.update(tasks).set(changes).where(eq(tasks.id, taskId));
  return announce(ctx, taskId);
}

export async function deleteTask(ctx: Ctx, roomId: string, taskId: number): Promise<void> {
  await requireTask(ctx, roomId, taskId);
  await ctx.db.delete(tasks).where(eq(tasks.id, taskId));
  ctx.bus.publish(roomId, { type: 'task.removed', taskId });
}

// ── What agents do ──────────────────────────────────────────────────────────

const agentName = async (ctx: Ctx, agentId: string) =>
  (await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)))[0]?.name ?? 'another agent';

/** Claim a task. Refused if another agent is already on it, so two Claudes never do the same work. */
export async function takeTask(ctx: Ctx, agent: AgentRow, taskId: number): Promise<TaskDTO> {
  const task = await requireTask(ctx, agent.roomId, taskId);
  if (task.status === 'done') throw conflict(`T${taskId} is already done.`);
  if (task.status === 'doing' && task.assigneeAgentId && task.assigneeAgentId !== agent.id) {
    throw conflict(`T${taskId} is already being done by ${await agentName(ctx, task.assigneeAgentId)}. Pick another task.`);
  }
  if (task.status === 'doing' && task.assigneeAgentId === agent.id) return getTaskDTO(ctx.db, taskId);

  await ctx.db
    .update(tasks)
    .set({ status: 'doing', assigneeAgentId: agent.id, updatedAt: new Date(), completedAt: null })
    .where(eq(tasks.id, taskId));
  const updated = await announce(ctx, taskId);
  // Taking a task *is* a status update; save the agent a second call.
  await setStatus(ctx, agent, { state: 'working', task: `T${taskId}: ${task.title}` });
  await postMessage(ctx, agent.roomId, { kind: 'agent', agent }, { kind: 'task', body: `Took T${taskId}: ${task.title}` });
  return updated;
}

export async function completeTask(ctx: Ctx, agent: AgentRow, taskId: number, summary: string): Promise<TaskDTO> {
  const task = await requireTask(ctx, agent.roomId, taskId);
  if (task.status === 'done') throw conflict(`T${taskId} is already done.`);
  if (task.assigneeAgentId && task.assigneeAgentId !== agent.id) {
    throw conflict(`T${taskId} belongs to ${await agentName(ctx, task.assigneeAgentId)}. Only they can finish it.`);
  }

  const now = new Date();
  await ctx.db
    .update(tasks)
    .set({ status: 'done', assigneeAgentId: agent.id, result: summary.trim(), updatedAt: now, completedAt: now })
    .where(eq(tasks.id, taskId));
  const updated = await announce(ctx, taskId);
  await postMessage(
    ctx,
    agent.roomId,
    { kind: 'agent', agent },
    { kind: 'task', title: `Finished T${taskId}: ${task.title}`, body: summary },
  );
  return updated;
}

/** Hand a task back, with the reason, so someone else can pick it up. */
export async function dropTask(ctx: Ctx, agent: AgentRow, taskId: number, reason: string): Promise<TaskDTO> {
  const task = await requireTask(ctx, agent.roomId, taskId);
  if (task.status !== 'doing' || task.assigneeAgentId !== agent.id) {
    throw conflict(`You are not working on T${taskId}, so there is nothing to hand back.`);
  }
  await ctx.db
    .update(tasks)
    .set({ status: 'todo', assigneeAgentId: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  const updated = await announce(ctx, taskId);
  await postMessage(
    ctx,
    agent.roomId,
    { kind: 'agent', agent },
    { kind: 'task', title: `Handed back T${taskId}: ${task.title}`, body: reason },
  );
  return updated;
}
