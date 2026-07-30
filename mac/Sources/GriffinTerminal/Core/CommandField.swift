import SwiftUI
import AppKit

// The command line, owned rather than borrowed.
//
// This replaces a SwiftUI TextField for one reason: the caret. Bloomberg's
// cursor is a solid amber block the width of a character, and a thin blue
// I-beam in the system accent colour is the single loudest tell that a
// terminal is really a web form. AppKit has no supported way to restyle
// an NSTextField's caret, so the first attempt installed a custom FIELD
// EDITOR on the window — the documented hook, and it does get called.
// Logging what it was called for settled the matter: the only client
// asking this window for a field editor is an NSButtonTextField. SwiftUI's
// TextField is not NSTextField-backed here and never asks, so no amount of
// window-level work could ever have reached it.
//
// An NSTextView we construct ourselves cannot have that problem, because
// drawInsertionPoint is our own method on our own object. The cost is that
// every behaviour the SwiftUI field gave for free has to be re-declared —
// submit, the Escape cascade, history keys, completion — and those are
// wired through explicit closures below rather than left to inference.
struct CommandField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var isFocused: Bool
    var onSubmit: () -> Void
    var onEscape: () -> Void
    var onMove: (Int) -> Void
    var onTab: () -> Void

    func makeNSView(context: Context) -> BlockCaretTextView {
        let v = BlockCaretTextView()
        v.delegate = context.coordinator
        v.owner = context.coordinator
        v.placeholderText = placeholder
        v.string = text
        v.isRichText = false
        v.isEditable = true
        v.isSelectable = true
        v.drawsBackground = false
        v.allowsUndo = true
        v.font = Term.nsMono(13)
        v.textColor = NSColor(Term.amber)
        v.insertionPointColor = NSColor(Term.amber)
        v.textContainerInset = .zero
        v.textContainer?.lineFragmentPadding = 0
        // A command line is one line. Without this the view wraps and
        // grows, and a two-line prompt is not a prompt.
        v.textContainer?.widthTracksTextView = false
        v.textContainer?.size = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        v.isHorizontallyResizable = true
        v.isVerticallyResizable = false
        v.isAutomaticQuoteSubstitutionEnabled = false
        v.isAutomaticDashSubstitutionEnabled = false
        v.isAutomaticTextReplacementEnabled = false
        v.isAutomaticSpellingCorrectionEnabled = false
        return v
    }

    func updateNSView(_ v: BlockCaretTextView, context: Context) {
        context.coordinator.parent = self
        // Only write when it actually differs, or every keystroke resets
        // the selection to the end of the line and typing in the middle
        // of a command becomes impossible.
        if v.string != text { v.string = text }
        v.placeholderText = placeholder
        if isFocused, v.window?.firstResponder !== v {
            v.window?.makeFirstResponder(v)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CommandField
        init(_ p: CommandField) { parent = p }

        func textDidChange(_ notification: Notification) {
            guard let v = notification.object as? NSTextView else { return }
            parent.text = v.string
        }

        /// Every key the SwiftUI field handled with .onKeyPress, routed
        /// through the one AppKit hook that sees them before the text view
        /// acts. Returning true means handled and stops insertion — which
        /// is what keeps Tab from typing a tab and Return from typing a
        /// newline into a single-line command.
        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                parent.onSubmit()
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                parent.onEscape()
                return true
            case #selector(NSResponder.moveUp(_:)):
                parent.onMove(-1)
                return true
            case #selector(NSResponder.moveDown(_:)):
                parent.onMove(1)
                return true
            case #selector(NSResponder.insertTab(_:)):
                parent.onTab()
                return true
            default:
                return false
            }
        }
    }
}

/// The block caret itself, plus the placeholder AppKit does not give a
/// text view.
final class BlockCaretTextView: NSTextView {
    weak var owner: AnyObject?
    var placeholderText: String = ""

    /// Not solid. A real terminal repaints the glyph in the background
    /// colour on top of the block; there is no hook for that here, so an
    /// opaque cursor would swallow the character it sits on. This is the
    /// closest honest approximation.
    private static let caretAlpha: CGFloat = 0.6

    private var caretWidth: CGFloat {
        let f = font ?? Term.nsMono(13)
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

    /// AppKit invalidates exactly the hairline it thinks it drew. A wider
    /// caret blinking off leaves most of itself behind, so the field fills
    /// with amber smears as the cursor moves. The invalid rect has to grow
    /// with the block.
    override func setNeedsDisplay(_ rect: NSRect, avoidAdditionalLayout flag: Bool) {
        var r = rect
        r.size.width += caretWidth
        super.setNeedsDisplay(r, avoidAdditionalLayout: flag)
    }

    override var selectedTextAttributes: [NSAttributedString.Key: Any] {
        get { [.backgroundColor: NSColor(Term.amber).withAlphaComponent(0.3)] }
        set { super.selectedTextAttributes = newValue }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholderText.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? Term.nsMono(13),
            .foregroundColor: NSColor(Term.fgMuted),
        ]
        // Baseline-aligned with the real text: same font, same origin the
        // layout manager would use for the first line fragment.
        placeholderText.draw(at: NSPoint(x: 0, y: 0), withAttributes: attrs)
    }

    /// The caret only blinks while the view is first responder, and a
    /// command line that looks dead until clicked is a command line people
    /// stop typing into.
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        needsDisplay = true
        return ok
    }
}
