// Generates Resources/AppIcon.icns: the Switchboard glyph (three jacks patched into one, as in MenuBar.swift)
// on a blue macOS-style squircle. Provenance: drawn entirely in code by this script; no external art.
// Run from app/: swift dev/make-icon.swift && iconutil -c icns dev/out/AppIcon.iconset -o Resources/AppIcon.icns
import AppKit

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 1024
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.scaleBy(x: s, y: s)
    // macOS icon grid: 824pt body inset 100pt, continuous corners.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let path = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.3).cgColor)
    NSColor(red: 0.16, green: 0.45, blue: 0.95, alpha: 1).setFill()
    path.fill()
    ctx.restoreGState()
    NSGradient(starting: NSColor(red: 0.33, green: 0.62, blue: 1.0, alpha: 1),
               ending: NSColor(red: 0.10, green: 0.36, blue: 0.88, alpha: 1))!.draw(in: path, angle: -90)
    // Glyph: 18-unit design scaled into the body.
    ctx.translateBy(x: 512 - 9 * 30, y: 512 - 9 * 30)
    ctx.scaleBy(x: 30, y: 30)
    NSColor.white.setStroke(); NSColor.white.setFill()
    let right = CGPoint(x: 14.6, y: 9)
    for y in [3.6, 9.0, 14.4] {
        let left = CGPoint(x: 3.2, y: y)
        let cord = NSBezierPath()
        cord.move(to: left)
        cord.curve(to: right, controlPoint1: CGPoint(x: 9.5, y: y), controlPoint2: CGPoint(x: 8.5, y: 9))
        cord.lineWidth = 1.35; cord.lineCapStyle = .round; cord.stroke()
        NSBezierPath(ovalIn: CGRect(x: left.x - 1.9, y: y - 1.9, width: 3.8, height: 3.8)).fill()
    }
    NSBezierPath(ovalIn: CGRect(x: right.x - 2.6, y: right.y - 2.6, width: 5.2, height: 5.2)).fill()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let dir = URL(fileURLWithPath: "dev/out/AppIcon.iconset")
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
for pt in [16, 32, 128, 256, 512] {
    try render(pt).write(to: dir.appendingPathComponent("icon_\(pt)x\(pt).png"))
    try render(pt * 2).write(to: dir.appendingPathComponent("icon_\(pt)x\(pt)@2x.png"))
}
