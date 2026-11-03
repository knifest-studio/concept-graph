using System.Diagnostics;
using System.ComponentModel;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ConceptGraph.Windows;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow());
    }
}

internal sealed class MainWindow : Form
{
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly Label message = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = "Starting Concept Graph…" };
    private readonly MenuStrip menu = new();
    private Process? server;
    private FileStream? dataLock;
    private FileStream? mcpLock;
    private Uri? serverOrigin;
    private string? dataDirectory;
    private string? selectedCodex;
    private string StorageConfig => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Concept Graph", "storage-location.json");
    private string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    private bool closing;
    private bool quitInProgress;
    private bool allowClose;
    private TaskCompletionSource<bool>? quitResponse;
    private string? quitRequestId;
    private bool screenshotInProgress;

    public MainWindow()
    {
        Text = "Concept Graph";
        Width = 1280;
        Height = 820;
        MinimumSize = new Size(720, 520);
        Controls.Add(message);
        var storageMenu = new ToolStripMenuItem("Storage");
        var showStorage = new ToolStripMenuItem("Current Storage Folder…");
        showStorage.Click += (_, _) => MessageBox.Show(this, dataDirectory is null ? "Storage is not ready yet." : "Boards and images are stored in:\n\n" + dataDirectory, "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Information);
        var changeStorage = new ToolStripMenuItem("Change Storage Folder…");
        changeStorage.Click += async (_, _) => await ChangeStorageAsync();
        storageMenu.DropDownItems.Add(showStorage);
        storageMenu.DropDownItems.Add(changeStorage);
        menu.Items.Add(storageMenu);
        var codexMenu = new ToolStripMenuItem("Codex");
        var installCodex = new ToolStripMenuItem("Set Up Compatible Codex…");
        installCodex.Click += (_, _) => SetUpCodexAfterLaunch();
        var useInstalled = new ToolStripMenuItem("Use Installed Codex After Restart");
        useInstalled.Click += (_, _) => UseInstalledCodex();
        codexMenu.DropDownItems.Add(installCodex);
        codexMenu.DropDownItems.Add(useInstalled);
        menu.Items.Add(codexMenu);
        MainMenuStrip = menu;
        Controls.Add(menu);
        Shown += async (_, _) => await StartAsync();
        FormClosing += async (_, args) => await PrepareToCloseAsync(args);
        FormClosed += (_, _) => DisposeServer();
    }

    private async Task StartAsync()
    {
        try
        {
            string applicationDirectory = AppContext.BaseDirectory;
            string runtimeDirectory = Path.Combine(applicationDirectory, "runtime");
            string nodePath = Path.Combine(runtimeDirectory, "node.exe");
            string appDirectory = Path.Combine(applicationDirectory, "app");
            string serverPath = Path.Combine(appDirectory, "server.mjs");
            if (!File.Exists(nodePath) || !File.Exists(serverPath))
                throw new InvalidOperationException("The application files are incomplete. Reinstall Concept Graph.");

            dataDirectory = StorageLocation.Resolve(Environment.GetEnvironmentVariable("CONCEPT_GRAPH_DATA"), StorageConfig,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Concept Graph", "data"));
            Directory.CreateDirectory(dataDirectory);
            try { dataLock = new FileStream(Path.Combine(dataDirectory, ".desktop.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { throw new InvalidOperationException("Concept Graph is already open for this data folder."); }

            selectedCodex = await CodexInstallation.FindAsync(LocalAppData);
            if (closing || IsDisposed) return;
            if (selectedCodex is null)
            {
                SetUpCodex(firstLaunch: true);
                if (closing || IsDisposed) return;
                // The path remains stable if setup is deferred and retried from the Codex menu.
                selectedCodex = CodexInstallation.ManagedPath(LocalAppData);
            }

            var start = new ProcessStartInfo(nodePath)
            {
                WorkingDirectory = appDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(serverPath);
            start.Environment["PORT"] = "0";
            start.Environment["CONCEPT_GRAPH_DESKTOP"] = "1";
            start.Environment["CONCEPT_GRAPH_DATA"] = dataDirectory;
            string? sessionFile = StorageLocation.McpSessionFile(Environment.GetEnvironmentVariable("CONCEPT_GRAPH_MCP_SESSION_FILE"), Environment.GetEnvironmentVariable("CONCEPT_GRAPH_DATA"), StorageConfig);
            if (sessionFile is null) start.Environment.Remove("CONCEPT_GRAPH_MCP_SESSION_FILE");
            else if ((mcpLock = StorageLocation.LockMcpSession(sessionFile)) is not null) start.Environment["CONCEPT_GRAPH_MCP_SESSION_FILE"] = sessionFile;
            else
            {
                start.Environment.Remove("CONCEPT_GRAPH_MCP_SESSION_FILE");
                var warning = new ToolStripMenuItem("MCP unavailable") { Enabled = false, ToolTipText = "Another Concept Graph window may be using MCP, or its settings folder is unavailable." };
                menu.Items.Add(warning);
            }
            start.Environment.Remove("CONCEPT_GRAPH_SITE");
            start.Environment.Remove("CONCEPT_GRAPH_HELPER_TOKEN");
            start.Environment["CODEX_BIN"] = selectedCodex;
            start.Environment.TryGetValue("PATH", out string? existingPath);
            start.Environment["PATH"] = runtimeDirectory + Path.PathSeparator + existingPath;
            server = Process.Start(start) ?? throw new InvalidOperationException("The local server could not be started.");
            server.EnableRaisingEvents = true;
            server.Exited += (_, _) => ServerExited();
            _ = DrainAsync(server.StandardError);

            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            while (serverOrigin is null)
            {
                string? line = await server.StandardOutput.ReadLineAsync(timeout.Token);
                if (line is null) throw new InvalidOperationException("The local server stopped during startup.");
                if (DesktopProtocol.TryReadReadyPort(line, out int port))
                    serverOrigin = new Uri($"http://127.0.0.1:{port}/");
            }
            if (server.HasExited) throw new InvalidOperationException("The local server stopped during startup.");
            _ = DrainAsync(server.StandardOutput);

            string profileDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Concept Graph", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profileDirectory);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.Settings.AreDevToolsEnabled = false;
            view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            view.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out Uri? uri) || uri.Scheme != serverOrigin.Scheme || uri.Host != serverOrigin.Host || uri.Port != serverOrigin.Port)
                {
                    args.Cancel = true;
                    if (!args.IsRedirected) OpenTrustedLogin(args.Uri, args.IsUserInitiated);
                }
            };
            view.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            view.CoreWebView2.WebMessageReceived += async (_, args) =>
            {
                if (!Uri.TryCreate(args.Source, UriKind.Absolute, out Uri? source) || serverOrigin is null
                    || source.Scheme != serverOrigin.Scheme || source.Host != serverOrigin.Host || source.Port != serverOrigin.Port) return;
                if (DesktopProtocol.TryReadScreenshotRequest(args.WebMessageAsJson, out string id)) await CaptureScreenshotAsync(id);
                else ReceiveWebMessage(args.WebMessageAsJson);
            };
            Controls.Add(view);
            view.BringToFront();
            menu.BringToFront();
            view.CoreWebView2.Navigate(serverOrigin.AbsoluteUri);
        }
        catch (Exception error)
        {
            bool wasClosing = closing;
            closing = true;
            await StopServerAsync();
            closing = wasClosing;
            if (!closing && !IsDisposed) message.Text = "Could not start Concept Graph.\n\n" + error.Message;
        }
    }

    private bool SetUpCodex(bool firstLaunch)
    {
        string explanation = firstLaunch
            ? "Codex CLI was not found. Concept Graph can download the official Codex CLI from OpenAI (about 155 MiB) and install it for this app.\n\nYour boards remain available if you choose Not now."
            : "Download the official compatible Codex CLI from OpenAI (about 155 MiB) for use with Concept Graph? Your existing Codex installation will not be changed.";
        if (MessageBox.Show(this, explanation, "Set up Codex", MessageBoxButtons.YesNo, MessageBoxIcon.Information) != DialogResult.Yes) return false;
        using var setup = new CodexSetupDialog(LocalAppData);
        DialogResult result = setup.ShowDialog(this);
        if (result == DialogResult.Abort)
            MessageBox.Show(this, "Codex could not be installed. Your boards are still available. You can retry from the Codex menu.\n\n" + setup.ErrorMessage, "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return result == DialogResult.OK;
    }

    private void SetUpCodexAfterLaunch()
    {
        if (server is null || closing || quitInProgress) return;
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CODEX_BIN")))
        {
            MessageBox.Show(this, "CODEX_BIN controls which Codex executable is used. Remove that override and reopen Concept Graph to use the guided setup.", "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (!SetUpCodex(firstLaunch: false)) return;
        string managed = CodexInstallation.ManagedPath(LocalAppData);
        if (string.Equals(selectedCodex, managed, StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show(this, "Codex is ready. Select Check Codex in the top bar to connect.", "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string preference = CodexInstallation.PreferencePath(LocalAppData), temporary = preference + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, "prefer-managed\n");
            File.Move(temporary, preference, overwrite: true);
            MessageBox.Show(this, "Compatible Codex is ready. Close and reopen Concept Graph to use it.", "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { MessageBox.Show(this, "Codex was downloaded, but the preference could not be saved. " + error.Message, "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }

    private void UseInstalledCodex()
    {
        if (server is null || closing || quitInProgress) return;
        try
        {
            File.Delete(CodexInstallation.PreferencePath(LocalAppData));
            MessageBox.Show(this, "Reopen Concept Graph to look for your installed Codex CLI again.", "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { MessageBox.Show(this, error.Message, "Codex setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    private void OpenTrustedLogin(string address, bool userInitiated)
    {
        if (!userInitiated || !Uri.TryCreate(address, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0
            || !(string.Equals(uri.Host, "auth.openai.com", StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase))) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Win32Exception) { MessageBox.Show(this, "Could not open your browser. Check that a default browser is installed.", "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        catch (InvalidOperationException) { MessageBox.Show(this, "Could not open your browser. Check that a default browser is installed.", "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    private static async Task DrainAsync(StreamReader reader)
    {
        try { while (await reader.ReadLineAsync() is not null) { } }
        catch (ObjectDisposedException) { }
        catch (IOException) { }
    }

    private void ReceiveWebMessage(string json)
    {
        if (!DesktopProtocol.TryReadQuitResponse(json, quitRequestId, out bool activeRuns, out string? error)) return;
        if (error is not null) quitResponse?.TrySetException(new InvalidOperationException(error));
        else quitResponse?.TrySetResult(activeRuns);
    }

    private async Task CaptureScreenshotAsync(string id)
    {
        string? error = null;
        byte[]? image = null;
        if (screenshotInProgress) error = "A screenshot is already in progress.";
        else if (closing || IsDisposed || WindowState == FormWindowState.Minimized || !Visible || !view.Visible || view.CoreWebView2 is null)
            error = "The Concept Graph window is not ready or visible.";
        else
        {
            screenshotInProgress = true;
            try
            {
                using var stream = new MemoryStream();
                await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream).WaitAsync(TimeSpan.FromSeconds(20));
                if (stream.Length > 8 * 1024 * 1024) error = "The screenshot is larger than 8 MiB. Make the window smaller and try again.";
                else image = stream.ToArray();
            }
            catch (TimeoutException) { error = "Capturing the Concept Graph window timed out."; }
            catch (Exception) { error = "Could not capture the Concept Graph window."; }
            finally { screenshotInProgress = false; }
        }
        if (IsDisposed || view.CoreWebView2 is null) return;
        string reply = image is null ? JsonSerializer.Serialize(new { id, error = error ?? "Could not capture the Concept Graph window." })
            : JsonSerializer.Serialize(new { id, mimeType = "image/png", data = Convert.ToBase64String(image) });
        try { await view.CoreWebView2.ExecuteScriptAsync($"window.conceptGraphScreenshotResult?.({reply})"); }
        catch (Exception) { }
    }

    private async Task<bool> PrepareWebAsync()
    {
        if (view.CoreWebView2 is null || server is not { HasExited: false })
            throw new InvalidOperationException("The local server is not ready.");
        quitRequestId = Guid.NewGuid().ToString("N");
        quitResponse = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        string request = JsonSerializer.Serialize(quitRequestId);
        await view.CoreWebView2.ExecuteScriptAsync($$"""
            (async () => {
              try {
                if (typeof window.conceptGraphPrepareToQuit !== 'function') throw new Error('The board is not ready to save yet.');
                const result = await window.conceptGraphPrepareToQuit();
                window.chrome.webview.postMessage({ id: {{request}}, activeRuns: !!result.activeRuns });
              } catch (error) {
                window.chrome.webview.postMessage({ id: {{request}}, error: String(error?.message || error) });
              }
            })();
            """);
        return await quitResponse.Task.WaitAsync(TimeSpan.FromSeconds(15));
    }

    private async Task ChangeStorageAsync()
    {
        if (quitInProgress || dataDirectory is null) return;
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CONCEPT_GRAPH_DATA")))
        {
            MessageBox.Show(this, "The storage folder is controlled by CONCEPT_GRAPH_DATA. Remove that override to change the folder here.", "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        using var chooser = new FolderBrowserDialog { Description = "Choose where to create a new Concept Graph Data folder. Your current files will be copied and kept in their old location.", UseDescriptionForTitle = true, ShowNewFolderButton = true };
        if (chooser.ShowDialog(this) != DialogResult.OK) return;
        try { StorageLocation.Destination(dataDirectory, chooser.SelectedPath); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        quitInProgress = true;
        view.Enabled = false;
        menu.Enabled = false;
        bool stopped = false;
        try
        {
            if (await PrepareWebAsync())
            {
                MessageBox.Show(this, "Wait for image generation to finish before changing the storage folder.", "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            closing = true;
            view.Visible = false;
            message.Text = "Copying and verifying your boards and images…";
            if (!await StopServerAsync(releaseLock: false, requireCleanExit: true))
            {
                closing = false;
                view.Visible = true;
                throw new InvalidOperationException("The local server is still closing. Close and reopen the app before trying again.");
            }
            stopped = true;
            string destination = await Task.Run(() => StorageLocation.Copy(dataDirectory, chooser.SelectedPath));
            using var destinationLock = new FileStream(Path.Combine(destination, ".desktop.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            StorageLocation.Save(StorageConfig, destination);
            MessageBox.Show(this, "Your files were copied and verified. Reopen Concept Graph to use the new folder. The original files remain in their previous location.", "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            if (server is { HasExited: false }) { closing = false; view.Visible = true; }
            MessageBox.Show(this, "Could not change the storage folder. Your original files remain in their previous location. " + (stopped ? "Reopen the app to continue.\n\n" : "\n\n") + error.Message, "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            quitRequestId = null;
            quitResponse = null;
            quitInProgress = false;
            if (closing)
            {
                DisposeServer();
                allowClose = true;
                Close();
            }
            else if (!IsDisposed) { view.Enabled = true; menu.Enabled = true; }
        }
    }

    private async Task PrepareToCloseAsync(FormClosingEventArgs args)
    {
        if (allowClose) return;
        args.Cancel = true;
        if (quitInProgress) return;
        quitInProgress = true;
        view.Enabled = false;
        try
        {
            if (view.CoreWebView2 is not null && server is { HasExited: false })
            {
                bool activeRuns = await PrepareWebAsync();
                if (activeRuns && MessageBox.Show(this, "An image is still generating. Closing will cancel it. Close Concept Graph?", "Generation in progress", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                    return;
            }
            closing = true;
            view.Visible = false;
            message.Text = "Saving and closing Concept Graph…";
            if (!await StopServerAsync())
            {
                message.Text = "The local server is still closing. Please wait, then close the app again.";
                closing = false;
                return;
            }
            allowClose = true;
            Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "Could not finish saving. Keep the app open and try again.\n\n" + error.Message, "Concept Graph", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            if (!closing && !IsDisposed) view.Enabled = true;
            quitRequestId = null;
            quitResponse = null;
            quitInProgress = false;
        }
    }

    private void ServerExited()
    {
        if (closing || IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(() => { if (!closing) { view.Visible = false; message.Text = "The local server stopped. Close and reopen Concept Graph."; } }); }
        catch (InvalidOperationException) { }
    }

    private async Task<bool> StopServerAsync(bool releaseLock = true, bool requireCleanExit = false)
    {
        if (server is { HasExited: false })
        {
            try
            {
                server.StandardInput.Close();
                await server.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            }
            catch (TimeoutException) { return false; }
            catch (InvalidOperationException) { }
        }
        if (requireCleanExit && (server is null || !server.HasExited || server.ExitCode != 0))
            throw new InvalidOperationException("The local server could not finish saving. Storage was not copied.");
        server?.Dispose();
        server = null;
        mcpLock?.Dispose();
        mcpLock = null;
        if (releaseLock) { dataLock?.Dispose(); dataLock = null; }
        return true;
    }

    private void DisposeServer()
    {
        server?.Dispose();
        dataLock?.Dispose();
        mcpLock?.Dispose();
        server = null;
        dataLock = null;
        mcpLock = null;
    }
}
