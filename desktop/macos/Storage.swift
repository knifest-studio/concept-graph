import Foundation
import CryptoKit
import Darwin

// The pointer lives outside the library, so the previous library remains a usable backup.
enum StorageLocation {
    private struct Settings: Codable { let version: Int; let path: String }
    static var settingsURL: URL {
        let environment = ProcessInfo.processInfo.environment
        if let value = environment["CONCEPT_GRAPH_DESKTOP_SETTINGS"], !value.isEmpty {
            return URL(fileURLWithPath: value)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Concept Graph Settings/storage.json")
    }
    static var environmentOverride: String? {
        guard let value = ProcessInfo.processInfo.environment["CONCEPT_GRAPH_DATA"], !value.isEmpty else { return nil }
        return value
    }
    static var mcpSessionURL: URL? {
        if let value = ProcessInfo.processInfo.environment["CONCEPT_GRAPH_MCP_SESSION_FILE"], !value.isEmpty {
            return value.hasPrefix("/") ? URL(fileURLWithPath: value) : nil
        }
        guard environmentOverride == nil else { return nil }
        return settingsURL.deletingLastPathComponent().appendingPathComponent("mcp-session.json")
    }
    static func lockMCPSession(_ session: URL) -> Int32? {
        do { try FileManager.default.createDirectory(at: session.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { return nil }
        let descriptor = open(session.path + ".lock", O_CREAT | O_RDWR | O_NOFOLLOW, mode_t(0o600))
        guard descriptor >= 0 else { return nil }
        _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { close(descriptor); return nil }
        return descriptor
    }
    private static func failure(_ message: String) -> NSError {
        NSError(domain: "ConceptGraph.Storage", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func current() throws -> URL {
        if let override = environmentOverride { return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL }
        let settings = settingsURL
        if FileManager.default.fileExists(atPath: settings.path) {
            let value = try JSONDecoder().decode(Settings.self, from: Data(contentsOf: settings))
            guard value.version == 1, value.path.hasPrefix("/") else { throw failure("The saved storage location is invalid.") }
            let location = URL(fileURLWithPath: value.path, isDirectory: true).standardizedFileURL
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: location.path, isDirectory: &directory), directory.boolValue,
                  FileManager.default.isReadableFile(atPath: location.appendingPathComponent("workspace.json").path) else {
                throw failure("The selected storage folder is unavailable. Reconnect the drive or restore the folder, then reopen Concept Graph. No new empty library was created.\n\n" + location.path)
            }
            return location
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Concept Graph", isDirectory: true)
    }
    static func destination(parent: URL, source: URL) throws -> URL {
        let sourcePath = source.resolvingSymlinksInPath().standardizedFileURL.path
        let parentPath = parent.resolvingSymlinksInPath().standardizedFileURL.path
        let result = URL(fileURLWithPath: parentPath, isDirectory: true).appendingPathComponent("Concept Graph Data", isDirectory: true)
        let resultPath = result.path
        guard resultPath != sourcePath, !resultPath.hasPrefix(sourcePath + "/"), !sourcePath.hasPrefix(resultPath + "/") else {
            throw failure("Choose a folder outside the current data folder.")
        }
        guard !FileManager.default.fileExists(atPath: resultPath) else {
            throw failure("A folder named ‘Concept Graph Data’ already exists there. Choose another location; existing files will not be overwritten.")
        }
        return result
    }
    private static func hash(_ url: URL) throws -> SHA256.Digest {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        var digest = SHA256()
        while let bytes = try file.read(upToCount: 1024 * 1024), !bytes.isEmpty { digest.update(data: bytes) }
        return digest.finalize()
    }
    private static func files(in root: URL) throws -> [String: SHA256.Digest] {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(atPath: root.path) else { throw failure("Could not read the storage folder.") }
        var result: [String: SHA256.Digest] = [:]
        for case let relative as String in enumerator {
            if relative == ".desktop.lock" { continue }
            let item = root.appendingPathComponent(relative)
            let type = try manager.attributesOfItem(atPath: item.path)[.type] as? FileAttributeType
            guard type != .typeSymbolicLink else { throw failure("The storage folder contains a symbolic link. No files were moved.") }
            if type == .typeDirectory { continue }
            guard type == .typeRegular else { throw failure("The storage folder contains an unsupported item. No files were moved.") }
            result[relative] = try hash(item)
        }
        return result
    }
    // Call only after the app has flushed and stopped its server while retaining the source lock.
    static func copyAndSelect(source: URL, destination: URL) throws {
        let manager = FileManager.default
        let source = source.resolvingSymlinksInPath().standardizedFileURL
        let checked = try self.destination(parent: destination.deletingLastPathComponent(), source: source)
        guard checked == destination.standardizedFileURL else { throw failure("The selected storage location changed.") }
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".concept-graph-copy-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: staging) }
        let original = try files(in: source)
        for item in try manager.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) where item.lastPathComponent != ".desktop.lock" {
            try manager.copyItem(at: item, to: staging.appendingPathComponent(item.lastPathComponent))
        }
        let copied = try files(in: staging)
        let after = try files(in: source)
        guard copied == original, after == original else { throw failure("A file changed or could not be verified while copying.") }
        guard renamex_np(staging.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Could not create the new folder without replacing an existing item."])
        }
        let settings = settingsURL
        try manager.createDirectory(at: settings.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(Settings(version: 1, path: destination.path))
        try data.write(to: settings, options: .atomic)
    }
}
