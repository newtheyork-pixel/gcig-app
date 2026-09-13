import XCTest
import Foundation
@testable import GriffinTerminal

final class HootJSONTests: XCTestCase {
    func testJSONSerializationIntegersSurvive() throws {
        // The roster is JSON numbers. A failed Int cast used to drop
        // every row, so the desk looked empty on a live socket.
        let json = """
        {"id":1,"idleMs":1500,"target":2}
        """.data(using: .utf8)!
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: json) as? [String: Any]
        )
        XCTAssertEqual(HootJSON.int(obj["id"]), 1)
        XCTAssertEqual(HootJSON.int(obj["idleMs"]), 1500)
        XCTAssertEqual(HootJSON.int(obj["target"]), 2)
        XCTAssertNil(HootJSON.int(NSNull()))
        XCTAssertNil(HootJSON.int(nil))
    }

    func testAliasesOpenTheHootPanel() {
        XCTAssertEqual(Registry.function("HOOT")?.id, "HOOT")
        XCTAssertEqual(Registry.function("SQUAWK")?.id, "HOOT")
        XCTAssertEqual(Registry.function("DESK")?.id, "HOOT")
        XCTAssertEqual(Registry.function("SQUAWK")?.native, true)
    }
}
