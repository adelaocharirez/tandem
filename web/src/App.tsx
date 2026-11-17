import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { UserDTO } from '../../shared/types';
import { api, ApiFailure } from './api';
import { Login } from './pages/Login';
import { Room } from './pages/Room';
import { Rooms } from './pages/Rooms';

interface Auth {
  user: UserDTO | null;
  setUser: (user: UserDTO | null) => void;
}

const AuthContext = createContext<Auth>({ user: null, setUser: () => {} });
export const useAuth = () => useContext(AuthContext);

/** The signed-in user, for pages that only render behind <RequireAuth>. */
export function useMe(): UserDTO {
  const { user } = useAuth();
  if (!user) throw new Error('useMe() used outside <RequireAuth>');
  return user;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return children;
}

/** Target of invite links: join the room, then go straight into it. */
function Join() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .joinRoom(code)
      .then(({ room }) => !cancelled && navigate(`/r/${room.id}`, { replace: true }))
      .catch((failure: ApiFailure) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, [code, navigate]);

  return (
    <div className="center-note">
      {error ? (
        <>
          <p>{error}</p>
          <a href="/">Go to your rooms</a>
        </>
      ) : (
        <p>Joining the room…</p>
      )}
    </div>
  );
}

export function App() {
  // undefined = still asking the server who we are.
  const [user, setUser] = useState<UserDTO | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center-note" aria-busy="true" />;

  return (
    <AuthContext value={{ user, setUser }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Rooms /></RequireAuth>} />
          <Route path="/r/:roomId" element={<RequireAuth><Room /></RequireAuth>} />
          <Route path="/join/:code" element={<RequireAuth><Join /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext>
  );
}
