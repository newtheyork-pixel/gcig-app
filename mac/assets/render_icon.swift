// Renders the app icon: an amber "G>" on the terminal's phosphor black,
// with the panel border the whole UI wears. Run by build-icon.sh; not
// part of the app target.
import AppKit

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let outDir = "assets/icon.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(_ px: Int, scale: Int, name: String) {
    let s = CGFloat(px)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }

    // Rounded background — macOS squircle-ish.
    let r = s * 0.225
    let bg = CGPath(roundedRect: CGRect(x: 0, y: 0, width: s, height: s),
                    cornerWidth: r, cornerHeight: r, transform: nil)
    ctx.addPath(bg)
    ctx.setFillColor(CGColor(red: 0.075, green: 0.07, blue: 0.06, alpha: 1))
    ctx.fillPath()

    // Panel border inset, amber.
    let inset = s * 0.06
    let border = CGPath(roundedRect: CGRect(x: inset, y: inset, width: s - 2*inset, height: s - 2*inset),
                        cornerWidth: r * 0.7, cornerHeight: r * 0.7, transform: nil)
    ctx.addPath(border)
    ctx.setStrokeColor(CGColor(red: 0.95, green: 0.65, blue: 0.2, alpha: 0.9))
    ctx.setLineWidth(max(s * 0.015, 1))
    ctx.strokePath()

    // Header strip.
    ctx.setFillColor(CGColor(red: 0.95, green: 0.65, blue: 0.2, alpha: 0.22))
    ctx.fill(CGRect(x: inset, y: s - inset - s*0.14, width: s - 2*inset, height: s*0.14))

    // "G>" — the terminal prompt.
    let text = "G>" as NSString
    let font = NSFont.monospacedSystemFont(ofSize: s * 0.42, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(red: 0.98, green: 0.72, blue: 0.25, alpha: 1),
    ]
    let sz = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (s - sz.width)/2, y: (s - sz.height)/2 - s*0.05), withAttributes: attrs)

    img.unlockFocus()
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}

for base in sizes where base <= 512 {
    render(base, scale: 1, name: "icon_\(base)x\(base)")
    render(base * 2, scale: 2, name: "icon_\(base)x\(base)@2x")
}
print("iconset rendered")
