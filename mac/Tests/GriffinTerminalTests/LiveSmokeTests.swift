import XCTest
@testable import GriffinTerminal

// Every panel's Decodable, run against the PRODUCTION API.
//
// Twenty-two of these panels were written by reading the server's code,
// and reading is not the same as receiving: a field the handler renames
// in one branch, a number the sheet serializes as a string, a null the
// service only emits on Tuesdays — none of that shows up at compile
// time, and all of it shows up as a dead panel in front of a member.
// This suite converts "it compiles" into "it decodes what the server
// actually sends", one test per endpoint so a failure names its panel.
//
// Auth: the same token file the app writes at sign-in. When nobody
// is signed in on this machine the whole suite SKIPS — skipped is
// honest, green-without-checking would be the exact sin the panels are
// built to avoid.
//
// Deliberately GET-only. The annotate/chat endpoints spend LLM calls
// and the research writes move real workflow state; correctness of
// those is covered by using the app, not by a smoke loop.
final class LiveSmokeTests: XCTestCase {

    // A name the whole stack knows: it is in the book and under
    // research, so portfolio-derived and research endpoints all light up.
    private let T = "CHRW"

    private func requireToken() throws {
        try XCTSkipIf(TokenStore.read() == nil,
                      "No signed-in session on this machine — smoke suite needs the app's Keychain token.")
    }

    private func dec<D: Decodable & Sendable>(_ type: D.Type, _ path: String,
                                   _ query: [String: String] = [:]) async throws -> D {
        let data = try await API.shared.get(path, query: query)
        do {
            return try await API.shared.decode(D.self, from: data)
        } catch {
            // The first 300 bytes of what actually came back, because
            // "decoding failed" without the payload is a mystery novel
            // with the last page torn out.
            let head = String(data: data.prefix(300), encoding: .utf8) ?? "<binary>"
            XCTFail("\(path): \(error.localizedDescription)\npayload head: \(head)")
            throw error
        }
    }

    // MARK: Book + market

    func testMovers() async throws {
        try requireToken()
        _ = try await dec(MoversPanel.Payload.self, "/terminal/movers")
    }

    func testPortfolio() async throws {
        try requireToken()
        let p = try await dec(PortfolioPanel.Payload.self, "/terminal/portfolio")
        XCTAssertFalse((p.holdings ?? []).isEmpty, "the book should not be empty")
    }

    func testDescription() async throws {
        try requireToken()
        _ = try await dec(DescriptionPanel.Info.self, "/holdings/info/\(T)")
    }

    func testChart() async throws {
        try requireToken()
        let p = try await dec(ChartPanel.Payload.self, "/terminal/chart/\(T)", ["range": "1y"])
        XCTAssertGreaterThan((p.points ?? []).count, 50, "a year of dailies should be >50 bars")
    }

    func testIntraday() async throws {
        try requireToken()
        _ = try await dec(IntradayPanel.Payload.self, "/terminal/intraday/\(T)")
    }

    func testQuotes() async throws {
        try requireToken()
        _ = try await dec([String: ComparePanel.Quote?].self, "/terminal/quotes", ["tickers": "\(T),AAPL"])
    }

    func testCompare() async throws {
        try requireToken()
        _ = try await dec(ComparePanel.Payload.self, "/terminal/compare", ["tickers": "\(T),AAPL"])
    }

    func testSymbolSearch() async throws {
        try requireToken()
        let matches = try await API.shared.symbolSearch("AMZ")
        XCTAssertTrue(matches.contains { $0.ticker == "AMZN" },
                      "AMZ should surface AMZN, got: \(matches.map(\.ticker))")
    }

    func testWorldIndices() async throws {
        try requireToken()
        _ = try await dec(WorldIndicesPanel.Payload.self, "/terminal/indices")
    }

    // MARK: Fundamentals + filings

    func testStatementsAnnual() async throws {
        try requireToken()
        _ = try await dec(FinancialsPanel.Payload.self, "/terminal/statements/\(T)", ["freq": "annual"])
    }

