import XCTest
@testable import GriffinTerminal

/// The Trash sweep decides, from a filename, which club document to
/// remove. Everything here is about it refusing to guess.
final class TrashMatchTests: XCTestCase {
    /// Two projects, deliberately sharing filenames.
    let index: [String: Int] = [
        "LISN/model.xlsx": 1,
        "CHRW/model.xlsx": 2,
        "CHRW/filings/complaint.pdf": 3,
        "LISN/notes.pdf": 4,
        "LISN/meeting-notes.pdf": 5,
        "LISN/old/model.xlsx.bak": 6,
    ]

    func testUnambiguousFileMatches() {
        let hits = GriffinDrive.candidates(for: "complaint.pdf", in: index)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.1, 3)
    }

    func testSameNameInTwoProjectsIsRefused() {
        // The Trash is flat, so "model.xlsx" has lost the folder that
        // said which project it belonged to. Removing the wrong club's
        // evidence is far worse than leaving a row on a page.
        let hits = GriffinDrive.candidates(for: "model.xlsx", in: index)
        XCTAssertEqual(hits.count, 2, "ambiguous names must not resolve to one")
    }

    func testMatchesOnPathBoundaryNotSubstring() {
        // "notes.pdf" must not sweep away "meeting-notes.pdf" — the
        // failure that would quietly delete a document nobody touched.
        let hits = GriffinDrive.candidates(for: "notes.pdf", in: index)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.1, 4)
    }

    func testSuffixDoesNotMatchLongerFilename() {
        // The reverse direction: trashing model.xlsx must not take the
        // .bak with it.
        let hits = GriffinDrive.candidates(for: "model.xlsx", in: index)
        XCTAssertFalse(hits.contains { $0.1 == 6 })
    }

    func testTrashedFolderMatchesItsContents() {
        // A trashed folder arrives with its contents intact, so the
        // sweep offers "filings/complaint.pdf".
        let hits = GriffinDrive.candidates(for: "filings/complaint.pdf", in: index)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.1, 3)
    }

    func testUnknownFileMatchesNothing() {
        // Dropped in and trashed again before it ever uploaded.
        XCTAssertTrue(GriffinDrive.candidates(for: "scratch.txt", in: index).isEmpty)
        XCTAssertTrue(GriffinDrive.candidates(for: "", in: index).isEmpty)
        XCTAssertTrue(GriffinDrive.candidates(for: "   ", in: index).isEmpty)
    }

    func testEmptyIndexIsSafe() {
        XCTAssertTrue(GriffinDrive.candidates(for: "anything.pdf", in: [:]).isEmpty)
    }
}
