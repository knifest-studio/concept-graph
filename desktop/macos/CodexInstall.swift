import Foundation
import CryptoKit
import Darwin

// The optional, app-owned CLI is separate from both the user's CLI and board data.
enum CodexInstall {
    static let version = "0.163.0"
    #if arch(arm64)
    static let target = "aarch64-apple-darwin"
    static let sha256 = "b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34"
    static let downloadSize = "about 127 MiB"
    #elseif arch(x86_64)
    static let target = "x86_64-apple-darwin"
    static let sha256 = "0c182d6194da7003943678dc87866b54b3dee719edaf8d092f304affbc6b57d1"
    static let downloadSize = "about 138 MiB"
    #else
    static let target = "unsupported"
    static let sha256 = ""
    static let downloadSize = "size unavailable"
    #endif

    static var root: URL { StorageLocation.settingsURL.deletingLastPathComponent().appendingPathComponent("codex-cli", isDirectory: true) }
    static var directory: URL { root.appendingPathComponent(version, isDirectory: true) }
    static var executable: URL { directory.appendingPathComponent("bin/codex") }
    static var preference: URL { root.appendingPathComponent("prefer-managed") }
    static var downloadURL: URL {
        URL(string: "https://github.com/openai/codex/releases/download/rust-v\(version)/codex-package-\(target).tar.gz")!
    }

    static func searchPath(runtime: URL, home: URL, inherited: String, nvmVersions: [String]) -> String {
        let nvm = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        var paths = [runtime.path]
        paths += inherited.split(separator: ":").map(String.init).filter { !$0.isEmpty && $0.hasPrefix("/") }
        paths += [home.appendingPathComponent(".local/bin").path,
                  home.appendingPathComponent(".npm-global/bin").path, home.appendingPathComponent(".volta/bin").path,
                  home.appendingPathComponent(".bun/bin").path, home.appendingPathComponent(".cargo/bin").path,
                  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        paths += nvmVersions.sorted().reversed().map { nvm.appendingPathComponent($0 + "/bin").path }
        return paths.joined(separator: ":")
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
    }

    static func isManagedInstalled(fileManager: FileManager = .default) -> Bool {
        guard isDirectory(root), isDirectory(directory), isDirectory(directory.appendingPathComponent("bin")) else { return false }
        var info = stat()
        return lstat(executable.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG && fileManager.isExecutableFile(atPath: executable.path)
    }

    static func findInstalled(searchPath: String, fileManager: FileManager = .default, appCandidates: [URL]? = nil) -> URL? {
        for dir in searchPath.split(separator: ":") {
            let value = String(dir)
            guard value.hasPrefix("/") else { continue }
            let candidate = URL(fileURLWithPath: value, isDirectory: true).appendingPathComponent("codex")
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        // Some ChatGPT desktop versions include a CLI even without a PATH entry.
        for app in appCandidates ?? [fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Applications/ChatGPT.app"), URL(fileURLWithPath: "/Applications/ChatGPT.app")] {
            let candidate = app.appendingPathComponent("Contents/Resources/codex-cli/bin/codex")
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    static func selected(searchPath: String, fileManager: FileManager = .default, appCandidates: [URL]? = nil) -> (url: URL, installed: Bool, system: Bool) {
        let managed = isManagedInstalled(fileManager: fileManager)
        if managed && fileManager.fileExists(atPath: preference.path) { return (executable, true, false) }
        if let system = findInstalled(searchPath: searchPath, fileManager: fileManager, appCandidates: appCandidates) { return (system, true, true) }
        return (executable, managed, false)
    }

    static func preferManaged() throws {
        guard isManagedInstalled() else { throw failure("The app-managed Codex is not installed.") }
        try Data("1\n".utf8).write(to: preference, options: [.atomic])
    }

    static func preferInstalled(fileManager: FileManager = .default) throws {
        var info = stat()
        if lstat(root.path, &info) != 0 {
            guard errno == ENOENT else { throw failure("The Codex settings folder could not be read.") }
            return
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw failure("The Codex settings folder is not a regular directory.") }
        if lstat(preference.path, &info) == 0 { try fileManager.removeItem(at: preference) }
    }

    // A pinned digest authenticates the entire archive before tar sees any path.
    static func installVerifiedArchive(_ source: URL, fileManager: FileManager = .default) throws {
        guard target != "unsupported" else { throw failure("This Mac architecture is not supported.") }
        let attributes = try fileManager.attributesOfItem(atPath: source.path)
        guard let size = attributes[.size] as? NSNumber, size.int64Value > 0, size.int64Value <= 256 * 1024 * 1024 else {
            throw failure("The Codex download has an unexpected size.")
        }
        let handle = try FileHandle(forReadingFrom: source)
        var hash = SHA256()
        do {
            while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
            try handle.close()
        } catch { try? handle.close(); throw error }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == sha256 else { throw failure("The Codex download failed its security check. Nothing was installed.") }

        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        guard isDirectory(root) else {
            throw failure("The Codex installation folder is not a regular directory.")
        }
        var existing = stat()
        if lstat(directory.path, &existing) == 0 {
            guard (existing.st_mode & S_IFMT) == S_IFDIR, isManagedInstalled(fileManager: fileManager) else {
                throw failure("An incomplete app-managed Codex installation already exists. It was not overwritten.")
            }
            return
        }
        let stage = root.appendingPathComponent(".install-" + UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: stage, withIntermediateDirectories: false)
        defer { try? fileManager.removeItem(at: stage) }
        let unpack = Process()
        unpack.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        unpack.arguments = ["-xzf", source.path, "-C", stage.path]
        unpack.standardOutput = FileHandle.nullDevice
        unpack.standardError = FileHandle.nullDevice
        try unpack.run(); unpack.waitUntilExit()
        guard unpack.terminationReason == .exit, unpack.terminationStatus == 0,
              fileManager.isExecutableFile(atPath: stage.appendingPathComponent("bin/codex").path) else {
            throw failure("Could not unpack Codex. Nothing was installed.")
        }
        try fileManager.moveItem(at: stage, to: directory)
    }

    static func failure(_ text: String) -> NSError {
        NSError(domain: "ConceptGraph.Codex", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
