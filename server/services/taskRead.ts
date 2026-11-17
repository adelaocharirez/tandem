import { and, desc, eq, ne } from 'drizzle-orm';
import type { TaskDTO } from '../../shared/types';
import type { Db } from '../db/client';
import { agents, tasks, users, type TaskRow } from '../db/schema';
import { notFound } from '../lib/http';
import { iso, isoOrNull } from './context';

/** How many finished tasks to keep showing. Older ones stay in the database. */
const DONE_SHOWN = 30;

interface TaskJoinRow {
  task: TaskRow;
  agentName: string | null;
  userName: string;
}

const toTaskDTO = ({ task, agentName, userName }: TaskJoinRow): TaskDTO => ({
  id: task.id,
  roomId: task.roomId,
  title: task.title,
  detail: task.detail,
  status: task.status,
  assigneeAgentId: task.assigneeAgentId,
  createdByName: agentName ?? userName,
  result: task.result,
  createdAt: iso(task.createdAt),
  updatedAt: iso(task.updatedAt),
  completedAt: isoOrNull(task.completedAt),
});

function selectTasks(db: Db) {
  return db
    .select({ task: tasks, agentName: agents.name, userName: users.displayName })
    .from(tasks)
    .leftJoin(agents, eq(tasks.createdByAgentId, agents.id))
    .innerJoin(users, eq(tasks.createdByUserId, users.id));
}

/** Every task that isn't done, oldest first, followed by the most recently finished ones. */
export async function listTasks(db: Db, roomId: string): Promise<TaskDTO[]> {
  const [open, done] = await Promise.all([
    selectTasks(db)
      .where(and(eq(tasks.roomId, roomId), ne(tasks.status, 'done')))
      .orderBy(tasks.id),
    selectTasks(db)
      .where(and(eq(tasks.roomId, roomId), eq(tasks.status, 'done')))
      .orderBy(desc(tasks.completedAt))
      .limit(DONE_SHOWN),
  ]);
  return [...open, ...done].map(toTaskDTO);
}

export async function getTaskDTO(db: Db, taskId: number): Promise<TaskDTO> {
  const [row] = await selectTasks(db).where(eq(tasks.id, taskId));
  if (!row) throw notFound(`Task T${taskId} does not exist.`);
  return toTaskDTO(row);
}
