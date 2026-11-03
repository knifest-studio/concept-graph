using System.Text.Json;
using System.Text.RegularExpressions;

namespace ConceptGraph.Windows;

internal static class DesktopProtocol
{
    public static bool TryReadScreenshotRequest(string json, out string id)
    {
        id = "";
        try
        {
            using var document = JsonDocument.Parse(json);
            var message = document.RootElement;
            if (message.ValueKind != JsonValueKind.Object || message.EnumerateObject().Count() != 2
                || !message.TryGetProperty("type", out var type) || type.GetString() != "mcp-screenshot"
                || !message.TryGetProperty("id", out var value) || value.ValueKind != JsonValueKind.String
                || !Guid.TryParseExact(value.GetString(), "D", out _)) return false;
            id = value.GetString()!;
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
    }
    public static bool TryReadReadyPort(string line, out int port)
    {
        Match match = Regex.Match(line, @"^Concept Graph is ready at http://127\.0\.0\.1:(\d+)$");
        port = 0;
        return match.Success && int.TryParse(match.Groups[1].Value, out port) && port is > 0 and <= 65535;
    }

    public static bool TryReadQuitResponse(string json, string? expectedId, out bool activeRuns, out string? error)
    {
        activeRuns = false;
        error = null;
        if (expectedId is null) return false;
        try
        {
            using var document = JsonDocument.Parse(json);
            var message = document.RootElement;
            if (message.GetProperty("id").GetString() != expectedId) return false;
            if (message.TryGetProperty("error", out var errorValue))
            {
                error = errorValue.GetString() ?? "Could not save the board.";
                return true;
            }
            activeRuns = message.GetProperty("activeRuns").GetBoolean();
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (KeyNotFoundException) { return false; }
    }
}
