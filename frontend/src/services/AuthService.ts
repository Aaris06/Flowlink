import { SIGNALING_HTTP_URL } from '../config/signaling';

const TOKEN_KEY = 'flowlink_token';
const USERNAME_KEY = 'flowlink_username';

export interface AuthUser {
  username: string;
  token: string;
}

class AuthService {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  getUsername(): string | null {
    return localStorage.getItem(USERNAME_KEY);
  }

  isLoggedIn(): boolean {
    return !!this.getToken() && !!this.getUsername();
  }

  async signup(username: string, password: string): Promise<AuthUser> {
    const res = await fetch(`${SIGNALING_HTTP_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    this.saveAuth(data.token, data.username);
    return data;
  }

  async login(username: string, password: string): Promise<AuthUser> {
    const res = await fetch(`${SIGNALING_HTTP_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    this.saveAuth(data.token, data.username);
    return data;
  }

  async verifyToken(): Promise<string | null> {
    const token = this.getToken();
    if (!token) return null;
    try {
      const res = await fetch(`${SIGNALING_HTTP_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { this.logout(); return null; }
      const data = await res.json();
      return data.username;
    } catch {
      return this.getUsername(); // offline fallback
    }
  }

  saveAuth(token: string, username: string) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USERNAME_KEY, username);
  }

  logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    localStorage.removeItem('flowlink_inbox_unread');
  }

  authHeader(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}

export const authService = new AuthService();
