import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import AuthShell, { authFieldClass, authLinkClass } from '../components/AuthShell.jsx';
import Button from '../components/Button.jsx';

export default function ForgotPassword() {
  const { forgotPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
          <h2 className="text-xl font-semibold tracking-tight text-navy">Reset your password</h2>
          {sent ? (
            <>
              <p className="mt-2 text-sm text-navy-400">
                If an account exists for that email, we've sent a reset link. Check
                your inbox (and spam folder). The link expires in 30 minutes.
              </p>
              <Link
                to="/login"
                className={`mt-6 inline-block ${authLinkClass}`}
              >
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-navy-400">
                Enter your email and we'll send you a reset link.
              </p>
              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-navy">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={authFieldClass}
                  />
                </div>
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Sending…' : 'Send reset link'}
                </Button>
                <div className="text-center">
                  <Link to="/login" className={authLinkClass}>
                    Back to sign in
                  </Link>
                </div>
              </form>
            </>
          )}
    </AuthShell>
  );
}
