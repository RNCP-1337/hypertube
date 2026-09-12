import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  onUnauthenticated,
  refreshSession,
  setAccessToken,
  type AuthResponse,
  type User,
} from '../api/client';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: User) => void;
}

export interface RegisterInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  language?: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A failed refresh anywhere in the app clears the session here too.
  useEffect(() => {
    onUnauthenticated(() => {
      if (mounted.current) setUserState(null);
    });
  }, []);

  const bootstrap = useCallback(async () => {
    const ok = await refreshSession();
    if (!ok) {
      if (mounted.current) {
        setUserState(null);
        setLoading(false);
      }
      return;
    }
    try {
      const data = await api.get<{ user: User }>('/auth/me');
      if (mounted.current) setUserState(data.user);
    } catch {
      if (mounted.current) setUserState(null);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await api.post<AuthResponse>('/auth/login', { username, password });
    setAccessToken(data.accessToken);
    setUserState(data.user);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const data = await api.post<AuthResponse>('/auth/register', input);
    setAccessToken(data.accessToken);
    setUserState(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {}
    setAccessToken(null);
    setUserState(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      register,
      logout,
      refresh: bootstrap,
      setUser: setUserState,
    }),
    [user, loading, login, register, logout, bootstrap],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
