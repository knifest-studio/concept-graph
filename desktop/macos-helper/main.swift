import AppKit
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let codeField = NSTextField(labelWithString: "Waiting for pairing code…")
    private let status = NSTextField(wrappingLabelWithString: "Starting…")
    private var copyButton: NSButton!
    private var child: Process?
    private var lifeline: Pipe?
    private var outputBuffer = Data()
    private var errorBuffer = ""
    private var pairingCode = ""
    private var site: URL?
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Concept Graph Helper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let edit = NSMenuItem(), editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu; menu.addItem(edit); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 390),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Concept Graph Helper"
        window.delegate = self
        window.center()
        let title = NSTextField(labelWithString: "Concept Graph Helper")
        title.font = .boldSystemFont(ofSize: 24)
        title.frame = NSRect(x: 24, y: 330, width: 732, height: 32)
        let instruction = NSTextField(labelWithString: "Paste this pairing code into the board site. Keep this window open.")
        instruction.frame = NSRect(x: 24, y: 298, width: 732, height: 22)
        codeField.font = .monospacedSystemFont(ofSize: 17, weight: .medium)
        codeField.isSelectable = true
        codeField.alignment = .center
        codeField.frame = NSRect(x: 24, y: 246, width: 732, height: 30)
        codeField.setAccessibilityLabel("Pairing code")
        copyButton = NSButton(title: "Copy code", target: self, action: #selector(copyCode(_:)))
        copyButton.isEnabled = false
        copyButton.frame = NSRect(x: 220, y: 194, width: 130, height: 32)
        let open = NSButton(title: "Open board site", target: self, action: #selector(openSite(_:)))
        open.frame = NSRect(x: 366, y: 194, width: 180, height: 32)
        status.frame = NSRect(x: 24, y: 24, width: 732, height: 144)
        status.font = .systemFont(ofSize: 12)
        status.isSelectable = true
        for view in [title, instruction, codeField, copyButton!, open, status] { window.contentView?.addSubview(view) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { try startHelper() } catch { showStopped(error.localizedDescription) }
    }

    private func startHelper() throws {
        guard let resources = Bundle.main.resourceURL,
              let origins = Bundle.main.object(forInfoDictionaryKey: "ConceptGraphHelperSite") as? String,
              let first = origins.split(separator: ",").first,
              let url = URL(string: String(first)), url.scheme == "https", url.host != nil else {
            throw NSError(domain: "ConceptGraph.Helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "The app has no valid board site. Rebuild with CONCEPT_GRAPH_HELPER_SITE."])
        }
        site = url
        let runtime = resources.appendingPathComponent("runtime")
        let helper = resources.appendingPathComponent("helper")
        let process = Process()
        process.executableURL = runtime.appendingPathComponent("node")
        process.arguments = [helper.appendingPathComponent("helper.mjs").path]
        process.currentDirectoryURL = helper
        var env = ProcessInfo.processInfo.environment
        env["CONCEPT_GRAPH_SITE"] = origins
        env["PORT"] = "43170"
        env["PATH"] = searchPath(runtime: runtime, inherited: env["PATH"] ?? "")
        if env["CODEX_BIN"]?.isEmpty != false, let codex = findCodex(searchPath: env["PATH"] ?? "") { env["CODEX_BIN"] = codex.path }
        process.environment = env
        let stdout = Pipe(), stderr = Pipe(), drained = DispatchGroup()
        process.standardOutput = stdout
        process.standardError = stderr
        // Kept open for the app's lifetime; the helper exits on EOF if this app dies without cleanup.
        let input = Pipe()
        lifeline = input
        env["CONCEPT_GRAPH_EXIT_WITH_PARENT"] = "1"
        process.environment = env
        process.standardInput = input
        process.terminationHandler = { [weak self] process in
            drained.notify(queue: .main) {
                guard let self else { return }
                if self.terminating { NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.showStopped("The helper exited (status \(process.terminationStatus)).") }
            }
        }
        // Register readers before launch so termination waits for the final stderr bytes.
        drained.enter(); drained.enter()
        do { try process.run() } catch {
            drained.leave(); drained.leave()
            throw error
        }
        child = process
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        for (pipe, isError) in [(stdout, false), (stderr, true)] {
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let handle = pipe.fileHandleForReading
                defer { try? handle.close(); drained.leave() }
                // availableData returns as soon as any bytes arrive; read(upToCount:) waits for the full count or EOF.
                while case let data = handle.availableData, !data.isEmpty {
                    DispatchQueue.main.async {
                        guard let self else { return }
                        if isError { self.errorBuffer = String((self.errorBuffer + String(decoding: data, as: UTF8.self)).suffix(8000)) }
                        else { self.receiveOutput(data) }
                    }
                }
            }
        }
    }

    // Keep CLI discovery aligned with desktop/macos/CodexInstall.swift.
    private func searchPath(runtime: URL, inherited: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvm = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []
        var paths = [runtime.path]
        paths += inherited.split(separator: ":").map(String.init).filter { !$0.isEmpty && $0.hasPrefix("/") }
        paths += [home.appendingPathComponent(".local/bin").path,
                  home.appendingPathComponent(".npm-global/bin").path, home.appendingPathComponent(".volta/bin").path,
                  home.appendingPathComponent(".bun/bin").path, home.appendingPathComponent(".cargo/bin").path,
                  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        paths += versions.sorted().reversed().map { nvm.appendingPathComponent($0 + "/bin").path }
        return paths.joined(separator: ":")
    }

    private func findCodex(searchPath: String) -> URL? {
        let files = FileManager.default
        for directory in searchPath.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(directory), isDirectory: true).appendingPathComponent("codex")
            if files.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        for app in [files.homeDirectoryForCurrentUser.appendingPathComponent("Applications/ChatGPT.app"), URL(fileURLWithPath: "/Applications/ChatGPT.app")] {
            let candidate = app.appendingPathComponent("Contents/Resources/codex-cli/bin/codex")
            if files.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    private func receiveOutput(_ data: Data) {
        guard !terminating else { return }
        outputBuffer.append(data)
        while let end = outputBuffer.firstIndex(of: 10) {
            let line = String(decoding: outputBuffer[..<end], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            outputBuffer.removeSubrange(...end)
            let prefix = "Concept Graph connection code: "
            if line.hasPrefix(prefix) {
                let code = String(line.dropFirst(prefix.count))
                if code.count == 64 && code.allSatisfy({ "0123456789abcdef".contains($0) }) {
                    pairingCode = code; codeField.stringValue = code
                }
            }
            if line == "Concept Graph is ready at http://127.0.0.1:43170", child?.isRunning == true {
                status.stringValue = "Ready — paste the code into the board site."
                copyButton.isEnabled = !pairingCode.isEmpty
            }
        }
        if outputBuffer.count > 8000 { outputBuffer = Data(outputBuffer.suffix(8000)) }
    }

    private func showStopped(_ message: String) {
        copyButton.isEnabled = false
        pairingCode = ""; codeField.stringValue = "Helper stopped"
        let detail = errorBuffer.contains("EADDRINUSE")
            ? "Port 43170 is already in use. Another helper may be running. Quit it, then reopen this app."
            : message
        let lines = errorBuffer.split(whereSeparator: \.isNewline).suffix(6).joined(separator: "\n")
        status.stringValue = "Stopped — " + detail + (lines.isEmpty ? "" : "\n" + lines)
    }

    @objc private func copyCode(_ sender: Any?) {
        guard !pairingCode.isEmpty, child?.isRunning == true else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingCode, forType: .string)
    }

    @objc private func openSite(_ sender: Any?) {
        if let site { NSWorkspace.shared.open(site) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child, child.isRunning else { return .terminateNow }
        if !terminating {
            terminating = true
            status.stringValue = "Stopping…"
            child.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            }
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
