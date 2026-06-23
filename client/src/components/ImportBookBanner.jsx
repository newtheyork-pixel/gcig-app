import { useState } from 'react';
import { Database, AlertTriangle, Check } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';

// Shown only to a super admin when the app is in db mode but the book hasn't
// been imported yet (source === 'db-empty'). The page is still serving the
// sheet, so nothing is broken; this is the one-click cutover. Preview reads the
// sheet and shows exactly what would be written; Import commits it server-side
// and reconciles to the dollar (rolling back on any mismatch), after which the
// page reloads as a real DB-backed book.
function usd(n) {
  return n == null
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export default function ImportBookBanner({ onImported }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function preview() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/holdings/import-from-sheet', { commit: false });
      setPlan(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to read the sheet');
    } finally {
      setLoading(false);
    }
  }

  async function commit() {
    setLoading(true);
    setError('');
    try {
      await api.post('/holdings/import-from-sheet', { commit: true });
      setDone(true);
      onImported?.(); // reloads the portfolio — now db-backed, so this banner unmounts
    } catch (e) {
      setError(e.response?.data?.error || 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  const blocked = plan?.skipped?.length > 0;

  return (
    <div className="mb-6 rounded-xl border border-gold-300 bg-gold-50 p-4">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 shrink-0 text-gold-700" />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-base font-semibold text-navy">
            Database mode is on, but the book isn't imported yet
          </div>
          <p className="mt-1 text-sm text-navy-600">
            The portfolio is set to <code className="rounded bg-white px-1">db</code> mode, but no positions are
            in the database yet — so this page is still showing the Google Sheet. Import the current book to go
            live; you'll then manage holdings, cash, and trades right here. Reversible: set{' '}
            <code className="rounded bg-white px-1">PORTFOLIO_SOURCE</code> back to{' '}
            <code className="rounded bg-white px-1">sheet</code> anytime.
          </p>

          {plan && !done && (
            <div className="mt-3 rounded-lg border border-gold-200 bg-white p-3 text-sm">
              <div className="font-semibold text-navy">This will import:</div>
              <ul className="mt-1 space-y-0.5 text-navy-600">
                <li>
                  {plan.positions.length} positions · cost basis{' '}
                  <span className="font-semibold text-navy">{usd(plan.totalCost)}</span>
                </li>
                <li>
                  opening cash <span className="font-semibold text-navy">{usd(plan.openingCash)}</span>
                </li>
                {blocked && (
                  <li className="font-semibold text-red-700">
                    {plan.skipped.length} sheet row(s) are incomplete and will block the import — fix them on
                    the sheet first.
                  </li>
                )}
              </ul>
            </div>
          )}

          {done && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <Check className="h-4 w-4" /> Imported and reconciled to the sheet. Loading the live book…
            </div>
          )}

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {!done && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!plan ? (
                <Button variant="gold" onClick={preview} disabled={loading}>
                  {loading ? 'Reading sheet…' : 'Preview import'}
                </Button>
              ) : (
                <>
                  <Button variant="gold" onClick={commit} disabled={loading || blocked}>
                    {loading ? 'Importing…' : `Import ${plan.positions.length} positions + cash`}
                  </Button>
                  <Button variant="outline" onClick={() => setPlan(null)} disabled={loading}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
