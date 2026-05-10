import { useState } from 'react';
import { authService } from '../services/AuthService';
import './AuthPage.css';

interface Props { onAuth: (username: string) => void; }

export default function AuthPage({ onAuth }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forceLogin, setForceLogin] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'signup') {
      if (!username.trim() || !email.trim() || !password) { setError('All fields are required'); return; }
      if (username.includes('@')) { setError('Username cannot be an email. Use a short name like "Aaris"'); return; }
      if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) { setError('Username can only contain letters, numbers, _ . -'); return; }
      if (username.trim().length < 2) { setError('Username must be at least 2 characters'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    } else {
      if (!username.trim() || !password) { setError('Username/email and password required'); return; }
    }

    setLoading(true);
    try {
      const result = mode === 'signup'
        ? await authService.signup(username, password, email)
        : await authService.login(username, password, 'web', forceLogin);
      onAuth(result.username);
    } catch (err: any) {
      if (err.alreadyLoggedIn) {
        setError(err.message);
        setForceLogin(true); // show force login option
      } else {
        setError(err.message || 'Something went wrong');
        setForceLogin(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: 'login' | 'signup') => { setMode(m); setError(''); setForceLogin(false); };

  return (
    <div className="auth-page">
      <div className="auth-bg" />
      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-icon">⚡</div>
          <div className="auth-logo-text">
            <h1>FlowLink</h1>
            <p>Cross-Device Continuity</p>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={`auth-tab${mode === 'login' ? ' active' : ''}`} onClick={() => switchMode('login')}>Sign In</button>
          <button className={`auth-tab${mode === 'signup' ? ' active' : ''}`} onClick={() => switchMode('signup')}>Sign Up</button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label>{mode === 'login' ? 'Username or Email' : 'Username'}</label>
            <input type="text" value={username} onChange={e => { setUsername(e.target.value); setError(''); setForceLogin(false); }}
              placeholder={mode === 'login' ? 'Username or email' : 'e.g. Aaris (no spaces or @)'}
              autoFocus autoComplete="username" maxLength={30} />
          </div>

          {mode === 'signup' && (
            <div className="auth-field">
              <label>Email</label>
              <input type="email" value={email} onChange={e => { setEmail(e.target.value); setError(''); }}
                placeholder="your@email.com" autoComplete="email" />
            </div>
          )}

          <div className="auth-field">
            <label>Password</label>
            <input type="password" value={password} onChange={e => { setPassword(e.target.value); setError(''); setForceLogin(false); }}
              placeholder="Enter your password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          </div>

          {mode === 'signup' && (
            <div className="auth-field">
              <label>Confirm Password</label>
              <input type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
                placeholder="Confirm your password" autoComplete="new-password" />
            </div>
          )}

          {error && (
            <div className="auth-error">
              ⚠ {error}
              {forceLogin && (
                <button type="submit" className="auth-force-btn" onClick={() => {}}>
                  Sign in anyway (logout other device)
                </button>
              )}
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? '⏳ Please wait…' : forceLogin ? '🔄 Force Sign In' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="auth-footer">
          {mode === 'login'
            ? <span>New to FlowLink? <button onClick={() => switchMode('signup')}>Create account</button></span>
            : <span>Already have an account? <button onClick={() => switchMode('login')}>Sign in</button></span>
          }
        </div>
      </div>
    </div>
  );
}
