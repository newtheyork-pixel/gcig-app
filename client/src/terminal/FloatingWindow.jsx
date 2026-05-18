import { useLayoutEffect, useRef, useState } from 'react';

// A single free-floating panel on the terminal canvas. The shell owns the
// list of windows (what function, which ticker, stacking order); this owns
// one window's geometry and the drag/resize gestures that change it.
//
// Geometry lives in local state, but the live gesture writes straight to
// the DOM node and only commits back to state on pointer-up. That keeps a
// drag at one render instead of one-per-frame, so a window with a live
// chart inside still moves without tearing.

const MIN_W = 280;
const MIN_H = 180;

// Always leave this much of the window inside the canvas so a window can
// never be dragged somewhere it can't be grabbed back from.
const KEEP_VISIBLE = 48;

export default function FloatingWindow({
  title,
  initial,
  z,
  focused,
  onFocus,
  onClose,
  toolbar,
  children,
}) {
  const rootRef = useRef(null);
  const [box, setBox] = useState(initial);
  // Mirror of `box` the pointer handlers can read without re-subscribing.
  const boxRef = useRef(box);
  boxRef.current = box;

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

  // A window spawned with a cascade offset can land partly off a small
  // viewport; pull it back the moment it mounts.
  useLayoutEffect(() => {
    setBox((b) => clamp(b));
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
      const next =
        mode === 'drag'
          ? clamp({ ...origin, x: origin.x + dx, y: origin.y + dy })
          : clamp({ ...origin, w: origin.w + dx, h: origin.h + dy });
      node.style.left = `${next.x}px`;
      node.style.top = `${next.y}px`;
      node.style.width = `${next.w}px`;
      node.style.height = `${next.h}px`;
      node._pending = next;
    };
    const onUp = (ev) => {
      node.releasePointerCapture(e.pointerId);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      if (node._pending) {
        setBox(node._pending);
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
