import Foundation
import Darwin

@main struct StorageTests {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("concept-storage-test-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: root) }
        let source = root.appendingPathComponent("source", isDirectory: true)
        let parent = root.appendingPathComponent("chosen", isDirectory: true)
        let settings = root.appendingPathComponent("settings/storage.json")
        try manager.createDirectory(at: source.appendingPathComponent("assets/nested"), withIntermediateDirectories: true)
        try manager.createDirectory(at: parent, withIntermediateDirectories: true)
        try Data("board and history".utf8).write(to: source.appendingPathComponent("workspace.json"))
        try Data("image".utf8).write(to: source.appendingPathComponent("assets/nested/image.png"))
        try Data().write(to: source.appendingPathComponent(".desktop.lock"))
        setenv("CONCEPT_GRAPH_DESKTOP_SETTINGS", settings.path, 1)
        unsetenv("CONCEPT_GRAPH_DATA")
        unsetenv("CONCEPT_GRAPH_MCP_SESSION_FILE")
        assert(StorageLocation.mcpSessionURL?.path == settings.deletingLastPathComponent().appendingPathComponent("mcp-session.json").path)
        setenv("CONCEPT_GRAPH_DATA", source.path, 1)
        assert(StorageLocation.mcpSessionURL == nil)
        let explicitSession = root.appendingPathComponent("isolated-session.json")
        setenv("CONCEPT_GRAPH_MCP_SESSION_FILE", explicitSession.path, 1)
        assert(StorageLocation.mcpSessionURL?.path == explicitSession.path)
        guard let locked = StorageLocation.lockMCPSession(explicitSession) else { fatalError("Could not take initial MCP lock") }
        assert(StorageLocation.lockMCPSession(explicitSession) == nil)
        flock(locked, LOCK_UN); close(locked)
        guard let relocked = StorageLocation.lockMCPSession(explicitSession) else { fatalError("Could not retake released MCP lock") }
        flock(relocked, LOCK_UN); close(relocked)
        unsetenv("CONCEPT_GRAPH_MCP_SESSION_FILE")
        unsetenv("CONCEPT_GRAPH_DATA")
        func mustFail(_ body: () throws -> Void) throws {
            do { try body() } catch { return }
            throw NSError(domain: "StorageTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "An unsafe case unexpectedly succeeded"])
        }
        try mustFail { _ = try StorageLocation.destination(parent: source, source: source) }
        let target = try StorageLocation.destination(parent: parent, source: source)
        try manager.createDirectory(at: target, withIntermediateDirectories: false)
        try mustFail { _ = try StorageLocation.destination(parent: parent, source: source) }
        try manager.removeItem(at: target)
        try manager.createSymbolicLink(at: source.appendingPathComponent("assets/link"), withDestinationURL: source.appendingPathComponent("workspace.json"))
        try mustFail { try StorageLocation.copyAndSelect(source: source, destination: target) }
        assert(!manager.fileExists(atPath: target.path) && !manager.fileExists(atPath: settings.path))
        try manager.removeItem(at: source.appendingPathComponent("assets/link"))
        let failingParent = root.appendingPathComponent("failed", isDirectory: true)
        try manager.createDirectory(at: failingParent, withIntermediateDirectories: false)
        let block = root.appendingPathComponent("not-a-directory")
        try Data("block".utf8).write(to: block)
        setenv("CONCEPT_GRAPH_DESKTOP_SETTINGS", block.appendingPathComponent("storage.json").path, 1)
        let failedTarget = try StorageLocation.destination(parent: failingParent, source: source)
        do { try StorageLocation.copyAndSelect(source: source, destination: failedTarget); fatalError("Expected settings failure") }
        catch { FileHandle.standardError.write(Data("Expected settings failure: \(error.localizedDescription)\n".utf8)) }
        assert(manager.fileExists(atPath: source.appendingPathComponent("workspace.json").path))
        assert(manager.fileExists(atPath: failedTarget.appendingPathComponent("workspace.json").path))
        setenv("CONCEPT_GRAPH_DESKTOP_SETTINGS", settings.path, 1)
        try StorageLocation.copyAndSelect(source: source, destination: target)
        let copiedBoard = try Data(contentsOf: target.appendingPathComponent("workspace.json"))
        let copiedImage = try Data(contentsOf: target.appendingPathComponent("assets/nested/image.png"))
        assert(copiedBoard == Data("board and history".utf8))
        assert(copiedImage == Data("image".utf8))
        assert(!manager.fileExists(atPath: target.appendingPathComponent(".desktop.lock").path))
        assert(manager.fileExists(atPath: source.appendingPathComponent("workspace.json").path))
        let selected = try StorageLocation.current()
        assert(selected.path == target.path)
        setenv("CONCEPT_GRAPH_DATA", source.path, 1)
        let overridden = try StorageLocation.current()
        assert(overridden.path == source.path)
        unsetenv("CONCEPT_GRAPH_DATA")
        try manager.removeItem(at: target)
        try mustFail { _ = try StorageLocation.current() }
        assert(!manager.fileExists(atPath: target.path))
        print("macOS storage copy, conflicts, links, config failure, override and missing-volume tests passed")
    }
}
