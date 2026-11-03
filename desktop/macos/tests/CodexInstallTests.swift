import Foundation

@main struct CodexInstallTests {
    static func main() throws {
        let fm = FileManager.default
        guard let root = ProcessInfo.processInfo.environment["CONCEPT_GRAPH_TEST_ROOT"], root.hasPrefix("/"),
              ProcessInfo.processInfo.environment["CONCEPT_GRAPH_DESKTOP_SETTINGS"] == root + "/settings/storage.json" else {
            fatalError("Set isolated CONCEPT_GRAPH_TEST_ROOT and CONCEPT_GRAPH_DESKTOP_SETTINGS.")
        }
        let folder = URL(fileURLWithPath: root)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let first = folder.appendingPathComponent("first/bin", isDirectory: true)
        let second = folder.appendingPathComponent("second/bin", isDirectory: true)
        try fm.createDirectory(at: first, withIntermediateDirectories: true)
        try fm.createDirectory(at: second, withIntermediateDirectories: true)
        let binary = second.appendingPathComponent("codex")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        precondition(CodexInstall.findInstalled(searchPath: first.path + ":" + second.path, appCandidates: [])?.path == binary.path)
        precondition(CodexInstall.selected(searchPath: first.path + ":" + second.path, appCandidates: []).system)
        let home = folder.appendingPathComponent("home", isDirectory: true)
        let fallback = home.appendingPathComponent(".local/bin", isDirectory: true)
        try fm.createDirectory(at: fallback, withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: fallback.appendingPathComponent("codex"))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fallback.appendingPathComponent("codex").path)
        let search = CodexInstall.searchPath(runtime: first, home: home, inherited: second.path + ":relative", nvmVersions: ["v22.0.0"])
        precondition(search.split(separator: ":").first == Substring(first.path))
        precondition(CodexInstall.findInstalled(searchPath: search, appCandidates: [])?.path == binary.path)
        let missing = CodexInstall.selected(searchPath: first.path, appCandidates: [])
        precondition(!missing.installed && missing.url == CodexInstall.executable)
        let bad = folder.appendingPathComponent("bad.tar.gz")
        try Data("not an archive".utf8).write(to: bad)
        do { try CodexInstall.installVerifiedArchive(bad); fatalError("invalid archive was accepted") } catch {}
        precondition(!fm.fileExists(atPath: CodexInstall.directory.path))
        if let archive = ProcessInfo.processInfo.environment["CONCEPT_GRAPH_CODEX_TEST_ARCHIVE"] {
            try CodexInstall.installVerifiedArchive(URL(fileURLWithPath: archive))
            precondition(fm.isExecutableFile(atPath: CodexInstall.executable.path))
            let existingPreferred = CodexInstall.selected(searchPath: second.path, appCandidates: [])
            precondition(existingPreferred.system)
            try CodexInstall.preferManaged()
            let managedPreferred = CodexInstall.selected(searchPath: second.path, appCandidates: [])
            precondition(managedPreferred.installed && !managedPreferred.system && managedPreferred.url == CodexInstall.executable)
            try CodexInstall.preferInstalled()
            precondition(CodexInstall.selected(searchPath: second.path, appCandidates: []).system)
            precondition(!fm.fileExists(atPath: CodexInstall.preference.path))
            precondition(fm.isExecutableFile(atPath: CodexInstall.executable.path))
            try CodexInstall.installVerifiedArchive(URL(fileURLWithPath: archive))
        }
        print("macOS Codex discovery and verified installation checks passed")
    }
}
