import AppKit
import SwiftUI

// The amber block cursor.
//
// macOS gives every text field a thin blue I-beam that blinks. On a
// Bloomberg command line the cursor is a solid amber block the width of
// one character, and it is not decoration: the whole grammar of the
// thing is that you are always typing at a fixed-width prompt, and a
// hairline in the system accent colour reads as a web form sitting
// inside a terminal.
//
// AppKit has no supported way to restyle the caret of an NSTextField.
// What it does have is the FIELD EDITOR: every text field in a window
// borrows one shared NSTextView to do its editing, and a window may
// supply its own.
//
// This does NOT reach a SwiftUI TextField. Instrumenting the hook settled
// that: the only client asking this window for a field editor is an
// NSButtonTextField, so SwiftUI's field is not NSTextField-backed here and
// never asks. The command line therefore owns its own text view — see
// CommandField. This stays because it does cover genuine AppKit fields,
// and because the next person to wonder why should find the answer here
// rather than repeat the experiment.
//
// The override that is easy to miss is setNeedsDisplay. AppKit
// invalidates exactly the hairline it thinks it drew, so a wider caret
// blinks off leaving most of itself behind, and the field fills with
// amber smears as it moves. The invalid rect has to grow with the
// cursor.
final class BlockCaretFieldEditor: NSTextView {
    /// Reduced from a full block so the character under the cursor stays
    /// legible. A solid fill is closer to the real terminal, but there
    /// the glyph is repainted in the background colour on top, and no
    /// such hook exists here — an opaque block would simply swallow the
    /// letter you are standing on.
    private static let caretAlpha: CGFloat = 0.55

    private var caretWidth: CGFloat {
        // Measured from the field's own font so the block matches the
        // character it sits on at any size. Monospaced, so one glyph
        // stands for all of them.
        let f = font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let w = "0".size(withAttributes: [.font: f]).width
        return w > 1 ? w : 8
    }

    override func drawInsertionPoint(in rect: NSRect, color: NSColor, turnedOn flag: Bool) {
        var r = rect
        r.size.width = caretWidth
        super.drawInsertionPoint(in: r,
                                 color: NSColor(Term.amber).withAlphaComponent(Self.caretAlpha),
                                 turnedOn: flag)
    }

    override func setNeedsDisplay(_ rect: NSRect, avoidAdditionalLayout flag: Bool) {
        var r = rect
        r.size.width += caretWidth
        super.setNeedsDisplay(r, avoidAdditionalLayout: flag)
    }

    /// The selection highlight is the same problem as the caret: the
    /// system blue belongs to a different application than this one.
    override var selectedTextAttributes: [NSAttributedString.Key: Any] {
        get { [.backgroundColor: NSColor(Term.amber).withAlphaComponent(0.28)] }
        set { super.selectedTextAttributes = newValue }
    }
}

// One editor per window, which is the contract AppKit expects: the field
// editor is borrowed by whichever field is first responder and must not
// be shared across windows.
//
// SwiftUI already owns the window's delegate and uses it, so this does
// not take the slot — it interposes and forwards everything it does not
// handle. Claiming the slot outright compiled and ran and quietly broke
// whatever SwiftUI was using it for, which is the kind of bug that
// surfaces a week later as "the window stopped remembering its size".
final class BlockCaretWindowDelegate: NSObject, NSWindowDelegate {
    private var editor: BlockCaretFieldEditor?
    weak var forward: NSWindowDelegate?

    func windowWillReturnFieldEditor(_ sender: NSWindow, to client: Any?) -> Any? {
        // Only text fields. Handing a field editor to anything else that
        // asks is how you break a control you never looked at.
        guard client is NSTextField else {
            return forward?.windowWillReturnFieldEditor?(sender, to: client)
        }
        if let editor { return editor }
        let e = BlockCaretFieldEditor()
        e.isFieldEditor = true
        editor = e
        return e
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (forward?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let f = forward, f.responds(to: aSelector) { return f }
        return super.forwardingTarget(for: aSelector)
    }
}

/// Installs the caret on whatever window this lands in. A zero-size view
/// rather than an App-level hook because SwiftUI creates windows lazily
/// and the delegate is not there to interpose on until one exists.
struct BlockCaretInstaller: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Installer() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class Installer: NSView {
        private var installed: BlockCaretWindowDelegate?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let w = window else { return }
            // Idempotent: views move between windows, and a second
            // delegate forwarding to the first would double every call.
            if let d = w.delegate as? BlockCaretWindowDelegate { installed = d; return }
            let d = BlockCaretWindowDelegate()
            d.forward = w.delegate
            w.delegate = d
            installed = d
        }
    }
}
