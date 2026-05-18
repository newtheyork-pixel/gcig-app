import { useCallback, useMemo, useRef, useState } from 'react';
import CommandBar from './CommandBar.jsx';
import FloatingWindow from './FloatingWindow.jsx';
import { getFunction, FUNCTIONS } from './registry.js';
import { useAuth } from '../context/AuthContext.jsx';

// TerminalShell — the amber/black workstation. Owns:
//   - The data-theme scoping (so the rest of the app is unaffected)
//   - Topbar + command bar + status bar
//   - A canvas of free-floating windows
//
// The workspace starts empty. Every command opens its own window; the
// shell tracks the list and the stacking order, each window owns its
// own position and size (see FloatingWindow). Closing a window drops it
// from the list. There is deliberately no saved layout — a session's
// arrangement lives only as long as the tab is open, same as before.

// New windows cascade down-right from the top-left so a burst of
// commands doesn't bury every window under the last one. The step wraps
// after a handful so the staircase can't march off a small screen.
const SPAWN_BASE = 24;
const SPAWN_STEP = 28;
const SPAWN_WRAP = 8;
const DEFAULT_W = 580;
const DEFAULT_H = 440;

let windowSeq = 0;
function nextWindowId() {
  windowSeq += 1;
  return `w${windowSeq}`;
}

export default function TerminalShell({ onExit }) {
  const { user } = useAuth();
  const [windows, setWindows] = useState([]);
  const [focusedId, setFocusedId] = useState(null);
  const [lastInterpretation, setLastInterpretation] = useState(null);
  // Monotonic stacking counter — the next focused/spawned window gets the
  // top z so click-to-front needs nothing fancier than "current max + 1".
  const zSeq = useRef(1);

  // Build a workspace context blob to hand the AI chat panel so it can
  // reason about what the user is currently looking at.
  const workspaceContext = useMemo(() => {
    const lines = ['GCIG Terminal workspace:'];
    if (windows.length === 0) lines.push('- (no windows open)');
    for (const w of windows) {
      const fn = getFunction(w.fn);
      const focused = w.id === focusedId ? ' [focused]' : '';
      lines.push(
        `- ${w.fn} (${fn?.label || w.fn})${w.ticker ? ` for ${w.ticker}` : ''}${focused}`
      );
    }
    if (user?.role) lines.push(`Viewer role: ${user.role}`);
    return lines.join('\n');
  }, [windows, focusedId, user]);

  const focusWindow = useCallback((id) => {
    setFocusedId(id);
    zSeq.current += 1;
    const z = zSeq.current;
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, z } : w)));
  }, []);

  // Open a new window for a function (optionally bound to a ticker) and
  // bring it to the front. Position cascades off how many windows are
  // already open; FloatingWindow pulls it back in if it lands off-screen.
  const spawnWindow = useCallback((fn, ticker) => {
    if (!fn) return;
    const id = nextWindowId();
    zSeq.current += 1;
    setWindows((ws) => {
      const step = (ws.length % SPAWN_WRAP) * SPAWN_STEP;
      return [
        ...ws,
        {
          id,
          fn,
          ticker: ticker || null,
          x: SPAWN_BASE + step,
          y: SPAWN_BASE + step,
          w: DEFAULT_W,
          h: DEFAULT_H,
          z: zSeq.current,
        },
      ];
    });
    setFocusedId(id);
  }, []);

  // A parsed command bar entry. Each command opens its own window rather
  // than taking over an existing one.
  const applyCommand = useCallback(
    (cmd) => {
      if (!cmd?.function) return;
      setLastInterpretation(cmd._source === 'llm' ? cmd : null);
      spawnWindow(cmd.function, cmd.ticker);
    },
    [spawnWindow]
  );

  // Drill-down from inside a panel (clicking a peer or mover row). Keeps
  // the source window untouched and opens the target in a fresh window,
  // matching the spawn-don't-hijack model everywhere else.
  const openFromPanel = useCallback(
    (cmd) => {
      if (!cmd?.ticker) return;
      spawnWindow(cmd.fn || 'DES', cmd.ticker);
    },
    [spawnWindow]
  );

  const closeWindow = useCallback((id) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
    setFocusedId((cur) => (cur === id ? null : cur));
  }, []);

  const setWindowFn = useCallback((id, newFn) => {
    setWindows((ws) =>
      ws.map((w) => (w.id === id ? { ...w, fn: newFn } : w))
    );
  }, []);

  const focused = windows.find((w) => w.id === focusedId) || null;

  return (
    <div className="terminal-root" data-theme="terminal">
      <div className="term-topbar">
        <span className="term-topbar-brand">GCIG TERMINAL</span>
        <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>v0</span>
        <div className="term-topbar-status">
          <span><span className="dot" /> CONNECTED</span>
          <span>·</span>
          <span>{user?.name || 'USER'}</span>
          <button className="term-topbar-exit" onClick={onExit}>EXIT</button>
        </div>
      </div>

      <CommandBar onCommand={applyCommand} lastInterpretation={lastInterpretation} />

      <div className="term-workspace">
        {windows.length === 0 ? (
          <div className="term-empty-hint">
            <div className="term-empty-title">EMPTY WORKSPACE</div>
            <div className="term-empty-sub">
              Type a command to open a window — e.g. <b>AAPL DES</b>, <b>MOVR</b>,
              or ask in plain English.
            </div>
            <div className="term-empty-sub">
              Drag a window by its title bar; resize from the bottom-right corner.
            </div>
          </div>
        ) : null}

        {windows.map((w) => {
          const fnDef = getFunction(w.fn);
          const Comp = fnDef?.component;
          const fnLabel = fnDef?.label || w.fn;
          const title =
            w.ticker && fnDef?.requires === 'ticker'
              ? `${w.ticker} · ${w.fn} · ${fnLabel}`
              : `${w.fn} · ${fnLabel}`;

          return (
            <FloatingWindow
              key={w.id}
              title={title}
              initial={{ x: w.x, y: w.y, w: w.w, h: w.h }}
              z={w.z}
              focused={w.id === focusedId}
              onFocus={() => focusWindow(w.id)}
              onClose={() => closeWindow(w.id)}
              toolbar={
                <FunctionSwitcher
                  current={w.fn}
                  onChange={(newFn) => setWindowFn(w.id, newFn)}
                />
              }
            >
              {Comp ? (
                <Comp
                  ticker={w.ticker}
                  fn={fnDef}
                  workspaceContext={workspaceContext}
                  onOpen={openFromPanel}
                />
              ) : null}
            </FloatingWindow>
          );
        })}
      </div>

      <div className="term-statusbar">
        <span>WINDOWS: {windows.length}</span>
        <span className="sep">|</span>
        <span>
          {focused
            ? `${focused.ticker || '—'} · ${focused.fn}`
            : 'NONE FOCUSED'}
        </span>
        <span className="sep">|</span>
        <span>HELP HELP &lt;GO&gt; for function list</span>
        <span style={{ marginLeft: 'auto' }}>{new Date().toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function FunctionSwitcher({ current, onChange }) {
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        background: 'var(--term-bg-panel)',
        color: 'var(--term-fg)',
        border: '1px solid var(--term-border)',
        font: 'inherit',
        fontSize: 11,
        padding: '1px 4px',
        letterSpacing: '0.06em',
      }}
    >
      {FUNCTIONS.map((f) => (
        <option key={f.id} value={f.id}>
          {f.id} · {f.label}
        </option>
      ))}
    </select>
  );
}
