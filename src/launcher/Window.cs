using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Breeze
{
    /// <summary>主窗口：用系统自带的 WebView2 运行时承载界面，外观就是普通软件窗口。</summary>
    class MainWindow : Form
    {
        readonly string url;
        readonly string[] dataDirs;
        readonly Action<string> onFail;
        readonly Action<string> log;
        WebView2 view;
        bool failed;

        public MainWindow(string url, string[] dataDirs, Action<string> onFail, Action<string> log)
        {
            this.url = url;
            this.dataDirs = dataDirs;
            this.onFail = onFail;
            this.log = log;

            Text = "Breeze TTS 2";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1220, 840);
            MinimumSize = new Size(920, 640);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            view = new WebView2();
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = Color.White;
            Controls.Add(view);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Boot();
        }

        async void Boot()
        {
            string lastError = "";
            for (int sandbox = 0; sandbox < 2; sandbox++)
            {
                foreach (string dir in dataDirs)
                {
                    if (string.IsNullOrEmpty(dir)) continue;
                    try
                    {
                        Directory.CreateDirectory(dir);
                        var opts = new CoreWebView2EnvironmentOptions();
                        if (sandbox == 1) opts.AdditionalBrowserArguments = "--no-sandbox";
                        var env = await CoreWebView2Environment.CreateAsync(null, dir, opts);
                        await view.EnsureCoreWebView2Async(env);

                        var s = view.CoreWebView2.Settings;
                        s.AreDevToolsEnabled = false;
                        s.IsStatusBarEnabled = false;
                        s.IsSwipeNavigationEnabled = false;

                        view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs ev)
                        {
                            ev.Handled = true;
                            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(ev.Uri) { UseShellExecute = true }); }
                            catch { }
                        };

                        view.CoreWebView2.Navigate(url);
                        log("webview ok: " + dir + (sandbox == 1 ? " (no-sandbox)" : ""));
                        return;
                    }
                    catch (Exception ex)
                    {
                        lastError = ex.Message;
                        log("webview fail [" + dir + (sandbox == 1 ? " no-sandbox" : "") + "]: " + ex.Message);
                    }
                }
            }

            if (failed) return;
            failed = true;
            try { onFail(lastError); } catch { }
            Close();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            if (!failed) Application.Exit();
        }
    }
}
