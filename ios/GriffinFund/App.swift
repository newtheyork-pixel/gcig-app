import SwiftUI

@main
struct GriffinFundApp: App {
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(session) }
    }
}
