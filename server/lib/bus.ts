import { EventEmitter } from 'node:events';
import type { RoomEvent } from '../../shared/types';

/**
 * Fan-out of room events to whoever is listening (today: dashboard WebSockets).
 *
 * This is an interface on purpose. The in-memory version below is correct for
 * a single server process. To run several instances behind a load balancer,
 * implement the same two methods on top of Redis pub/sub or Postgres
 * LISTEN/NOTIFY and nothing else in the codebase has to change.
 */
export interface EventBus {
  publish(roomId: string, event: RoomEvent): void;
  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void;
}

export class MemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(roomId: string, event: RoomEvent): void {
    this.emitter.emit(roomId, event);
  }

  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void {
    this.emitter.on(roomId, listener);
    return () => this.emitter.off(roomId, listener);
  }
}
