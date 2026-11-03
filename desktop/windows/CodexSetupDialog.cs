namespace ConceptGraph.Windows;

internal sealed class CodexSetupDialog : Form
{
    private readonly Label status = new() { AutoSize = false, Left = 20, Top = 18, Width = 420, Height = 35, Text = "Downloading Codex from OpenAI…" };
    private readonly ProgressBar progress = new() { Left = 20, Top = 58, Width = 420, Height = 20, Minimum = 0, Maximum = 100 };
    private readonly Button cancel = new() { Text = "Cancel", Left = 350, Top = 92, Width = 90, Height = 30 };
    private readonly CancellationTokenSource cancellation = new();
    private readonly string localAppData;
    private bool finished;
    internal string? ErrorMessage { get; private set; }

    internal CodexSetupDialog(string localAppData)
    {
        this.localAppData = localAppData;
        Text = "Set up Codex";
        ClientSize = new Size(460, 140);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false; StartPosition = FormStartPosition.CenterParent;
        Controls.AddRange([status, progress, cancel]);
        cancel.Click += (_, _) => { cancel.Enabled = false; status.Text = "Cancelling…"; cancellation.Cancel(); };
        FormClosing += (_, args) => { if (!finished) { args.Cancel = true; cancellation.Cancel(); cancel.Enabled = false; status.Text = "Cancelling…"; } };
        Shown += async (_, _) => await StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var update = new Progress<long>(bytes => {
                if (bytes < 0) { status.Text = "Verifying and installing Codex…"; progress.Style = ProgressBarStyle.Marquee; }
                else { progress.Value = (int)Math.Min(100, bytes * 100 / CodexInstallation.ArchiveSize); status.Text = $"Downloading Codex… {bytes / 1048576} / {CodexInstallation.ArchiveSize / 1048576} MiB"; }
            });
            await CodexInstallation.InstallAsync(localAppData, update, cancellation.Token);
            finished = true; DialogResult = DialogResult.OK; Close();
        }
        catch (OperationCanceledException) { finished = true; DialogResult = DialogResult.Cancel; Close(); }
        catch (Exception error) { ErrorMessage = error.Message; finished = true; DialogResult = DialogResult.Abort; Close(); }
        finally { cancellation.Dispose(); }
    }
}
