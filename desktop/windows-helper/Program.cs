using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace ConceptGraph.Helper
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                var identity = "ConceptGraph.Helper." + WindowsIdentity.GetCurrent().User.Value;
                uint activate = Native.RegisterWindowMessage(identity + ".Activate");
                if (activate == 0) throw new Win32Exception();
                // Create the window before claiming the mutex so a second launch can always notify it.
                using (var window = new HelperWindow(activate))
                {
                    var handle = window.Handle;
                    bool created;
                    using (var mutex = new Mutex(true, @"Local\" + identity, out created))
                    {
                        if (!created)
                        {
                            if (!Native.PostMessage(new IntPtr(0xffff), activate, IntPtr.Zero, IntPtr.Zero))
                                throw new Win32Exception();
                            return;
                        }
                        try { Application.Run(window); }
                        finally { mutex.ReleaseMutex(); }
                    }
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Concept Graph Helper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    sealed class HelperWindow : Form
    {
        readonly uint activateMessage;
        readonly TextBox code = new TextBox { ReadOnly = true, Text = "Waiting for pairing code…", Font = new Font("Consolas", 10), AccessibleName = "Pairing code" };
        readonly Button copy = new Button { Text = "Copy code", AutoSize = true, Enabled = false };
        readonly Button open = new Button { Text = "Open board site", AutoSize = true, Enabled = false };
        readonly Label status = new Label { Text = "Starting…", AutoSize = true };
        Process child;
        SafeFileHandle job;
        string errors = "", pairingCode = "";
        Uri site;
        bool stopping, canClose;

        public HelperWindow(uint activateMessage)
        {
            this.activateMessage = activateMessage;
            Text = "Concept Graph Helper";
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 10);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            // The window sizes itself to its content: fonts follow the display scale, so the layout does too.
            AutoScaleMode = AutoScaleMode.None;
            AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink; MaximizeBox = false;
            Func<int, int> px = value => (int)Math.Round(value * DeviceDpi / 96.0);
            code.Width = TextRenderer.MeasureText(new string('0', 64), code.Font).Width + px(16);
            var width = new Size(code.Width, 0);
            status.MaximumSize = width;
            var layout = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(px(24)), ColumnCount = 1 };
            layout.Controls.Add(new Label { Text = Text, Font = new Font(Font.FontFamily, 18, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 0, 0, px(8)) });
            layout.Controls.Add(new Label { Text = "Paste this pairing code into the board site. Keep this window open.", AutoSize = true, MaximumSize = width, Margin = new Padding(0, 0, 0, px(10)) });
            layout.Controls.Add(code);
            var buttons = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(0, px(8), 0, px(8)) };
            buttons.Controls.Add(copy); buttons.Controls.Add(open);
            layout.Controls.Add(buttons); layout.Controls.Add(status);
            Controls.Add(layout);
            copy.Click += (sender, args) =>
            {
                try { if (copy.Enabled) Clipboard.SetText(pairingCode); }
                catch (ExternalException) { MessageBox.Show(this, "The clipboard is busy. Try again.", Text); }
            };
            open.Click += (sender, args) =>
            {
                try { Process.Start(new ProcessStartInfo(site.AbsoluteUri) { UseShellExecute = true }); }
                catch (Exception error) { MessageBox.Show(this, "Could not open your browser: " + error.Message, Text); }
            };
            Shown += (sender, args) => StartHelper();
            FormClosing += CloseHelper;
        }

        void StartHelper()
        {
            try
            {
                string directory = AppDomain.CurrentDomain.BaseDirectory;
                var origins = File.ReadAllText(Path.Combine(directory, "helper-site.txt")).Trim().Split(',').Select(value =>
                {
                    string origin = value.Trim();
                    Uri url;
                    if (!Regex.IsMatch(origin, @"\Ahttps://[^/?#\s\\]+/?\z", RegexOptions.IgnoreCase) ||
                        !Uri.TryCreate(origin, UriKind.Absolute, out url) || url.Scheme != "https" ||
                        url.Host.Length == 0 || url.UserInfo.Length != 0)
                        throw new InvalidOperationException("The app has no valid HTTPS board site. Rebuild with CONCEPT_GRAPH_HELPER_SITE.");
                    return url.GetLeftPart(UriPartial.Authority);
                }).ToArray();
                site = new Uri(origins[0]); open.Enabled = true;
                string runtime = Path.Combine(directory, "runtime");
                var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"))
                {
                    Arguments = "\"" + Path.Combine(directory, "helper.mjs") + "\"",
                    WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                start.EnvironmentVariables["CONCEPT_GRAPH_SITE"] = string.Join(",", origins);
                start.EnvironmentVariables["CONCEPT_GRAPH_EXIT_WITH_PARENT"] = "1";
                start.EnvironmentVariables["PORT"] = "43170";
                start.EnvironmentVariables["PATH"] = runtime + ";" + start.EnvironmentVariables["PATH"];
                job = Native.CreateKillJob();
                child = Process.Start(start);
                if (!Native.AssignProcessToJobObject(job, child.Handle))
                {
                    var error = new Win32Exception();
                    child.Kill(); child.WaitForExit();
                    throw new InvalidOperationException("Could not contain the helper process: " + error.Message);
                }
                ObserveHelper();
            }
            catch (Exception error) { job?.Dispose(); ShowStopped(error.Message); }
        }

        async void ObserveHelper()
        {
            try
            {
                Task output = ReadOutput(), error = ReadErrors();
                await Task.Run(() => child.WaitForExit());
                job.Dispose();
                await Task.WhenAll(output, error);
                if (!stopping) ShowStopped("The helper exited (status " + child.ExitCode + ").");
            }
            catch (Exception error) { job.Dispose(); if (!stopping) ShowStopped(error.Message); }
        }

        async Task ReadOutput()
        {
            string line;
            while ((line = await child.StandardOutput.ReadLineAsync()) != null)
            {
                if (stopping) continue;
                var match = Regex.Match(line, @"\AConcept Graph connection code: ([a-f0-9]{64})\z");
                if (match.Success) { pairingCode = match.Groups[1].Value; code.Text = pairingCode; }
                if (line == "Concept Graph is ready at http://127.0.0.1:43170")
                {
                    copy.Enabled = pairingCode.Length == 64;
                    status.Text = "Ready — paste the code into the board site.";
                }
            }
        }

        async Task ReadErrors()
        {
            var buffer = new char[2048];
            int count;
            while ((count = await child.StandardError.ReadAsync(buffer, 0, buffer.Length)) != 0)
            {
                errors += new string(buffer, 0, count);
                if (errors.Length > 8000) errors = errors.Substring(errors.Length - 8000);
            }
        }

        void ShowStopped(string message)
        {
            copy.Enabled = false; pairingCode = ""; code.Text = "Helper stopped";
            if (errors.Contains("EADDRINUSE")) message = "Port 43170 is already in use. Quit the other helper, then reopen this app.";
            var lines = errors.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            status.Text = "Stopped — " + message + (lines.Length == 0 ? "" : "\n" + string.Join("\n", lines.Skip(Math.Max(0, lines.Length - 6))));
        }

        async void CloseHelper(object sender, FormClosingEventArgs args)
        {
            if (canClose) return;
            args.Cancel = true;
            if (stopping) return;
            stopping = true; copy.Enabled = false; open.Enabled = false; status.Text = "Stopping…";
            await Task.Yield();
            try
            {
                if (child != null && !child.HasExited)
                {
                    child.StandardInput.Close();
                    await Task.Run(() => child.WaitForExit(1800));
                }
            }
            catch (InvalidOperationException) { }
            catch (IOException) { }
            finally { job?.Dispose(); canClose = true; Close(); }
        }

        protected override void WndProc(ref Message message)
        {
            if ((uint)message.Msg == activateMessage)
            {
                Show(); Native.ShowWindow(Handle, 9);
                if (!Native.SetForegroundWindow(Handle)) Native.FlashWindow(Handle, true);
            }
            base.WndProc(ref message);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { job?.Dispose(); child?.Dispose(); }
            base.Dispose(disposing);
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        public static SafeFileHandle CreateKillJob()
        {
            // Null security attributes make this handle non-inheritable.
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid) { var error = new Win32Exception(); job.Dispose(); throw error; }
            var limits = new ExtendedLimits { BasicLimitInformation = new BasicLimits { LimitFlags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            {
                var error = new Win32Exception(); job.Dispose(); throw error;
            }
            return job;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")]
        public static extern bool FlashWindow(IntPtr window, bool invert);
    }
}
