import type { Db } from '../db/client';
import type { EventBus } from '../lib/bus';

/** What every service function needs: somewhere to store things and somewhere to announce them. */
export interface Ctx {
  db: Db;
  bus: EventBus;
}

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
