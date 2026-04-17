import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, Smartphone, Mail } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';

/**
 * Two independent methods — TOTP and Email. A user can have both on, one, or
 * neither. Each method has its own enable / disable flow.
 */
export default function TwoFactorPanel() {
  const [status, setStatus] = useState(null);
  const [activePanel, setActivePanel] = useState(null); // 'totp-setup' | 'email-setup' | 'totp-disable' | 'email-disable'
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadStatus() {
    const { data } = await api.get('/auth/me');
    setStatus(data);
  }

  useEffect(() => {
    loadStatus();
  }, []);

  function reset() {
    setActivePanel(null);
    setSetup(null);
    setCode('');
    setPassword('');
    setError('');
  }

  async function startTotp() {
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/setup');
      setSetup(data);
      setActivePanel('totp-setup');
    } catch (err) {
      setError(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirmTotp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/2fa/verify-setup', { code });
      setMessage('Authenticator app enabled.');
      reset();
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function submitTotpDisable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/disable-totp', { password, code });
      if (data.token) localStorage.setItem('gcig_token', data.token);
      setMessage('Authenticator app disabled.');
      reset();
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Disable failed');
    } finally {
      setLoading(false);
    }
  }

  async function startEmail() {
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/setup-email');
      setSetup({ email: data.email });
      setActivePanel('email-setup');
    } catch (err) {
      setError(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirmEmail(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/2fa/verify-setup-email', { code });
      setMessage('Email 2FA enabled.');
      reset();
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function resendSetupEmail() {
    setError('');
    setMessage('');
    try {
      await api.post('/2fa/resend-setup-email');
      setMessage('New code sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resend');
    }
  }

  async function sendDisableEmailCode() {
    setError('');
    setMessage('');
    try {
      await api.post('/2fa/send-disable-email-code');
      setMessage('Code sent — check your inbox.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send code');
    }
  }

  async function submitEmailDisable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/disable-email', { password, code });
      if (data.token) localStorage.setItem('gcig_token', data.token);
      setMessage('Email 2FA disabled.');
      reset();
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Disable failed');
    } finally {
      setLoading(false);
    }
  }

  if (!status) return <div className="text-navy-400">Loading…</div>;

  // ── Per-method setup / disable sub-panels ──────────────────────────

  if (activePanel === 'totp-setup' && setup) {
    return (
      <div className="space-y-5">
        <div>
          <div className="text-sm font-semibold text-navy">1. Scan this QR code</div>
          <p className="mt-1 text-xs text-navy-400">
            In Google Authenticator, Authy, 1Password, or any TOTP app.
          </p>
          <img
            src={setup.qrCodeDataUrl}
            alt="2FA QR code"
            className="mt-3 h-48 w-48 rounded-lg border border-navy-100 bg-white"
          />
          <details className="mt-2 text-xs text-navy-400">
            <summary className="cursor-pointer">Can't scan? Enter manually</summary>
            <div className="mt-2 rounded-lg bg-navy-50 p-2 font-mono text-navy break-all">
              {setup.secret}
            </div>
          </details>
        </div>
        <form onSubmit={confirmTotp} className="space-y-3 border-t border-navy-100 pt-4">
          <div className="text-sm font-semibold text-navy">
            2. Enter the 6-digit code from your app
          </div>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            className="w-full rounded-lg border border-navy-100 px-3 py-2 text-center text-xl font-bold tracking-widest text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !code}>
              {loading ? 'Verifying…' : 'Enable authenticator app'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (activePanel === 'email-setup' && setup) {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-sm font-semibold text-navy">Check your email</div>
          <p className="mt-1 text-sm text-navy-400">
            We sent an 8-character code to <strong>{setup.email}</strong>. Enter it below.
          </p>
        </div>
        <form onSubmit={confirmEmail} className="space-y-3">
          <input
            type="text"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            className="w-full rounded-lg border border-navy-100 px-3 py-3 text-center text-xl font-bold tracking-[0.3em] font-mono text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          {message && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !code}>
              {loading ? 'Verifying…' : 'Enable email 2FA'}
            </Button>
          </div>
          <div className="text-center">
            <button
              type="button"
              onClick={resendSetupEmail}
              className="text-xs font-semibold text-gold-700 underline"
            >
              Resend code
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (activePanel === 'totp-disable') {
    return (
      <form onSubmit={submitTotpDisable} className="space-y-3">
        <p className="text-sm text-navy">
          Turn off the authenticator app. Confirm with your password and a current code.
        </p>
        <div>
          <label className="block text-sm font-medium text-navy">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-navy">Authenticator code</label>
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={reset}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={loading}>
            {loading ? 'Disabling…' : 'Turn off authenticator'}
          </Button>
        </div>
      </form>
    );
  }

  if (activePanel === 'email-disable') {
    return (
      <form onSubmit={submitEmailDisable} className="space-y-3">
        <p className="text-sm text-navy">
          Turn off email 2FA. Confirm with your password and an emailed code.
        </p>
        <div>
          <label className="block text-sm font-medium text-navy">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-navy">Email code</label>
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          <button
            type="button"
            onClick={sendDisableEmailCode}
            className="mt-1 text-xs font-semibold text-gold-700 underline"
          >
            Send me a code
          </button>
        </div>
        {message && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={reset}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={loading}>
            {loading ? 'Disabling…' : 'Turn off email 2FA'}
          </Button>
        </div>
      </form>
    );
  }

  // ── Overview ────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        {status.twoFactorEnabled ? (
          <ShieldCheck className="h-8 w-8 shrink-0 text-emerald-600" />
        ) : (
          <ShieldOff className="h-8 w-8 shrink-0 text-navy-400" />
        )}
        <div>
          <div className="font-semibold text-navy">
            {status.twoFactorEnabled
              ? 'Two-factor authentication is ON'
              : 'Two-factor authentication is OFF'}
          </div>
          <p className="mt-1 text-sm text-navy-400">
            {status.twoFactorEnabled
              ? "You'll need a code every sign-in. If you get locked out, ask the President to reset."
              : 'Add at least one method to protect your account.'}
          </p>
        </div>
      </div>

      {message && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <MethodRow
        icon={<Smartphone className="h-5 w-5" />}
        title="Authenticator app"
        description="Google Authenticator, Authy, 1Password — strongest option."
        enabled={status.twoFactorTotpEnabled}
        onEnable={startTotp}
        onDisable={() => setActivePanel('totp-disable')}
        loading={loading}
      />
      <MethodRow
        icon={<Mail className="h-5 w-5" />}
        title="Email code"
        description="We email you an 8-character code every sign-in."
        enabled={status.twoFactorEmailEnabled}
        onEnable={startEmail}
        onDisable={() => setActivePanel('email-disable')}
        loading={loading}
      />
    </div>
  );
}

function MethodRow({ icon, title, description, enabled, onEnable, onDisable, loading }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-100 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 text-navy">{icon}</div>
        <div className="min-w-0">
          <div className="font-semibold text-navy">{title}</div>
          <div className="mt-0.5 text-xs text-navy-400">{description}</div>
          <div
            className={`mt-1 text-[10px] font-bold uppercase ${
              enabled ? 'text-emerald-700' : 'text-navy-400'
            }`}
          >
            {enabled ? 'On' : 'Off'}
          </div>
        </div>
      </div>
      <div className="shrink-0">
        {enabled ? (
          <Button variant="outline" onClick={onDisable}>
            Turn off
          </Button>
        ) : (
          <Button onClick={onEnable} disabled={loading}>
            Turn on
          </Button>
        )}
      </div>
    </div>
  );
}
