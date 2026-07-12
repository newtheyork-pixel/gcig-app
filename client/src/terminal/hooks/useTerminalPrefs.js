import { useCallback, useEffect, useState } from 'react';

// Per-user terminal preferences: the last N tickers viewed (Recents) and a
// pinned set of tickers + functions (Favorites). Persisted to localStorage
// keyed by user id so a member's rail survives reloads and follows the
// account on a shared machine, without needing a DB migration or a server
// round-trip. The shell records recents; the side rail reads/edits both.
//
// Storage shape (JSON):
//   { recents: ["AAPL", "NVDA", ...],            // most-recent-first, max 10
//     favorites: [{ fn: "DES", ticker: "AAPL" }, // most-recent-first, max 40
//                 { fn: "MOVR", ticker: null }] }

const MAX_RECENTS = 10;
const MAX_FAVORITES = 40;
const STORAGE_PREFIX = 'gcig_term_prefs_v1';

function storageKey(userId) {
  return `${STORAGE_PREFIX}:${userId ?? 'anon'}`;
}

function readStore(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { recents: [], favorites: [] };
    const parsed = JSON.parse(raw);
    return {
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    };
  } catch {
    return { recents: [], favorites: [] };
  }
}

function writeStore(userId, store) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(store));
  } catch {
    /* quota / private mode — prefs just won't persist this session */
  }
}

// A favorite is uniquely identified by (fn, ticker). Function-only favorites
// (MOVR, WEI, TOP…) carry a null ticker.
function favKey(fav) {
  return `${String(fav.fn || '').toUpperCase()}|${String(fav.ticker || '').toUpperCase()}`;
}

export default function useTerminalPrefs(userId) {
  const [store, setStore] = useState(() => readStore(userId));

  // Re-hydrate if the signed-in user changes (e.g. account switch) so one
  // member's rail never bleeds into another's on a shared browser.
  useEffect(() => {
    setStore(readStore(userId));
  }, [userId]);

  // Persist on every change.
  useEffect(() => {
    writeStore(userId, store);
  }, [userId, store]);

  // Record a ticker view. Dedupes (case-insensitive), moves the ticker to the
  // front, and trims to MAX_RECENTS. No-ops for empty/blank tickers so
  // function-only windows (MOVR, WEI) never pollute the ticker history.
  const recordTicker = useCallback((rawTicker) => {
    const ticker = String(rawTicker || '').trim().toUpperCase();
    if (!ticker) return;
    setStore((prev) => {
      const withoutDupe = prev.recents.filter((t) => t !== ticker);
      const recents = [ticker, ...withoutDupe].slice(0, MAX_RECENTS);
      // Skip the state churn if nothing actually changed (same head).
      if (
        recents.length === prev.recents.length &&
        recents.every((t, i) => t === prev.recents[i])
      ) {
        return prev;
      }
      return { ...prev, recents };
    });
  }, []);

  const clearRecents = useCallback(() => {
    setStore((prev) => (prev.recents.length ? { ...prev, recents: [] } : prev));
  }, []);

  const isFavorite = useCallback(
    (fn, ticker) => {
      const key = favKey({ fn, ticker: ticker || null });
      return store.favorites.some((f) => favKey(f) === key);
    },
    [store.favorites]
  );

  // Toggle a (fn, ticker) favorite. Newly-added favorites go to the front.
  // Used by the window titlebar star, where a second click should un-pin.
  const toggleFavorite = useCallback((fn, ticker) => {
    const entry = {
      fn: String(fn || '').toUpperCase(),
      ticker: ticker ? String(ticker).toUpperCase() : null,
    };
    if (!entry.fn) return;
    const key = favKey(entry);
    setStore((prev) => {
      const exists = prev.favorites.some((f) => favKey(f) === key);
      const favorites = exists
        ? prev.favorites.filter((f) => favKey(f) !== key)
        : [entry, ...prev.favorites].slice(0, MAX_FAVORITES);
      return { ...prev, favorites };
    });
  }, []);

  // Add-only variant — no-op if the pair is already pinned. Used by the rail's
  // "add" button and the recent-row star, where the gesture means "pin this",
  // never "un-pin it" (which a toggle would surprisingly do on a duplicate).
  const addFavorite = useCallback((fn, ticker) => {
    const entry = {
      fn: String(fn || '').toUpperCase(),
      ticker: ticker ? String(ticker).toUpperCase() : null,
    };
    if (!entry.fn) return;
    const key = favKey(entry);
    setStore((prev) => {
      if (prev.favorites.some((f) => favKey(f) === key)) return prev;
      return { ...prev, favorites: [entry, ...prev.favorites].slice(0, MAX_FAVORITES) };
    });
  }, []);

  const removeFavorite = useCallback((fn, ticker) => {
    const key = favKey({ fn, ticker: ticker || null });
    setStore((prev) => {
      const favorites = prev.favorites.filter((f) => favKey(f) !== key);
      return favorites.length === prev.favorites.length
        ? prev
        : { ...prev, favorites };
    });
  }, []);

  return {
    recents: store.recents,
    favorites: store.favorites,
    recordTicker,
    clearRecents,
    isFavorite,
    toggleFavorite,
    addFavorite,
    removeFavorite,
  };
}
