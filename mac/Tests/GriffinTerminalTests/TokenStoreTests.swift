import XCTest
@testable import GriffinTerminal

// Pin the two properties of TokenAdopt that, if they slip, sign an
// active member out: refuse a replayed older header, and parse the
// integer `iat` jsonwebtoken actually writes. Pure functions — this
// suite never opens the live session file.
final class TokenStoreTests: XCTestCase {
    func testIssuedAtReadsIntegerIatFromARealShapedJWT() {
        let token = jwt(iat: 1_700_000_000)
        XCTAssertEqual(TokenStore.issuedAt(token), 1_700_000_000)
    }

    func testTakeRefusesWhenThereIsNoSessionToRotate() {
        XCTAssertNil(TokenAdopt.take(fresh: jwt(iat: 2), current: nil))
    }

    func testTakeRefusesAnOlderReplay() {
        let live = jwt(iat: 100)
        XCTAssertNil(TokenAdopt.take(fresh: jwt(iat: 50), current: live))
    }

    func testTakeRefusesAnEquallyOldHeader() {
        let live = jwt(iat: 100)
        XCTAssertNil(TokenAdopt.take(fresh: jwt(iat: 100), current: live))
    }

    func testTakeAcceptsANewerToken() {
        let live = jwt(iat: 100)
        let fresh = jwt(iat: 200)
        XCTAssertEqual(TokenAdopt.take(fresh: fresh, current: live), fresh)
    }

    func testTakeReplacesAnUnreadableCurrentToken() {
        let fresh = jwt(iat: 200)
        XCTAssertEqual(TokenAdopt.take(fresh: fresh, current: "truncated"), fresh)
    }

    func testIssuedAtRefusesGarbage() {
        XCTAssertNil(TokenStore.issuedAt("not.a.jwt"))
        XCTAssertNil(TokenStore.issuedAt(""))
    }

    private func jwt(iat: Int) -> String {
        func b64(_ obj: [String: Any]) -> String {
            let data = try! JSONSerialization.data(withJSONObject: obj)
            return data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .trimmingCharacters(in: CharacterSet(charactersIn: "="))
        }
        return "\(b64(["alg": "none"])).\(b64(["iat": iat])).sig"
    }
}
