import AppKit

@main struct UpdaterAvailabilityTests {
    @MainActor static func main() {
        // A development executable has no trusted feed configuration and must stay disabled.
        precondition(ConceptGraphUpdates.create() == nil)
        print("Updater disabled without release configuration")
    }
}
