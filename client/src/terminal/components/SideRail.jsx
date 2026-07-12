import { useState } from 'react';
import { getFunction } from '../registry.js';
import { parseMnemonic } from '../parser.js';

// The terminal side rail — a collapsible left column carrying two lists:
//   FAVORITES  pinned (fn, ticker) launchers the user saved (★)
//   RECENT     the last 10 tickers viewed, most-recent-first
//
// Both are backed by useTerminalPrefs (localStorage). Clicking any row opens
// it in a fresh window via onOpen(fn, ticker), matching the shell's
// spawn-don't-hijack model. The rail is purely a launcher; it never holds
// window state.

// Label for a favorite row. Ticker-bound functions read "AAPL · DES", while
// function-only favorites (MOVR, WEI) read just the mnemonic + name.
function favLabel(fav) {
  const def = getFunction(fav.fn);
  const name = def?.label || fav.fn;
  if (fav.ticker) return { primary: `${fav.ticker} ${fav.fn}`, secondary: name };
  return { primary: fav.fn, secondary: name };
}

export default function SideRail({
  collapsed,
  onToggleCollapsed,
  favorites,
  recents,
  onOpen,
  onAddFavorite,
  onRemoveFavorite,
  onClearRecents,
}) {
  const [addValue, setAddValue] = useState('');
  const [addError, setAddError] = useState('');

  function submitAdd() {
    const raw = addValue.trim();
    if (!raw) return;
    // Reuse the command parser so "AAPL DES", "MOVR", or a bare ticker all
    // resolve the same way the command bar resolves them.
    const parsed = parseMnemonic(raw);
    if (!parsed?.function) {
      setAddError('Try a ticker or mnemonic — e.g. AAPL DES, or MOVR.');
      return;
    }
    const def = getFunction(parsed.function);
    const ticker = def?.requires === 'ticker' ? parsed.ticker : null;
    if (def?.requires === 'ticker' && !ticker) {
      setAddError(`${parsed.function} needs a ticker — e.g. AAPL ${parsed.function}.`);
      return;
    }
    onAddFavorite(parsed.function, ticker);
    setAddValue('');
    setAddError('');
  }

  if (collapsed) {
    return (
      <div className="term-rail collapsed">
        <button
          className="term-rail-collapse"
          onClick={onToggleCollapsed}
          title="Show favorites & recents"
          aria-label="Show favorites and recents"
        >
          ▸
        </button>
      </div>
    );
  }

  return (
    <aside className="term-rail">
      <div className="term-rail-head">
        <span className="term-rail-brand">WATCH</span>
        <button
          className="term-rail-collapse"
          onClick={onToggleCollapsed}
          title="Collapse"
          aria-label="Collapse side rail"
        >
          ◂
        </button>
      </div>

      {/* Favorites */}
      <div className="term-rail-section">
        <div className="term-rail-title">
          <span>★ FAVORITES</span>
          <span className="ct">{favorites.length}</span>
        </div>

        <div className="term-rail-add">
          <input
            className="term-rail-add-input"
            value={addValue}
            onChange={(e) => {
              setAddValue(e.target.value);
              if (addError) setAddError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitAdd();
              }
            }}
            placeholder="add — e.g. AAPL DES"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="term-rail-add-btn" onClick={submitAdd} title="Pin to favorites">
            +
          </button>
        </div>
        {addError ? <div className="term-rail-add-err">{addError}</div> : null}

        {favorites.length === 0 ? (
          <div className="term-rail-empty">
            No favorites yet. Pin a ticker or function above, or star a window.
          </div>
        ) : (
          <ul className="term-rail-list">
            {favorites.map((fav) => {
              const { primary, secondary } = favLabel(fav);
              return (
                <li className="term-rail-row" key={`${fav.fn}|${fav.ticker || ''}`}>
                  <button
                    className="term-rail-open"
                    onClick={() => onOpen(fav.fn, fav.ticker)}
                    title={`Open ${primary}`}
                  >
                    <span className="mnem">{primary}</span>
                    <span className="name">{secondary}</span>
                  </button>
                  <button
                    className="term-rail-x"
                    onClick={() => onRemoveFavorite(fav.fn, fav.ticker)}
                    title="Remove favorite"
                    aria-label={`Remove ${primary} from favorites`}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Recent tickers */}
      <div className="term-rail-section">
        <div className="term-rail-title">
          <span>◷ RECENT</span>
          {recents.length > 0 ? (
            <button className="term-rail-clear" onClick={onClearRecents} title="Clear recents">
              clear
            </button>
          ) : (
            <span className="ct">0</span>
          )}
        </div>

        {recents.length === 0 ? (
          <div className="term-rail-empty">Tickers you view will land here.</div>
        ) : (
          <ul className="term-rail-list">
            {recents.map((ticker) => (
              <li className="term-rail-row" key={ticker}>
                <button
                  className="term-rail-open"
                  onClick={() => onOpen('DES', ticker)}
                  title={`Open ${ticker} DES`}
                >
                  <span className="mnem">{ticker}</span>
                  <span className="name">Description</span>
                </button>
                <button
                  className="term-rail-star"
                  onClick={() => onAddFavorite('DES', ticker)}
                  title="Pin to favorites"
                  aria-label={`Pin ${ticker} to favorites`}
                >
                  ★
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
