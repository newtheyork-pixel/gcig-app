import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// Wipes the whole DB book (every position, lot, and cash transaction) and
// re-imports the original positions + cash from the sheet — the escape hatch
// for a portfolio messed up by test trades or bad data. Super-admin only,
// behind a hard confirm.
export default function ResetBookButton({ onReset }) {
  const { isSuperAdmin } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!isSuperAdmin) return null;

  async function reset() {
    const ok = window.confirm(
      'Reset the book?\n\n' +
        'This WIPES every position, lot, and cash transaction in the database — ' +
        'including any trades you made — and re-imports the original positions and ' +
        'cash fresh from the Google Sheet.\n\n' +
        'Use this to undo test data. Continue?'
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      // force:true — the user has confirmed via the dialog above; the server
      // otherwise refuses to wipe real recorded trades/movements.
      await api.post('/holdings/import-from-sheet', { commit: true, reset: true, force: true });
      onReset?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-navy-50 pt-3">
      <button
        type="button"
        onClick={reset}
        disabled={busy}
        className="flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:text-red-800 disabled:opacity-50"
      >
        <RotateCcw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Resetting…' : 'Reset book from sheet'}
      </button>
      <span className="text-[11px] text-navy-400">
        Wipes the DB book and re-imports the original positions + cash (undo test data).
      </span>
      {error && <span className="text-xs font-semibold text-red-700">{error}</span>}
    </div>
  );
}
