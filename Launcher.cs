using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main()
    {
        // "\u6781\u7B80\u9605\u8BFB\u5668" = Chinese app name
        string appName = new string(new char[] { '\u6781', '\u7B80', '\u9605', '\u8BFB', '\u5668' });
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;

        string primary = Environment.Is64BitOperatingSystem ? "win-x64" : "win-ia32";
        string fallback = Environment.Is64BitOperatingSystem ? "win-ia32" : "win-x64";

        string target = Path.Combine(baseDir, primary, appName + ".exe");
        if (!File.Exists(target))
            target = Path.Combine(baseDir, fallback, appName + ".exe");

        if (!File.Exists(target))
        {
            MessageBox.Show(
                "Cannot find " + appName + ".exe under win-x64 or win-ia32.\n\n" +
                "\u627E\u4E0D\u5230\u4E3B\u7A0B\u5E8F\uFF0C\u8BF7\u4FDD\u6301 win-x64 / win-ia32 \u76EE\u5F55\u5B8C\u6574\u3002",
                appName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                WorkingDirectory = Path.GetDirectoryName(target),
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("Failed to start: " + ex.Message, appName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
