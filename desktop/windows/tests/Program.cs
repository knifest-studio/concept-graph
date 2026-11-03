using ConceptGraph.Windows;
using System.Formats.Tar;
using System.IO.Compression;

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

Check(DesktopProtocol.TryReadReadyPort("Concept Graph is ready at http://127.0.0.1:43170", out int port) && port == 43170, "expected local ready port");
foreach (string invalid in new[] {
    "Concept Graph is ready at http://example.com:43170",
    "Concept Graph is ready at http://127.0.0.1:0",
    "Concept Graph is ready at http://127.0.0.1:65536",
    "Concept Graph is ready at http://127.0.0.1:43170/other",
}) Check(!DesktopProtocol.TryReadReadyPort(invalid, out _), "invalid server origin accepted");

Check(DesktopProtocol.TryReadQuitResponse("{\"id\":\"test\",\"activeRuns\":true}", "test", out bool active, out _) && active, "active run was not reported");
Check(DesktopProtocol.TryReadQuitResponse("{\"id\":\"test\",\"error\":\"save failed\"}", "test", out _, out string? error) && error == "save failed", "save error was not reported");
foreach (string invalid in new[] { "{}", "not json", "{\"id\":\"other\",\"activeRuns\":true}", "{\"id\":\"test\",\"activeRuns\":\"true\"}" })
    Check(!DesktopProtocol.TryReadQuitResponse(invalid, "test", out _, out _), "invalid quit response accepted");
Check(!DesktopProtocol.TryReadQuitResponse("{\"id\":null,\"activeRuns\":false}", null, out _, out _), "unsolicited quit response accepted");
string screenshotId = "12345678-1234-4234-8234-123456789abc";
Check(DesktopProtocol.TryReadScreenshotRequest($"{{\"type\":\"mcp-screenshot\",\"id\":\"{screenshotId}\"}}", out string receivedScreenshot) && receivedScreenshot == screenshotId, "valid screenshot request rejected");
foreach (string invalid in new[] { "{}", "not json", "{\"type\":\"mcp-screenshot\",\"id\":\"bad\"}", $"{{\"type\":\"mcp-screenshot\",\"id\":\"{screenshotId}\",\"extra\":1}}" })
    Check(!DesktopProtocol.TryReadScreenshotRequest(invalid, out _), "invalid screenshot request accepted");