    func testStatementsQuarterly() async throws {
        try requireToken()
        _ = try await dec(FinancialsPanel.Payload.self, "/terminal/statements/\(T)", ["freq": "quarterly"])
    }

    func testFundamentals() async throws {
        try requireToken()
        _ = try await dec(FundamentalsPanel.Payload.self, "/terminal/fundamentals/\(T)")
    }

    func testPeers() async throws {
        try requireToken()
        _ = try await dec(PeersPanel.Payload.self, "/terminal/peers/\(T)")
    }

    func testEarnings() async throws {
        try requireToken()
        _ = try await dec(EarningsPanel.Payload.self, "/terminal/earnings/\(T)")
    }

    func testConsensus() async throws {
        try requireToken()
        _ = try await dec(ConsensusPanel.Payload.self, "/terminal/consensus/\(T)")
    }

    func testFilings() async throws {
        try requireToken()
        _ = try await dec(FilingsPanel.Payload.self, "/terminal/filings/\(T)")
    }

    func testGovernance() async throws {
        try requireToken()
        _ = try await dec(GovernancePanel.Payload.self, "/terminal/governance/\(T)")
    }

    func testSupplyChain() async throws {
        try requireToken()
        _ = try await dec(SupplyChainPanel.Payload.self, "/terminal/supply-chain/\(T)")
    }

    // MARK: Insiders

    func testInsiders() async throws {
        try requireToken()
        _ = try await dec(InsiderPanel.InsiderPayload.self, "/terminal/insiders/\(T)")
    }

    func testInsiderClusters() async throws {
        try requireToken()
        _ = try await dec(InsiderClustersPanel.Payload.self, "/terminal/insider-clusters")
    }

    // MARK: News + macro + weather

    func testTopNews() async throws {
        try requireToken()
        _ = try await dec(TopNewsPanel.Payload.self, "/terminal/top-news", ["all": "1"])
    }

    func testCompanyNews() async throws {
        try requireToken()
        _ = try await dec(CompanyNewsPanel.Payload.self, "/holdings/news/\(T)")
    }

    func testMacro() async throws {
        try requireToken()
        _ = try await dec(MacroPanel.Payload.self, "/terminal/macro-sensitivity")
    }

    func testWeatherImpact() async throws {
        try requireToken()
        _ = try await dec(WeatherImpactPanel.Payload.self, "/terminal/weather-impact")
    }

    func testWxAlerts() async throws {
        try requireToken()
        _ = try await dec(RadarPanel.Payload.self, "/terminal/wx-alerts")
    }

    // MARK: The club's own material

    func testArchiveIndexAndFirstDoc() async throws {
        try requireToken()
        let idx = try await dec(ArchivePanel.Payload.self, "/terminal/research")
        // Follow one namespaced ref end to end — the reader is the point
        // of the panel, and refs like "report:12" are exactly the kind
        // of thing that breaks in URL construction, not in decoding.
        struct DocMirror: Decodable { let id: String; let text: String?; let summary: String? }
        if let first = idx.items.first?.id {
            _ = try await dec(DocMirror.self, "/terminal/research/\(first)")
        }
    }

    func testNotes() async throws {
        try requireToken()
        _ = try await dec(NotesPanel.Note.self, "/notes/\(T)")
    }

    func testResearchProjects() async throws {
        try requireToken()
        let data = try await API.shared.get("/research/projects")
        // The panel accepts both the bare array and the wrapped form;
        // the suite accepts exactly what the panel accepts.
        struct Wrap: Decodable { let projects: [Project] }
        if let list = try? await API.shared.decode([Project].self, from: data) {
            XCTAssertFalse(list.isEmpty)
        } else {
            _ = try await API.shared.decode(Wrap.self, from: data)
        }
    }

    func testResearchProjectFull() async throws {
        try requireToken()
        _ = try await dec(ProjectFull.self, "/research/projects/1")
    }
}