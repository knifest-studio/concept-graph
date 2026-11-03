using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Security.Cryptography;

namespace ConceptGraph.Windows;

internal static class CodexInstallation
{
    internal const string Version = "0.163.0";
    internal const long ArchiveSize = 162230206;
    private const string ArchiveSha256 = "901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522";
    private const string ArchiveUrl = "https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-package-x86_64-pc-windows-msvc.tar.gz";
    private static readonly string[] RedirectHosts = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
    internal static string DirectoryFor(string localAppData) => Path.Combine(localAppData, "Concept Graph", "codex");
    internal static string ManagedPath(string localAppData) => Path.Combine(DirectoryFor(localAppData), "0.163.0-win-x64", "bin", "codex.exe");
    internal static string PreferencePath(string localAppData) => Path.Combine(DirectoryFor(localAppData), "prefer-managed");

    // Return native executables, including the native binary behind an npm shim; never run cmd scripts.
    internal static IEnumerable<string> Candidates(string? path, string? appData, string? localAppData, string? userProfile)
    {
        var directories = new List<string>();
        if (!string.IsNullOrWhiteSpace(path)) directories.AddRange(path.Split(Path.PathSeparator));
        if (!string.IsNullOrWhiteSpace(appData)) directories.Add(Path.Combine(appData, "npm"));
        if (!string.IsNullOrWhiteSpace(userProfile)) directories.Add(Path.Combine(userProfile, ".local", "bin"));
        if (!string.IsNullOrWhiteSpace(localAppData)) directories.Add(Path.Combine(localAppData, "Programs", "OpenAI", "Codex", "bin"));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string raw in directories)
        {
            string dir = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
            if (!Path.IsPathFullyQualified(dir) || !seen.Add(dir)) continue;
            yield return Path.Combine(dir, "codex.exe");
            string modules = Path.Combine(dir, "node_modules", "@openai");
            foreach (string root in new[] {
                Path.Combine(modules, "codex", "node_modules", "@openai", "codex-win32-x64"),
                Path.Combine(modules, "codex-win32-x64"),
                Path.Combine(modules, "codex")
            }) foreach (string folder in new[] { "bin", "codex" })
                yield return Path.Combine(root, "vendor", "x86_64-pc-windows-msvc", folder, "codex.exe");
        }
    }

    internal static async Task<bool> IsCodexAsync(string candidate)
    {
        if (!File.Exists(candidate)) return false;
        try
        {
            var start = new ProcessStartInfo(candidate) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("--version");
            using var process = Process.Start(start);
            if (process is null) return false;
            Task<string> stdout = process.StandardOutput.ReadToEndAsync(), stderr = process.StandardError.ReadToEndAsync();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TimeoutException) { try { process.Kill(entireProcessTree: true); } catch { } return false; }
            string version = (await stdout) + (await stderr);
            return process.ExitCode == 0 && version.Contains("codex", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException) { return false; }
    }

    internal static async Task<string?> FindAsync(string localAppData)
    {
        string? explicitPath = Environment.GetEnvironmentVariable("CODEX_BIN");
        if (!string.IsNullOrWhiteSpace(explicitPath)) return explicitPath;
        string managed = ManagedPath(localAppData);
        if (File.Exists(PreferencePath(localAppData)) && await IsCodexAsync(managed)) return managed;
        string path = string.Join(Path.PathSeparator,
            Environment.GetEnvironmentVariable("PATH") ?? "",
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "",
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "");
        foreach (string candidate in Candidates(path, Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), localAppData, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)))
            if (await IsCodexAsync(candidate)) return candidate;
        return await IsCodexAsync(managed) ? managed : null;
    }

    internal static async Task<string> InstallAsync(string localAppData, IProgress<long>? progress, CancellationToken cancellation)
    {
        string root = DirectoryFor(localAppData), destination = Path.GetDirectoryName(Path.GetDirectoryName(ManagedPath(localAppData))!)!;
        if (await IsCodexAsync(ManagedPath(localAppData))) return ManagedPath(localAppData);
        Directory.CreateDirectory(root);
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("The Codex setup folder must not be a symbolic link.");
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("The existing Concept Graph Codex folder is incomplete. Move it aside and retry setup.");
        string temporary = Path.Combine(root, ".install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        try
        {
            string archive = Path.Combine(temporary, "codex.tar.gz"), extracted = Path.Combine(temporary, "package");
            using var handler = new HttpClientHandler { AllowAutoRedirect = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(20) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("ConceptGraph/1.0");
            Uri url = new(ArchiveUrl);
            HttpResponseMessage? response = null;
            try
            {
                for (int redirect = 0; redirect < 6; redirect++)
                {
                    if (url.Scheme != Uri.UriSchemeHttps || !RedirectHosts.Contains(url.Host, StringComparer.OrdinalIgnoreCase) || !url.IsDefaultPort || !string.IsNullOrEmpty(url.UserInfo)) throw new InvalidOperationException("Codex download redirected to an untrusted address.");
                    response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
                    if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is Uri location)
                    { url = location.IsAbsoluteUri ? location : new Uri(url, location); response.Dispose(); response = null; continue; }
                    break;
                }
                if (response is null) throw new InvalidOperationException("Too many Codex download redirects.");
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength is long length && length != ArchiveSize) throw new InvalidDataException("Codex download has an unexpected size.");
                await using Stream input = await response.Content.ReadAsStreamAsync(cancellation);
                await using var output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                byte[] bytes = new byte[1024 * 1024]; long total = 0;
                while (true)
                {
                    int count = await input.ReadAsync(bytes, cancellation); if (count == 0) break;
                    total += count; if (total > ArchiveSize) throw new InvalidDataException("Codex download is too large.");
                    hash.AppendData(bytes, 0, count); await output.WriteAsync(bytes.AsMemory(0, count), cancellation); progress?.Report(total);
                }
                if (total != ArchiveSize || !Convert.ToHexString(hash.GetHashAndReset()).Equals(ArchiveSha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Codex download failed its integrity check.");
            }
            finally { response?.Dispose(); }
            cancellation.ThrowIfCancellationRequested();
            progress?.Report(-1);
            Directory.CreateDirectory(extracted);
            await ExtractAsync(archive, extracted, cancellation);
            string executable = Path.Combine(extracted, "bin", "codex.exe");
            if (!File.Exists(executable)) throw new InvalidDataException("Codex package is incomplete.");
            cancellation.ThrowIfCancellationRequested();
            Directory.Move(extracted, destination);
            return ManagedPath(localAppData);
        }
        finally { try { Directory.Delete(temporary, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }

    internal static async Task ExtractAsync(string archive, string destination, CancellationToken cancellation)
    {
        await using var file = File.OpenRead(archive);
        await using var gzip = new GZipStream(file, CompressionMode.Decompress);
        using var reader = new TarReader(gzip);
        string root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        long total = 0; int entries = 0; TarEntry? entry;
        while ((entry = await reader.GetNextEntryAsync(copyData: false, cancellationToken: cancellation)) is not null)
        {
            if (++entries > 1000 || entry.Length > 512L * 1024 * 1024 || (total += entry.Length) > 1024L * 1024 * 1024) throw new InvalidDataException("Codex package is too large.");
            string name = entry.Name.Replace('\\', '/');
            string[] segments = name.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (name.StartsWith('/') || segments.Length == 0 || segments.Any(s => s == ".." || s.Contains(':'))) throw new InvalidDataException("Unsafe path in Codex package.");
            string output = Path.GetFullPath(Path.Combine(destination, Path.Combine(segments)));
            if (!output.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsafe path in Codex package.");
            if (entry.EntryType == TarEntryType.Directory) { Directory.CreateDirectory(output); continue; }
            if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) || entry.DataStream is null) throw new InvalidDataException("Unsupported entry in Codex package.");
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            await using var target = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
            await entry.DataStream.CopyToAsync(target, cancellation);
        }
    }
}
