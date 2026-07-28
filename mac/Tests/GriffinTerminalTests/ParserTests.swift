import XCTest
@testable import GriffinTerminal

// Conformance against the web parser, not against my reading of it.
//
// Every expectation below was produced by running the actual
// client/src/terminal/parser.js over the same input, with the real
// FUNCTION_IDS pulled from registry.js. That matters: a port checked
// against what the author believed the source did is a port that
// silently drifts. If the web parser changes, regenerate these.
//
// The pointed cases are the ones where a plausible-looking Swift port
// gets it wrong:
//   "ZZZZ"        -> a TICKER, not an error. Anything ticker-shaped
//                    opens DES, even if no such company exists.
//   "AIT ZZZZ"    -> nil. Ticker-shaped first word, unknown second, and
//                    the JS refuses rather than falling back to DES.
//   "RSCH CHRW"   -> function first wins, CHRW becomes an ARG.
//   "CHRW RSCH"   -> ticker first, so RSCH is the function. The same two
//                    words in the other order mean different things.
final class ParserTests: XCTestCase {

    private func expect(_ input: String,
                        _ ticker: String?, _ function: String?, _ args: String?,
                        file: StaticString = #filePath, line: UInt = #line) {
        let got = Parser.parse(input)
        guard let function else {
            XCTAssertNil(got, "\(input.debugDescription) should not parse", file: file, line: line)
            return
        }
        XCTAssertEqual(got?.ticker, ticker, "ticker for \(input.debugDescription)", file: file, line: line)
        XCTAssertEqual(got?.function, function, "function for \(input.debugDescription)", file: file, line: line)
        XCTAssertEqual(got?.args, args, "args for \(input.debugDescription)", file: file, line: line)
    }

    func testMatchesWebParser() {
        expect("AIT",                 "AIT",   "DES",  nil)
        expect("AIT DES",             "AIT",   "DES",  nil)
        expect("des",                 nil,     "DES",  nil)
        expect("PM",                  nil,     "PM",   nil)
        expect("MOVR",                nil,     "MOVR", nil)
        expect("AIT GP",              "AIT",   "GP",   nil)
        expect("RSCH",                nil,     "RSCH", nil)
        expect("FLD",                 nil,     "FLD",  nil)
        expect("CHRW RSCH",           "CHRW",  "RSCH", nil)
        expect("BRK.B",               "BRK.B", "DES",  nil)
        expect("BRK.B FA",            "BRK.B", "FA",   nil)
        expect("RDS-A DES",           "RDS-A", "DES",  nil)
        expect("aapl des",            "AAPL",  "DES",  nil)
        expect("CMP AIT JNJ",         nil,     "CMP",  "AIT JNJ")
        expect("NOTE hello world",    nil,     "NOTE", "HELLO WORLD")
        expect("HELP",                nil,     "HELP", nil)
        expect("BI what is this",     nil,     "BI",   "WHAT IS THIS")
        expect("AIT DES extra args",  "AIT",   "DES",  "EXTRA ARGS")
        expect("RSCH CHRW",           nil,     "RSCH", "CHRW")

        // Unparseable, and each for a different reason.
        expect("",                    nil, nil, nil)
        expect("   ",                 nil, nil, nil)
        expect("1AIT",                nil, nil, nil)   // must start with a letter
        expect("AIT ZZZZ",            nil, nil, nil)   // unknown function
        expect("TOOLONGTICK12 DES",   nil, nil, nil)   // 13 chars, limit is 12

        // Ticker-shaped but not a real company still parses. The parser
        // is not a directory and must not pretend to be one.
        expect("ZZZZ",                "ZZZZ", "DES", nil)
    }

    func testEveryWebMnemonicIsKnown() {
        // If the web adds a function and this app does not, the command
        // bar says "not a function" for something that plainly is one.
        let web = ["ARCH","BI","CMP","CN","CON","DES","EARN","ECO","FA","FIL","FLD",
                   "GF","GIP","GP","HELP","ICLUSTER","INSDR","MACRO","MGMT","MOVR",
                   "NOTE","PEER","PM","RDR","RSCH","SPLC","TOP","WEI","WX"]
        let missing = web.filter { !Registry.ids.contains($0) }
        XCTAssertTrue(missing.isEmpty, "registry is missing web mnemonics: \(missing)")
    }
}
