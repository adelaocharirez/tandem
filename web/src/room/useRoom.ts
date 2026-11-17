import { useCallback, useEffect, useReducer, useState } from 'react';
import type { RoomEvent } from '../../../shared/types';
import { api, ApiFailure } from '../api';
import { roomReducer } from './state';

export type Connection = 'loading' | 'live' | 'reconnecting';

/**
 * Loads a room and keeps it live.
 *
 * Order matters: open the socket first, *then* fetch the snapshot, buffering
 * any events that arrive in between and replaying them on top. That way
 * nothing that happens during the fetch is lost, and since the reducer applies
 * events as upserts, replaying something the snapshot already contains is fine.
 * The same sequence runs again after every reconnect.
 */
export function useRoom(roomId: string) {
  const [state, dispatch] = useReducer(roomReducer, null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      let syncing = true;
      const buffered: RoomEvent[] = [];
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws?roomId=${roomId}`);

      socket.onopen = async () => {
        try {
          const snapshot = await api.room(roomId);
          if (disposed) return;
          dispatch({ type: 'snapshot', snapshot });
          for (const event of buffered) dispatch({ type: 'event', event });
          syncing = false;
          attempt = 0;
          setFailure(null);
          setConnection('live');
        } catch (error) {
          if (!disposed && error instanceof ApiFailure) setFailure(error);
        }
      };

      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as RoomEvent;
        if (syncing) buffered.push(event);
        else dispatch({ type: 'event', event });
      };

      socket.onclose = () => {
        if (disposed) return;
        setConnection((current) => (current === 'loading' ? 'loading' : 'reconnecting'));
        // The handshake is also where a signed-out or non-member client is
        // turned away, and a browser can't see why — so ask the API directly.
        if (attempt === 0) {
          api.room(roomId).catch((error) => {
            if (!disposed && error instanceof ApiFailure && error.status !== 0) setFailure(error);
          });
        }
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
        attempt += 1;
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [roomId]);

  const loadOlder = useCallback(async () => {
    const oldest = state?.messages[0];
    if (!oldest) return;
    const page = await api.olderMessages(roomId, oldest.id);
    dispatch({ type: 'older', ...page });
  }, [roomId, state?.messages]);

  return { state, connection, failure, loadOlder };
}