string root = Path.Combine(Path.GetTempPath(), "concept-storage-test-" + Guid.NewGuid().ToString("N"));
try
{
    string source = Path.Combine(root, "source"), parent = Path.Combine(root, "destination"), config = Path.Combine(root, "settings", "location.json");
    string explicitSession = Path.Combine(root, "isolated-session.json");
    Check(StorageLocation.McpSessionFile(null, null, config) == Path.Combine(root, "settings", "mcp-session.json"), "wrong default MCP session path");
    Check(StorageLocation.McpSessionFile(null, source, config) is null, "isolated data should not use real discovery");
    Check(StorageLocation.McpSessionFile(explicitSession, source, config) == explicitSession, "explicit MCP session path not used");
    using (var locked = StorageLocation.LockMcpSession(explicitSession))
    {
        Check(locked is not null, "could not take initial MCP lock");
        using var conflict = StorageLocation.LockMcpSession(explicitSession);
        Check(conflict is null, "MCP lock did not prevent a second owner");
    }
    using (var relocked = StorageLocation.LockMcpSession(explicitSession)) Check(relocked is not null, "MCP lock not released");
    Directory.CreateDirectory(Path.Combine(source, "assets", "nested"));
    Directory.CreateDirectory(parent);
    string cliDirectory = Path.Combine(root, "npm");
    string nativeFromNpm = Path.Combine(cliDirectory, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    var candidates = CodexInstallation.Candidates(cliDirectory, null, null, null).ToArray();
    Check(candidates.Contains(Path.Combine(cliDirectory, "codex.exe")) && candidates.Contains(nativeFromNpm), "npm native Codex path missing");
    Check(!CodexInstallation.Candidates("relative-path", null, null, null).Any(), "relative search path accepted");
    string tarPath = Path.Combine(root, "test.tar.gz"), extraction = Path.Combine(root, "extract");
    await using (var output = File.Create(tarPath))
    await using (var compressed = new GZipStream(output, CompressionMode.Compress))
    using (var writer = new TarWriter(compressed, leaveOpen: true))
    {
        writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "bin/codex.exe") { DataStream = new MemoryStream(new byte[] { 1, 2, 3 }) });
    }
    Directory.CreateDirectory(extraction);
    await CodexInstallation.ExtractAsync(tarPath, extraction, CancellationToken.None);
    Check(File.ReadAllBytes(Path.Combine(extraction, "bin", "codex.exe")).SequenceEqual(new byte[] { 1, 2, 3 }), "Codex package extraction failed");
    string maliciousPath = Path.Combine(root, "malicious.tar.gz"), maliciousExtraction = Path.Combine(root, "malicious-extract");
    await using (var output = File.Create(maliciousPath))
    await using (var compressed = new GZipStream(output, CompressionMode.Compress))
    using (var writer = new TarWriter(compressed, leaveOpen: true))
    {
        writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "../escape") { DataStream = new MemoryStream(new byte[] { 1 }) });
    }
    Directory.CreateDirectory(maliciousExtraction);
    try { await CodexInstallation.ExtractAsync(maliciousPath, maliciousExtraction, CancellationToken.None); throw new Exception("path traversal accepted"); }
    catch (InvalidDataException) { }
    Check(!File.Exists(Path.Combine(root, "escape")), "archive escaped destination");
    string symlinkPath = Path.Combine(root, "link.tar.gz"), symlinkExtraction = Path.Combine(root, "link-extract");
    await using (var output = File.Create(symlinkPath))
    await using (var compressed = new GZipStream(output, CompressionMode.Compress))
    using (var writer = new TarWriter(compressed, leaveOpen: true))
    {
        writer.WriteEntry(new PaxTarEntry(TarEntryType.SymbolicLink, "escape-link") { LinkName = "../escape" });
    }
    Directory.CreateDirectory(symlinkExtraction);
    try { await CodexInstallation.ExtractAsync(symlinkPath, symlinkExtraction, CancellationToken.None); throw new Exception("symbolic link accepted"); }
    catch (InvalidDataException) { }
    if (Environment.GetEnvironmentVariable("CONCEPT_GRAPH_TEST_CODEX_ARCHIVE") is string officialArchive && File.Exists(officialArchive))
    {
        string officialExtraction = Path.Combine(root, "official-package"); Directory.CreateDirectory(officialExtraction);
        await CodexInstallation.ExtractAsync(officialArchive, officialExtraction, CancellationToken.None);
        Check(File.Exists(Path.Combine(officialExtraction, "bin", "codex.exe")) && File.Exists(Path.Combine(officialExtraction, "codex-resources", "codex-windows-sandbox-setup.exe")), "official Windows Codex package is incomplete");
    }
    File.WriteAllText(Path.Combine(source, "workspace.json"), "synthetic boards");
    File.WriteAllBytes(Path.Combine(source, "assets", "nested", "image.png"), new byte[] { 1, 2, 3 });
    File.WriteAllText(Path.Combine(source, ".desktop.lock"), "lock");
    string dest = StorageLocation.Copy(source, parent);
    Check(File.ReadAllText(Path.Combine(dest, "workspace.json")) == "synthetic boards", "workspace was not copied");
    Check(File.ReadAllBytes(Path.Combine(dest, "assets", "nested", "image.png")).SequenceEqual(new byte[] { 1, 2, 3 }), "nested image was not copied");
    Check(!File.Exists(Path.Combine(dest, ".desktop.lock")), "copied lock file");
    Check(File.Exists(Path.Combine(source, "workspace.json")), "source was deleted");
    try { StorageLocation.Copy(source, parent); throw new Exception("existing destination accepted"); } catch (InvalidOperationException) { }
    try { StorageLocation.Destination(source, source); throw new Exception("nested destination accepted"); } catch (InvalidOperationException) { }
    string link = Path.Combine(root, "linked-source");
    Directory.CreateSymbolicLink(link, source);
    try { StorageLocation.Destination(source, link); throw new Exception("linked destination accepted"); } catch (InvalidOperationException) { }
    Directory.Delete(link);
    StorageLocation.Save(config, dest);
    Check(StorageLocation.Resolve(null, config, source) == dest, "configured location not used");
    Check(StorageLocation.Resolve(source, config, dest) == source, "environment override not used");
    Directory.Move(dest, dest + "-offline");
    try { StorageLocation.Resolve(null, config, source); throw new Exception("offline storage accepted"); } catch (InvalidOperationException) { }
    string badSource = Path.Combine(root, "broken");
    Directory.CreateDirectory(badSource);
    string other = Path.Combine(root, "other"); Directory.CreateDirectory(other);
    try { StorageLocation.Copy(badSource, other); throw new Exception("missing workspace accepted"); } catch (InvalidOperationException) { }
    Check(!Directory.EnumerateFileSystemEntries(other).Any(), "failed copy left a destination");
}
finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
Console.WriteLine("Windows desktop protocol checks passed.");
