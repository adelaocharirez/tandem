import { useEffect, useState } from 'react';

/** A clock that ticks every `intervalMs`, so "3m ago" labels stay true without each one owning a timer. */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function timeLeft(iso: string, now: number): string {
  const minutes = Math.max(1, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** An agent counts as active if it called the room in the last few minutes. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
export const isActive = (lastSeenAt: string | null, now: number) =>
  lastSeenAt !== null && now - new Date(lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
