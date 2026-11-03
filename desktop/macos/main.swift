import AppKit
import Darwin
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverInput: Pipe?
    private var outputBuffer = ""
    private var errorBuffer = ""
    private var serverURL: URL?
    private var lockFD: Int32 = -1
    private var mcpLockFD: Int32 = -1
    private var mcpWarning = false
    private var terminating = false
    private var updates: ConceptGraphUpdates?
    private var dataURL: URL?
    private var storageDestination: URL?
    private var storageChanging = false
    private var storageOverlay: NSView?
    private var screenshotRequestID: String?
    private var codexNeedsInstall = false
    private var codexUsingSystem = false
    private var codexExplicitOverride = false
    private var codexSearchPath = ""
    private var codexInstalling = false
    private var codexPendingRefresh = false
    private var codexDownloadTask: URLSessionDownloadTask?
    private var codexInstallAlert: NSAlert?
    private var codexInstallCancelled = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        updates = ConceptGraphUpdates.create()
        installMenus()
        NSApp.setActivationPolicy(.regular)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Concept Graph"
        window.minSize = NSSize(width: 760, height: 520)
        window.center()
        window.delegate = self
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "conceptGraph")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { try startServer() }
        catch { showFatalError("Could not start Concept Graph", error.localizedDescription) }
    }

    private func startServer() throws {
        guard let resources = Bundle.main.resourceURL else { throw startupError("Application resources are missing.") }
        let runtime = resources.appendingPathComponent("runtime/node")
        let app = resources.appendingPathComponent("app", isDirectory: true)
        let script = app.appendingPathComponent("server.mjs")
        guard FileManager.default.isExecutableFile(atPath: runtime.path), FileManager.default.fileExists(atPath: script.path) else {
            throw startupError("The application is incomplete. Download it again.")
        }
        let environment = ProcessInfo.processInfo.environment
        let data = try StorageLocation.current()
        dataURL = data
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let lockPath = data.appendingPathComponent(".desktop.lock").path
        lockFD = open(lockPath, O_CREAT | O_RDWR, mode_t(0o600))
        guard lockFD >= 0 else { throw startupError("The application data folder cannot be opened.") }
        _ = fcntl(lockFD, F_SETFD, FD_CLOEXEC)
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            close(lockFD); lockFD = -1
            throw startupError("Another Concept Graph window is already using this data folder. Close it and try again.")
        }

        let child = Process()
        child.executableURL = runtime
        child.arguments = [script.path]
        child.currentDirectoryURL = app
        var env = environment
        env["PORT"] = "0"
        env["CONCEPT_GRAPH_DATA"] = data.path
        env["CONCEPT_GRAPH_DESKTOP"] = "1"
        if let session = StorageLocation.mcpSessionURL {
            if let descriptor = StorageLocation.lockMCPSession(session) {
                mcpLockFD = descriptor
                env["CONCEPT_GRAPH_MCP_SESSION_FILE"] = session.path
            } else {
                env.removeValue(forKey: "CONCEPT_GRAPH_MCP_SESSION_FILE")
                mcpWarning = true
            }
        } else { env.removeValue(forKey: "CONCEPT_GRAPH_MCP_SESSION_FILE") }
        env["PATH"] = searchPath(runtime: runtime.deletingLastPathComponent(), inherited: environment["PATH"] ?? "")
        codexSearchPath = env["PATH"] ?? ""
        if env["CODEX_BIN"]?.isEmpty != false {
            let selected = CodexInstall.selected(searchPath: env["PATH"] ?? "")
            env["CODEX_BIN"] = selected.url.path
            codexNeedsInstall = !selected.installed
            codexUsingSystem = selected.system
        } else { codexExplicitOverride = true; codexUsingSystem = env["CODEX_BIN"] != CodexInstall.executable.path }
        env.removeValue(forKey: "CONCEPT_GRAPH_SITE")
        env.removeValue(forKey: "CONCEPT_GRAPH_HELPER_TOKEN")
        child.environment = env
        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        child.standardOutput = stdout
        child.standardError = stderr
        child.standardInput = stdin
        serverInput = stdin
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.receiveOutput(text) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.errorBuffer = String(((self?.errorBuffer ?? "") + text).suffix(4000)) }
        }
        child.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil
                if let destination = self.storageDestination {
                    self.storageDestination = nil
                    guard process.terminationReason == .exit, process.terminationStatus == 0, let source = self.dataURL else {
                        self.finishStorageChange(destination: destination, error: self.startupError("The local service did not stop cleanly. Your original data remains in place.")); return
                    }
                    DispatchQueue.global(qos: .userInitiated).async {
                        let error: Error?
                        do { try StorageLocation.copyAndSelect(source: source, destination: destination); error = nil }
                        catch let caught { error = caught }
                        DispatchQueue.main.async { self.finishStorageChange(destination: destination, error: error) }
                    }
                    return
                }
                if self.terminating { NSApp.reply(toApplicationShouldTerminate: true); return }
                self.showFatalError("Concept Graph stopped", "The local service stopped unexpectedly. Your saved boards remain on this Mac.\n\n" + self.errorBuffer)
            }
        }
        server = child
        try child.run()
        if mcpWarning {
            let alert = NSAlert()
            alert.messageText = "MCP connection unavailable"
            alert.informativeText = "Another Concept Graph window may already be using the MCP connection, or its settings folder is unavailable. You can continue using this window normally."
            alert.addButton(withTitle: "OK")
            alert.beginSheetModal(for: window) { _ in }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.serverURL == nil, !self.terminating else { return }
            self.showFatalError("Concept Graph did not start", "The local service did not become ready. " + self.errorBuffer)
        }
    }

    private func searchPath(runtime: URL, inherited: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvm = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []
        return CodexInstall.searchPath(runtime: runtime, home: home, inherited: inherited, nvmVersions: versions)
    }

    private func receiveOutput(_ text: String) {
        outputBuffer = String((outputBuffer + text).suffix(8000))
        while let end = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<end])
            outputBuffer.removeSubrange(...end)
            let prefix = "Concept Graph is ready at http://127.0.0.1:"
            guard serverURL == nil, line.hasPrefix(prefix), let port = Int(line.dropFirst(prefix.count)),
                  (1...65535).contains(port), server?.isRunning == true,
                  let url = URL(string: "http://127.0.0.1:\(port)/") else { continue }
            serverURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            if codexPendingRefresh { refreshCodex(); codexPendingRefresh = false }
            if codexNeedsInstall {
                codexNeedsInstall = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, !self.terminating, self.window.attachedSheet == nil else { return }
                    self.setUpCodex(nil)
                }
            }
        }
    }

    @objc private func setUpCodex(_ sender: Any?) {
        guard !codexInstalling, !terminating, !storageChanging, window.attachedSheet == nil else { return }
        if codexExplicitOverride {
            showStorageMessage("Codex path is set externally", "CODEX_BIN selects the Codex executable. Remove CODEX_BIN and reopen Concept Graph to manage Codex here.")
            return
        }
        let managedExists = CodexInstall.isManagedInstalled()
        let alert = NSAlert()
        if managedExists {
            alert.messageText = codexUsingSystem ? "Use the app-managed Codex?" : "Codex is installed"
            alert.informativeText = codexUsingSystem
                ? "A compatible app-managed copy is already installed. Concept Graph will use it after you reopen the app. Your existing Codex installation and sign-in will stay in place."
                : "The app-managed Codex is ready. You can retry the connection without restarting."
            alert.addButton(withTitle: codexUsingSystem ? "Use After Reopening" : "Retry Connection")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { [weak self] result in
                guard let self, result == .alertFirstButtonReturn else { return }
                if self.codexUsingSystem {
                    do { try CodexInstall.preferManaged(); self.showStorageMessage("Reopen Concept Graph", "Quit and reopen Concept Graph to switch to the app-managed Codex.") }
                    catch { self.showStorageMessage("Could not change Codex", error.localizedDescription) }
                } else { self.refreshCodex() }
            }
            return
        }
        alert.messageText = codexUsingSystem ? "Install a separate Codex copy?" : "Codex CLI was not found"
        alert.informativeText = "Concept Graph uses Codex to generate images. Download the official Codex CLI from GitHub (\(CodexInstall.downloadSize))? It will be checked and installed for Concept Graph only. Your boards remain available if you choose Not Now."
        alert.addButton(withTitle: "Download Codex")
        alert.addButton(withTitle: "Not Now")
        alert.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .alertFirstButtonReturn else { return }
            self.downloadCodex()
        }
    }

    private func downloadCodex() {
        guard !codexInstalling, !terminating else { return }
        codexInstalling = true; codexInstallCancelled = false
        let alert = NSAlert()
        alert.messageText = "Downloading Codex…"
        alert.informativeText = "The official download will be verified before it is installed."
        let spinner = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 24, height: 24)); spinner.style = .spinning; spinner.startAnimation(nil)
        alert.accessoryView = spinner
        alert.addButton(withTitle: "Cancel")
        codexInstallAlert = alert
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 120; config.timeoutIntervalForResource = 3600
        let session = URLSession(configuration: config)
        let task = session.downloadTask(with: CodexInstall.downloadURL) { [weak self] location, response, error in
            guard let self else { session.finishTasksAndInvalidate(); return }
            guard error == nil, let location, let http = response as? HTTPURLResponse,
                  http.statusCode == 200, http.url?.scheme == "https" else {
                session.finishTasksAndInvalidate()
                DispatchQueue.main.async { self.finishCodexInstall(error: error ?? CodexInstall.failure("The download did not complete.")) }
                return
            }
            let archive = FileManager.default.temporaryDirectory.appendingPathComponent("concept-codex-" + UUID().uuidString + ".tar.gz")
            do { try FileManager.default.moveItem(at: location, to: archive) }
            catch { session.finishTasksAndInvalidate(); DispatchQueue.main.async { self.finishCodexInstall(error: error) }; return }
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async {
                if self.codexInstallCancelled {
                    try? FileManager.default.removeItem(at: archive)
                    self.finishCodexInstall(error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)); return
                }
                alert.messageText = "Verifying and installing Codex…"
                alert.buttons.first?.isEnabled = false
                DispatchQueue.global(qos: .userInitiated).async {
                    defer { try? FileManager.default.removeItem(at: archive) }
                    do {
                        try CodexInstall.installVerifiedArchive(archive)
                        if self.codexUsingSystem { try CodexInstall.preferManaged() }
                        DispatchQueue.main.async { self.finishCodexInstall(error: nil) }
                    } catch { DispatchQueue.main.async { self.finishCodexInstall(error: error) } }
                }
            }
        }
        codexDownloadTask = task
        alert.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .alertFirstButtonReturn else { return }
            self.codexInstallCancelled = true
            self.codexDownloadTask?.cancel()
        }
        task.resume()
    }

    private func finishCodexInstall(error: Error?) {
        codexInstalling = false; codexDownloadTask = nil
        if let alert = codexInstallAlert, alert.window.sheetParent != nil { window.endSheet(alert.window, returnCode: .alertSecondButtonReturn) }
        codexInstallAlert = nil
        if let error {
            if (error as NSError).code != NSURLErrorCancelled { showStorageMessage("Could not install Codex", error.localizedDescription + "\n\nYou can retry from Concept Graph → Set Up Codex…") }
            return
        }
        if codexUsingSystem { showStorageMessage("Codex installed", "Quit and reopen Concept Graph to switch to the app-managed Codex. Your existing CLI was not changed.") }
        else { refreshCodex(); showStorageMessage("Codex installed", "Codex is ready. Sign in with ChatGPT if prompted.") }
    }

    private func refreshCodex() {
        guard let url = serverURL?.appendingPathComponent("api/status") else { codexPendingRefresh = true; return }
        var request = URLRequest(url: url); request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
    }

    @objc private func useInstalledCodex(_ sender: Any?) {
        guard !codexInstalling, !terminating, !storageChanging, window.attachedSheet == nil else { return }
        if codexExplicitOverride {
            showStorageMessage("Codex path is set externally", "CODEX_BIN selects the Codex executable. Remove CODEX_BIN and reopen Concept Graph to use an installed CLI.")
            return
        }
        guard CodexInstall.findInstalled(searchPath: codexSearchPath) != nil else {
            showStorageMessage("No installed Codex found", "Install Codex CLI first. Your app-managed copy will remain available.")
            return
        }
        if codexUsingSystem { showStorageMessage("Installed Codex is in use", "Concept Graph is already using an installed Codex CLI."); return }
        do {
            try CodexInstall.preferInstalled()
            showStorageMessage("Reopen Concept Graph", "Quit and reopen Concept Graph to use the installed Codex CLI. Your app-managed copy will remain in place.")
        } catch { showStorageMessage("Could not change Codex", error.localizedDescription) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if storageChanging { return .terminateCancel }
        if terminating { return .terminateLater }
        terminating = true
        guard server?.isRunning == true else { return .terminateNow }
        guard serverURL != nil else { stopServer(); return .terminateLater }
        webView.callAsyncJavaScript("return typeof window.conceptGraphPrepareToQuit === 'function' ? await window.conceptGraphPrepareToQuit() : {activeRuns:false}",
                                   arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                if let state = value as? [String: Any], state["activeRuns"] as? Bool == true {
                    let alert = NSAlert()
                    alert.messageText = "Generation is still running"
                    alert.informativeText = "Quitting will cancel the active generation. Existing results will be kept."
                    alert.addButton(withTitle: "Keep Working")
                    alert.addButton(withTitle: "Quit and Cancel")
                    if alert.runModal() == .alertFirstButtonReturn {
                        self.terminating = false
                        NSApp.reply(toApplicationShouldTerminate: false)
                        return
                    }
                }
                self.stopServer()
            case .failure(let error):
                let alert = NSAlert()
                alert.messageText = "Could not finish saving"
                alert.informativeText = error.localizedDescription + "\n\nFinish the current operation or retry before quitting."
                alert.addButton(withTitle: "OK")
                alert.runModal()
                self.terminating = false
                NSApp.reply(toApplicationShouldTerminate: false)
            }
        }
        return .terminateLater
    }

    private func stopServer() {
        if let server, server.isRunning {
            serverInput?.fileHandleForWriting.closeFile()
            serverInput = nil
        }
        else { NSApp.reply(toApplicationShouldTerminate: true) }
    }

    @objc private func changeStorageLocation(_ sender: Any?) {
        guard !storageChanging, let data = dataURL, server?.isRunning == true else { return }
        let info = NSAlert()
        info.messageText = "Storage location"
        info.informativeText = "Your boards, generation history and images are stored on this Mac:\n\n" + data.path
        if StorageLocation.environmentOverride != nil {
            info.informativeText += "\n\nThis location was set by the CONCEPT_GRAPH_DATA environment variable. Remove that override to change it here."
            info.addButton(withTitle: "OK"); info.runModal(); return
        }
        info.addButton(withTitle: "Choose New Location…")
        info.addButton(withTitle: "Cancel")
        guard info.runModal() == .alertFirstButtonReturn else { return }
        let panel = NSOpenPanel()
        panel.message = "Choose where to create a new ‘Concept Graph Data’ folder."
        panel.prompt = "Choose Location"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let parent = panel.url else { return }
        let destination: URL
        do { destination = try StorageLocation.destination(parent: parent, source: data) }
        catch { showStorageMessage("Could not use this folder", error.localizedDescription); return }
        let confirm = NSAlert()
        confirm.messageText = "Copy data to the new location?"
        confirm.informativeText = "Boards, history and images will be copied to:\n\n" + destination.path + "\n\nThe originals will remain at the current location. Concept Graph will quit after copying; reopen it to use the new location."
        confirm.addButton(withTitle: "Copy and Quit"); confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        storageChanging = true
        showStorageOverlay()
        webView.isHidden = true
        webView.callAsyncJavaScript("document.documentElement.inert = true; try { if (typeof window.conceptGraphPrepareToQuit !== 'function') throw new Error('Workspace is not ready.'); return await window.conceptGraphPrepareToQuit(); } catch (error) { document.documentElement.inert = false; throw error; }", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                guard let state = value as? [String: Any], let active = state["activeRuns"] as? Bool else {
                    self.cancelStorageChange("Could not check whether a generation is active."); return
                }
                guard !active else { self.cancelStorageChange("Wait for the current generation to finish, then try again."); return }
                self.storageDestination = destination
                self.stopServer()
            case .failure(let error): self.cancelStorageChange(error.localizedDescription)
            }
        }
    }

    private func showStorageOverlay() {
        let overlay = NSView(frame: window.contentView!.bounds)
        overlay.autoresizingMask = [.width, .height]
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let label = NSTextField(labelWithString: "Saving and copying your boards and images…")
        let spinner = NSProgressIndicator()
        spinner.style = .spinning; spinner.controlSize = .regular; spinner.startAnimation(nil)
        for view in [label, spinner] { view.translatesAutoresizingMaskIntoConstraints = false; overlay.addSubview(view) }
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: overlay.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -16),
            label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor), label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 18)
        ])
        window.contentView?.addSubview(overlay); storageOverlay = overlay
    }
    private func showStorageMessage(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail; alert.addButton(withTitle: "OK"); alert.runModal()
    }
    private func cancelStorageChange(_ detail: String) {
        storageChanging = false; storageOverlay?.removeFromSuperview(); storageOverlay = nil
        webView.isHidden = false
        webView.evaluateJavaScript("document.documentElement.inert = false")
        showStorageMessage("Storage location was not changed", detail)
    }
    private func finishStorageChange(destination: URL, error: Error?) {
        if let error {
            showStorageMessage("Storage location was not changed", error.localizedDescription + "\n\nYour original data is still in its previous folder. Reopen Concept Graph to continue. A copy may remain at:\n\n" + destination.path)
        } else {
            showStorageMessage("Storage location changed", "Your boards and images were copied successfully. Reopen Concept Graph to use the new location. The originals remain in the previous folder.")
        }
        storageChanging = false
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if lockFD >= 0 { flock(lockFD, LOCK_UN); close(lockFD); lockFD = -1 }
        if mcpLockFD >= 0 { flock(mcpLockFD, LOCK_UN); close(mcpLockFD); mcpLockFD = -1 }
    }

    private func startupError(_ message: String) -> NSError {
        NSError(domain: "ConceptGraph", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func showFatalError(_ title: String, _ message: String) {
        guard !terminating else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // Only the trusted local main frame may request its own WebView image.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == "conceptGraph", message.frameInfo.isMainFrame, message.webView === webView,
              origin.protocol == "http", origin.host == "127.0.0.1", origin.port == serverURL?.port,
              let body = message.body as? [String: Any], body.count == 2, body["type"] as? String == "mcp-screenshot",
              let id = body["id"] as? String, UUID(uuidString: id) != nil else { return }
        guard !terminating, !storageChanging, window.isVisible, !window.isMiniaturized,
              !webView.isHidden, !webView.isLoading else { screenshotReply(id, error: "The Concept Graph window is not ready or visible."); return }
        guard screenshotRequestID == nil else { screenshotReply(id, error: "A screenshot is already in progress."); return }
        screenshotRequestID = id
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { [weak self] image, _ in
            guard let self, self.screenshotRequestID == id else { return }
            self.screenshotRequestID = nil
            guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                self.screenshotReply(id, error: "Could not capture the Concept Graph window."); return
            }
            guard png.count <= 8 * 1024 * 1024 else { self.screenshotReply(id, error: "The screenshot is larger than 8 MiB. Make the window smaller and try again."); return }
            self.screenshotReply(id, data: png)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.screenshotRequestID == id else { return }
            self.screenshotRequestID = nil
            self.screenshotReply(id, error: "Capturing the Concept Graph window timed out.")
        }
    }

    private func screenshotReply(_ id: String, data: Data? = nil, error: String? = nil) {
        let reply: [String: Any] = data.map { ["id": id, "mimeType": "image/png", "data": $0.base64EncodedString()] }
            ?? ["id": id, "error": error ?? "Could not capture the Concept Graph window."]
        guard let json = try? JSONSerialization.data(withJSONObject: reply), let encoded = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.conceptGraphScreenshotResult?.(\(encoded))")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if url.scheme == "blob" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == serverURL?.port) {
            decisionHandler(.allow); return
        }
        if action.navigationType == .linkActivated && url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.begin { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    private func installMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        let codexItem = NSMenuItem(title: "Set Up Codex…", action: #selector(setUpCodex(_:)), keyEquivalent: "")
        codexItem.target = self; appMenu.addItem(codexItem)
        let installedCodexItem = NSMenuItem(title: "Use Installed Codex After Restart…", action: #selector(useInstalledCodex(_:)), keyEquivalent: "")
        installedCodexItem.target = self; appMenu.addItem(installedCodexItem)
        let storageItem = NSMenuItem(title: "Storage Location…", action: #selector(changeStorageLocation(_:)), keyEquivalent: "")
        storageItem.target = self; appMenu.addItem(storageItem)
        appMenu.addItem(.separator())
        if let updates {
            let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(ConceptGraphUpdates.checkForUpdates(_:)), keyEquivalent: "")
            updateItem.target = updates
            appMenu.addItem(updateItem)
            appMenu.addItem(.separator())
        }
        appMenu.addItem(withTitle: "Quit Concept Graph", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit"); editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = menu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
