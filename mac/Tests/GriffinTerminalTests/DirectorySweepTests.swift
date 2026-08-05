import XCTest
@testable import GriffinTerminal

/// The sweep that removes directories a server-side rename emptied.
///
/// Everything here is about the one case it used to get wrong: a folder
/// that is empty because its contents have not been downloaded yet. That
/// is not a folder to delete, and deleting it is unrecoverable in
/// practice — the pull that would refill it sweeps it first, so it fails
/// the same way on every sync after.
final class DirectorySweepTests: XCTestCase {
    let base = URL(fileURLWithPath: "/Volumes/Griffin Fund/CHRW")

    func testEmptyDirectoryIsSwept() {
        // The behaviour worth keeping: a rename that emptied a folder
        // should not leave the folder sitting there.
        XCTAssertTrue(GriffinDrive.isSweepable(
            dir: "/Volumes/Griffin Fund/CHRW/old", children: [], awaiting: []))
    }

    func testDirectoryWithFilesSurvives() {
        XCTAssertFalse(GriffinDrive.isSweepable(
            dir: "/Volumes/Griffin Fund/CHRW/2 Case law",
            children: ["CASE 1 — Werner v. Blake"], awaiting: []))
    }

    func testDotFilesDoNotCountAsContents() {
        // A .DS_Store is Finder's, not the project's. A folder holding
        // only one is still empty in every sense that matters.
        XCTAssertTrue(GriffinDrive.isSweepable(
            dir: "/Volumes/Griffin Fund/CHRW/old",
            children: [".DS_Store"], awaiting: []))
    }

    func testDirectoryAwaitingADownloadIsNotSwept() {
        // The regression. "3 Regulatory" is empty at the instant the
        // sweep looks because its two PDFs are still queued; deleting it
        // makes their writes fail into a missing parent, silently.
        let dir = "/Volumes/Griffin Fund/CHRW/3 Regulatory"
        XCTAssertFalse(GriffinDrive.isSweepable(
            dir: dir, children: [], awaiting: [dir]))
    }

    func testAwaitingCoversEveryDirectoryAboveTheFile() {
        // A nested artifact leaves its whole chain of parents empty at
        // the same moment, and the sweep walks deepest-first — so
        // protecting only the immediate parent still loses the ones
        // above it.
        let dest = base.appendingPathComponent("4 Company filings/8-K/2026/verdict.pdf")
        let awaiting = GriffinDrive.awaitingDirectories(for: [dest], under: base)

        XCTAssertTrue(awaiting.contains("/Volumes/Griffin Fund/CHRW/4 Company filings"))
        XCTAssertTrue(awaiting.contains("/Volumes/Griffin Fund/CHRW/4 Company filings/8-K"))
        XCTAssertTrue(awaiting.contains("/Volumes/Griffin Fund/CHRW/4 Company filings/8-K/2026"))
    }

    func testAwaitingStopsAtTheProjectRoot() {
        // Never the project folder itself and never the volume above it.
        // A project that genuinely holds nothing is a separate question
        // and not this sweep's to answer.
        let dest = base.appendingPathComponent("3 Regulatory/pocket guide")
        let awaiting = GriffinDrive.awaitingDirectories(for: [dest], under: base)

        XCTAssertFalse(awaiting.contains(base.path))
        XCTAssertFalse(awaiting.contains("/Volumes/Griffin Fund"))
        XCTAssertEqual(awaiting, ["/Volumes/Griffin Fund/CHRW/3 Regulatory"])
    }

    func testFileAtTheProjectRootAwaitsNothing() {
        // An artifact filed loose in the project has no intermediate
        // directory to protect, and must not reach up past the root.
        let dest = base.appendingPathComponent("README.md")
        XCTAssertTrue(GriffinDrive.awaitingDirectories(for: [dest], under: base).isEmpty)
    }

    func testNoDownloadsMeansTheSweepIsUnchanged() {
        // A pure rename queues nothing, and the sweep must still do its
        // original job of clearing what the rename left behind.
        XCTAssertTrue(GriffinDrive.awaitingDirectories(for: [], under: base).isEmpty)
        XCTAssertTrue(GriffinDrive.isSweepable(
            dir: "/Volumes/Griffin Fund/CHRW/old", children: [], awaiting: []))
    }

    func testSiblingAwaitingDoesNotProtectAnEmptyFolder() {
        // The exemption is narrow. A queued download into "3 Regulatory"
        // says nothing about "old", which should still go.
        let dest = base.appendingPathComponent("3 Regulatory/pocket guide")
        let awaiting = GriffinDrive.awaitingDirectories(for: [dest], under: base)

        XCTAssertTrue(GriffinDrive.isSweepable(
            dir: "/Volumes/Griffin Fund/CHRW/old", children: [], awaiting: awaiting))
    }
}
