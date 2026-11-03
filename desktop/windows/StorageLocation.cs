using System.Security.Cryptography;
using System.Text.Json;

namespace ConceptGraph.Windows;

internal static class StorageLocation
{
    public const string FolderName = "Concept Graph Data";

    public static string? McpSessionFile(string? explicitPath, string? dataOverride, string config)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath)) return explicitPath;
        if (!string.IsNullOrWhiteSpace(dataOverride)) return null;
        return Path.Combine(Path.GetDirectoryName(config)!, "mcp-session.json");
    }

    public static FileStream? LockMcpSession(string session)
    {
        try
        {
            if (!Path.IsPathFullyQualified(session)) return null;
            Directory.CreateDirectory(Path.GetDirectoryName(session)!);
            return new FileStream(session + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    public static string Resolve(string? environment, string config, string defaultDirectory)
    {
        if (!string.IsNullOrWhiteSpace(environment)) return Path.GetFullPath(environment);
        if (!File.Exists(config)) return defaultDirectory;
        string? location = JsonSerializer.Deserialize<string>(File.ReadAllText(config));
        if (string.IsNullOrWhiteSpace(location) || !Path.IsPathFullyQualified(location)
            || !Directory.Exists(location) || !File.Exists(Path.Combine(location, "workspace.json")))
            throw new InvalidOperationException("The selected storage folder is unavailable. Reconnect the drive or restore the folder and reopen Concept Graph.");
        return Path.GetFullPath(location);
    }

    public static string Destination(string source, string parent)
    {
        string destination = Path.GetFullPath(Path.Combine(parent, FolderName));
        source = Path.TrimEndingDirectorySeparator(Path.GetFullPath(source));
        string target = Path.TrimEndingDirectorySeparator(destination);
        RejectLinkedAncestors(source);
        RejectLinkedAncestors(Path.GetFullPath(parent));
        string sourcePrefix = source + Path.DirectorySeparatorChar, targetPrefix = target + Path.DirectorySeparatorChar;
        if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase)
            || target.StartsWith(sourcePrefix, StringComparison.OrdinalIgnoreCase)
            || source.StartsWith(targetPrefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Choose a folder outside your current storage folder.");
        if (Directory.Exists(target) || File.Exists(target))
            throw new InvalidOperationException("Concept Graph Data already exists in this location. Choose another folder.");
        if (!Directory.Exists(parent)) throw new InvalidOperationException("The selected folder is unavailable.");
        return target;
    }

    private static void RejectLinkedAncestors(string path)
    {
        for (DirectoryInfo? entry = new(path); entry is not null; entry = entry.Parent)
            if (entry.Exists && (entry.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Choose a location without shortcuts or symbolic links.");
    }

    public static string Copy(string source, string parent)
    {
        string destination = Destination(source, parent);
        string staging = Path.Combine(parent, ".concept-graph-copy-" + Guid.NewGuid().ToString("N"));
        var before = Inventory(source);
        Directory.CreateDirectory(staging);
        try
        {
            CopyDirectory(source, staging, true);
            if (!File.Exists(Path.Combine(staging, "workspace.json"))) throw new InvalidOperationException("The saved boards could not be found.");
            if (!Same(before, Inventory(source)) || !Same(before, Inventory(staging)))
                throw new IOException("Storage changed while it was being copied, or a copied file failed verification.");
            // Move into place only after the complete copy has been verified.
            Directory.Move(staging, destination);
            return destination;
        }
        finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
    }

    private static Dictionary<string, string> Inventory(string directory)
    {
        var items = new Dictionary<string, string>(StringComparer.Ordinal);
        void Scan(string current)
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(current))
            {
                string relative = Path.GetRelativePath(directory, entry);
                if (relative == ".desktop.lock") continue;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Storage contains a shortcut or symbolic link and cannot be copied safely.");
                if ((attributes & FileAttributes.Directory) != 0) { items.Add(relative, "directory"); Scan(entry); }
                else { using var file = File.OpenRead(entry); items.Add(relative, Convert.ToHexString(SHA256.HashData(file))); }
            }
        }
        Scan(directory);
        return items;
    }

    private static bool Same(Dictionary<string, string> left, Dictionary<string, string> right) =>
        left.Count == right.Count && left.All(item => right.TryGetValue(item.Key, out string? value) && value == item.Value);

    private static void CopyDirectory(string source, string destination, bool root = false)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(source))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Storage contains a shortcut or symbolic link and cannot be copied safely.");
            string name = Path.GetFileName(entry);
            if (root && name == ".desktop.lock") continue;
            string target = Path.Combine(destination, name);
            if ((attributes & FileAttributes.Directory) != 0)
            {
                Directory.CreateDirectory(target);
                CopyDirectory(entry, target);
            }
            else
            {
                File.Copy(entry, target, false);
                using var original = File.OpenRead(entry);
                using var copied = File.OpenRead(target);
                if (!SHA256.HashData(original).AsSpan().SequenceEqual(SHA256.HashData(copied)))
                    throw new IOException("A copied file failed verification.");
            }
        }
    }

    public static void Save(string config, string location)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(config)!);
        string temporary = config + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, location);
                file.Flush(true);
            }
            File.Move(temporary, config, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
