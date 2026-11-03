import AppKit

#if canImport(Sparkle)
import Sparkle

// Hold this object for the app's lifetime; Sparkle's delegate references are weak.
@MainActor final class ConceptGraphUpdates: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!

    static func create() -> ConceptGraphUpdates? {
        guard UpdateConfiguration.isValid(Bundle.main.infoDictionary ?? [:]) else { return nil }
        let updates = ConceptGraphUpdates()
        updates.controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: updates, userDriverDelegate: nil)
        updates.controller.startUpdater()
        return updates
    }

    @objc func checkForUpdates(_ sender: Any?) {
        controller.checkForUpdates(sender)
    }
}
#else
// Development builds without Sparkle must not present a non-functional update action.
@MainActor final class ConceptGraphUpdates: NSObject {
    static func create() -> ConceptGraphUpdates? { nil }
    @objc func checkForUpdates(_ sender: Any?) {}
}
#endif
