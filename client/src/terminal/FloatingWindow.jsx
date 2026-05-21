import { useLayoutEffect, useRef, useState } from 'react';

// A single free-floating panel on the terminal canvas. The shell owns the
// list of windows (what function, which ticker, stacking order); this owns
// one window's geometry and the drag/resize gestures that change it.
//
// Geometry lives in local state, but the live gesture writes straight to
// the DOM node and only commits back to state on pointer-up. That keeps a
// drag at one render instead of one-per-frame, so a window with a live
// chart inside still moves without tearing. The committed box is also
// mirrored up to the shell (onGeometryChange) so siblings can read each
// other's real positions — which is what the edge magnetism below needs.

const MIN_W = 280;
const MIN_H = 180;

// Always leave this much of the window inside the canvas so a window can
// never be dragged somewhere it can't be grabbed back from.
const KEEP_VISIBLE = 48;

// Magnetism. A moving edge that comes within SNAP px of a neighbor's edge
// (or a canvas wall) jumps flush to it and holds there, so windows click
// together into a tidy mosaic. The hold is just the threshold — drag more
// than SNAP px past it and the window pops free again, which is how you
// separate a pair. Windows stay fully independent; nothing is grouped.
const SNAP = 9;

export default function FloatingWindow({
  title,
  initial,
  z,
  focused,
  onFocus,
  onClose,
  toolbar,
  children,
  siblings = [],
  onGeometryChange,
}) {
  const rootRef = useRef(null);
  const [box, setBox] = useState(initial);
  // Mirror of `box` the pointer handlers can read without re-subscribing.
  const boxRef = useRef(box);
  boxRef.current = box;
  // Live sibling rects, read inside the gesture without re-binding handlers.
  const siblingsRef = useRef(siblings);
  siblingsRef.current = siblings;

  // Canvas the window lives in (the relatively-positioned .term-workspace).
  function bounds() {
    const parent = rootRef.current?.offsetParent;
    return {
      w: parent?.clientWidth ?? window.innerWidth,
      h: parent?.clientHeight ?? window.innerHeight,
    };
  }

  function clamp(next) {
    const b = bounds();
    const w = Math.max(MIN_W, Math.min(next.w, b.w));
    const h = Math.max(MIN_H, Math.min(next.h, b.h));
    const x = Math.max(KEEP_VISIBLE - w, Math.min(next.x, b.w - KEEP_VISIBLE));
    const y = Math.max(0, Math.min(next.y, b.h - KEEP_VISIBLE));
    return { x, y, w, h };
  }

  // Pull a moving box onto the nearest neighbor / wall edge within SNAP.
  // Drag snaps position (x/y); resize snaps the size (w/h, since the
  // top-left stays pinned and the bottom-right corner is what moves). We
  // only attract on an axis when the two windows actually overlap on the
  // *other* axis — so a window drifting past one parked far away doesn't
  // get yanked sideways. Each axis keeps just its closest candidate.
  function applySnap(next, mode) {
    const rects = siblingsRef.current || [];
    const b = bounds();
    const L = next.x;
    const R = next.x + next.w;
    const T = next.y;
    const B = next.y + next.h;
    const vNear = (s) => T <= s.y + s.h + SNAP && B >= s.y - SNAP;
    const hNear = (s) => L <= s.x + s.w + SNAP && R >= s.x - SNAP;

    if (mode === 'drag') {
      let bx = null;
      let bxd = SNAP + 0.5;
      let by = null;
      let byd = SNAP + 0.5;
      const cx = (target, d) => {
        if (d < bxd) {
          bxd = d;
          bx = target;
        }
      };
      const cy = (target, d) => {
        if (d < byd) {
          byd = d;
          by = target;
        }
      };
      for (const s of rects) {
        const sL = s.x;
        const sR = s.x + s.w;
        const sT = s.y;
        const sB = s.y + s.h;
        if (vNear(s)) {
          cx(sR, Math.abs(L - sR)); // my left edge meets their right
          cx(sL - next.w, Math.abs(R - sL)); // my right edge meets their left
          cx(sL, Math.abs(L - sL)); // left edges align
          cx(sR - next.w, Math.abs(R - sR)); // right edges align
        }
        if (hNear(s)) {
          cy(sB, Math.abs(T - sB)); // my top meets their bottom
          cy(sT - next.h, Math.abs(B - sT)); // my bottom meets their top
          cy(sT, Math.abs(T - sT)); // top edges align
          cy(sB - next.h, Math.abs(B - sB)); // bottom edges align
        }
      }
      cx(0, Math.abs(L));
      cx(b.w - next.w, Math.abs(R - b.w));
      cy(0, Math.abs(T));
      cy(b.h - next.h, Math.abs(B - b.h));
      return { ...next, x: bx == null ? next.x : bx, y: by == null ? next.y : by };
    }

    // resize
    let bw = null;
    let bwd = SNAP + 0.5;
    let bh = null;
    let bhd = SNAP + 0.5;
    const cw = (target, d) => {
      if (d < bwd) {
        bwd = d;
        bw = target;
      }
    };
    const ch = (target, d) => {
      if (d < bhd) {
        bhd = d;
        bh = target;
      }
    };
    for (const s of rects) {
      const sL = s.x;
      const sR = s.x + s.w;
      const sT = s.y;
      const sB = s.y + s.h;
      if (vNear(s)) {
        cw(sL - next.x, Math.abs(R - sL)); // right edge meets their left
        cw(sR - next.x, Math.abs(R - sR)); // right edges align
      }
      if (hNear(s)) {
        ch(sT - next.y, Math.abs(B - sT)); // bottom meets their top
        ch(sB - next.y, Math.abs(B - sB)); // bottom edges align
      }
    }
    cw(b.w - next.x, Math.abs(R - b.w));
    ch(b.h - next.y, Math.abs(B - b.h));
    const w = Math.max(MIN_W, bw == null ? next.w : bw);
    const h = Math.max(MIN_H, bh == null ? next.h : bh);
    return { ...next, w, h };
  }

  // A window spawned with a cascade offset can land partly off a small
  // viewport; pull it back the moment it mounts, and sync the corrected
  // box up so the shell's record (and siblings' view of us) is accurate
  // from the first frame.
  useLayoutEffect(() => {
    const corrected = clamp(boxRef.current);
    setBox(corrected);
    onGeometryChange?.(corrected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Both gestures share the same shape: capture the pointer, track the
  // delta from where it went down, paint the node directly, commit once.
  function startGesture(e, mode) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus?.();
    const node = rootRef.current;
    node.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...boxRef.current };

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const base =
        mode === 'drag'
          ? clamp({ ...origin, x: origin.x + dx, y: origin.y + dy })
          : clamp({ ...origin, w: origin.w + dx, h: origin.h + dy });
      const next = applySnap(base, mode);
      node.style.left = `${next.x}px`;
      node.style.top = `${next.y}px`;
      node.style.width = `${next.w}px`;
      node.style.height = `${next.h}px`;
      node._pending = next;
    };
    const onUp = () => {
      node.releasePointerCapture(e.pointerId);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      if (node._pending) {
        setBox(node._pending);
        onGeometryChange?.(node._pending);
        node._pending = null;
      }
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  }

  return (
    <div
      ref={rootRef}
      className={`term-window${focused ? ' focused' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z }}
      onPointerDown={() => onFocus?.()}
    >
      <div
        className="term-window-titlebar"
        onPointerDown={(e) => startGesture(e, 'drag')}
      >
        <span className="term-window-title">{title}</span>
        <div className="term-window-tools" onPointerDown={(e) => e.stopPropagation()}>
          {toolbar}
          <button
            className="term-window-close"
            title="Close"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="term-window-body">{children}</div>

      <div
        className="term-window-resize"
        title="Resize"
        onPointerDown={(e) => startGesture(e, 'resize')}
      />
    </div>
  );
}
