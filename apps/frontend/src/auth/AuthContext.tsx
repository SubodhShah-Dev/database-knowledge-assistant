import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  clearAuth,
  getToken,
  getUser,
  setToken,
  setUser,
  signIn as apiSignIn,
  signUp as apiSignUp,
  getUserProfile,
  updateUserProfile
} from '../api/client';
import type { User } from '../types';

type AuthContextValue = {
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateUser: (partial: Partial<User>) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUserState] = useState<User | null>(() => getUser());

  const login = useCallback(async (email: string, password: string) => {
    const response = await apiSignIn(email, password);
    setToken(response.token);
    setUser(response.user);
    setTokenState(response.token);
    setUserState(response.user);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const response = await apiSignUp(email, password);
    setToken(response.token);
    setUser(response.user);
    setTokenState(response.token);
    setUserState(response.user);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setTokenState(null);
    setUserState(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const freshUser = await getUserProfile();
      setUser(freshUser);
      setUserState(freshUser);
    } catch {
      // If refresh fails, user might be logged out - let the API interceptor handle it
    }
  }, []);

  const updateUser = useCallback((partial: Partial<User>) => {
    setUserState(current => {
      if (!current) return null;
      const updated = { ...current, ...partial };
      setUser(updated);
      return updated;
    });
  }, []);

  const value = useMemo(
    () => ({ token, user, login, register, logout, refreshUser, updateUser }),
    [token, user, login, register, logout, refreshUser, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
