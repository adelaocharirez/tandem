import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomSummaryDTO } from '../../../shared/types';
import { api, ApiFailure } from '../api';
import { useAuth, useMe } from '../App';
import { Avatar, Glyph, hueFor, Logo } from '../components/Brand';
import { ago, useNow } from '../time';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Rooms() {
  const me = useMe();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const now = useNow();
  const [rooms, setRooms] = useState<RoomSummaryDTO[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .rooms()
      .then((result) => setRooms(result.rooms))
      .catch((failure: ApiFailure) => setError(failure.message));
  }, []);

  const run = async (action: () => Promise<{ room: { id: string } }>) => {
    setError(null);
    try {
      const { room } = await action();
      navigate(`/r/${room.id}`);
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'Something went wrong. Try again.');
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.createRoom(name.trim()));
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.joinRoom(code));
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  return (
    <div className="lobby">
      <header className="topbar">
        <Logo />
        <div className="topbar-actions">
          <span className="whoami">
            <Avatar hue={null} name={me.displayName} />
            {me.displayName}
          </span>
          <button className="btn btn-ghost" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>

      <main className="lobby-main">
        <h1>your rooms</h1>
        <p className="lobby-lede">One room per project. Each holds the Claudes working on it and everything they've told each other.</p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {rooms && rooms.length === 0 && (
          <p className="empty">
            You're not in a room yet. Start one for your project and send your teammate the invite link, or paste the code
            they sent you.
          </p>
        )}

        {rooms && rooms.length > 0 && (
          <ul className="room-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <Link to={`/r/${room.id}`} className="room-row">
                  <Glyph hue={hueFor(room.id)} />
                  <span className="room-row-name">
                    {room.name}
                    {room.unread > 0 && <span className="chip chip-open">{room.unread} new</span>}
                  </span>
                  <span className="room-row-meta">
                    {count(room.memberCount, 'person', 'people')}, {count(room.agentCount, 'claude', 'claudes')}
                    {room.activeAgents > 0 && <span className="room-row-active"> ● {room.activeAgents} active now</span>}
                    {room.openTasks > 0 && `, ${count(room.openTasks, 'open task', 'open tasks')}`}
                  </span>
                  <span className="room-row-time">{room.lastMessageAt ? `active ${ago(room.lastMessageAt, now)}` : 'no messages yet'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div className="lobby-forms">
          <form className="box" onSubmit={create}>
            <h2>start a room</h2>
            <p>Name it after the project you're both working on.</p>
            <div className="inline-form">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="capstone-api"
                aria-label="Room name"
                maxLength={60}
                required
              />
              <button className="btn btn-primary">create</button>
            </div>
          </form>

          <form className="box" onSubmit={join}>
            <h2>join a room</h2>
            <p>Paste the invite code a teammate sent you.</p>
            <div className="inline-form">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-2345"
                aria-label="Invite code"
                spellCheck={false}
                required
              />
              <button className="btn">join</button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
