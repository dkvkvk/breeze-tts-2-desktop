using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BreezeSetup
{
    class SetupForm : Form
    {
        const string MAGIC = "BREEZESF";
        const int TRAILER = 24;

        Label title, sub, note;
        Panel barBg, bar;
        Button close;
        string target;
        bool done, failed;
        public static string OverrideTarget;

        public SetupForm()
        {
            Text = "Breeze TTS 2 安装程序";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 240);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9f);

            title = new Label();
            title.Text = "B R E E Z E   T T S   2";
            title.Font = new Font("Segoe UI", 12f);
            title.ForeColor = Color.Black;
            title.SetBounds(40, 40, 440, 26);
            Controls.Add(title);

            sub = new Label();
            sub.Text = "正在解压程序文件";
            sub.ForeColor = Color.FromArgb(120, 120, 120);
            sub.SetBounds(40, 74, 440, 20);
            Controls.Add(sub);

            barBg = new Panel();
            barBg.BackColor = Color.FromArgb(228, 228, 228);
            barBg.SetBounds(40, 110, 440, 2);
            Controls.Add(barBg);

            bar = new Panel();
            bar.BackColor = Color.Black;
            bar.SetBounds(0, 0, 0, 2);
            barBg.Controls.Add(bar);

            note = new Label();
            note.ForeColor = Color.FromArgb(150, 150, 150);
            note.SetBounds(40, 128, 440, 40);
            note.Text = "";
            Controls.Add(note);

            close = new Button();
            close.Text = "完成";
            close.Enabled = false;
            close.SetBounds(400, 186, 80, 28);
            close.FlatStyle = FlatStyle.Flat;
            close.FlatAppearance.BorderColor = Color.FromArgb(180, 180, 180);
            close.BackColor = Color.White;
            close.Click += delegate
            {
                if (failed) { Close(); return; }
                try { Process.Start(Path.Combine(target, "BreezeTTS2.exe")); } catch { }
                Close();
            };
            Controls.Add(close);

            MouseDown += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { Native.ReleaseCapture(); Native.SendMessage(Handle, 0xA1, 0x2, 0); } };

            Load += delegate { ThreadPool.QueueUserWorkItem(delegate { Install(); }); };
        }

        void SetBar(int pct)
        {
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    int w = (int)(barBg.Width * (pct / 100.0));
                    bar.Width = Math.Max(0, Math.Min(barBg.Width, w));
                });
            }
            catch { }
        }

        void Finish(bool ok, string message)
        {
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    failed = !ok;
                    done = true;
                    sub.Text = ok ? "安装完成" : "安装失败";
                    note.Text = message;
                    close.Enabled = true;
                    close.Text = ok ? "启动程序" : "关闭";
                    if (ok) bar.Width = barBg.Width;
                });
            }
            catch { }
        }

        static void Log(string s)
        {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "breeze-setup.log"), DateTime.Now.ToString("HH:mm:ss") + "  " + s + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        void Install()
        {
            try
            {
                Log("install start, self=" + Assembly.GetExecutingAssembly().Location);
                string self = Assembly.GetExecutingAssembly().Location;
                long off, size;
                if (!ReadTrailer(self, out off, out size)) { Finish(false, "安装包已损坏（找不到数据段）"); return; }
                Log("payload offset=" + off + " size=" + size);
                SetBar(8);

                target = !string.IsNullOrEmpty(SetupForm.OverrideTarget)
                    ? SetupForm.OverrideTarget
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BreezeTTS2");
                Directory.CreateDirectory(target);

                using (var host = File.OpenRead(self))
                using (var zip = new ZipArchive(new SliceStream(host, off, size), ZipArchiveMode.Read))
                {
                    int total = zip.Entries.Count, i = 0;
                    foreach (var e in zip.Entries)
                    {
                        string dest = Path.Combine(target, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                        if (string.IsNullOrEmpty(e.Name))
                        {
                            Directory.CreateDirectory(dest);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            try { if (File.Exists(dest)) File.Delete(dest); } catch { }
                            e.ExtractToFile(dest, true);
                        }
                        i++;
                        if (i % 3 == 0) SetBar(18 + (int)(70.0 * i / Math.Max(1, total)));
                    }
                }
                Log("extracted to " + target);
                SetBar(90);

                MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Breeze TTS 2"),
                             "Breeze TTS 2", Path.Combine(target, "BreezeTTS2.exe"));
                MakeShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                             "Breeze TTS 2", Path.Combine(target, "BreezeTTS2.exe"));
                WriteRegistry();

                SetBar(100);
                Finish(true, "已安装到 " + target + Environment.NewLine +
                             "首次启动需要下载 2.4 GB 模型文件。");
            }
            catch (Exception ex)
            {
                Log("FAIL " + ex.ToString());
                Finish(false, ex.Message);
            }
        }

        static bool ReadTrailer(string self, out long off, out long size)
        {
            off = 0; size = 0;
            using (var fs = File.OpenRead(self))
            {
                if (fs.Length < TRAILER) return false;
                var buf = new byte[TRAILER];
                fs.Seek(fs.Length - TRAILER, SeekOrigin.Begin);
                if (fs.Read(buf, 0, TRAILER) != TRAILER) return false;
                string magic = Encoding.ASCII.GetString(buf, 0, 8);
                if (magic != MAGIC) return false;
                off = BitConverter.ToInt64(buf, 8);
                size = BitConverter.ToInt64(buf, 16);
                return off > 0 && size > 0 && off + size <= fs.Length;
            }
        }

        static void MakeShortcut(string dir, string name, string exe)
        {
            try
            {
                Directory.CreateDirectory(dir);
                var t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell,
                                            new object[] { Path.Combine(dir, name + ".lnk") });
                lnk.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { exe });
                lnk.GetType().InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(exe) });
                lnk.GetType().InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { "Breeze TTS 2 本地语音合成" });
                lnk.GetType().InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, lnk, null);
            }
            catch { }
        }

        void WriteRegistry()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\BreezeTTS2"))
                {
                    string exe = Path.Combine(target, "BreezeTTS2.exe");
                    k.SetValue("DisplayName", "Breeze TTS 2");
                    k.SetValue("DisplayVersion", "1.0.0");
                    k.SetValue("Publisher", "Breeze TTS 2 Desktop (unofficial build)");
                    k.SetValue("InstallLocation", target);
                    k.SetValue("DisplayIcon", exe);
                    k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("EstimatedSize", 240000, RegistryValueKind.DWord);
                }
            }
            catch { }
        }
    }

    /// <summary>把安装包内的一段字节伪装成可寻址流，供 ZipArchive 直接读取。</summary>
    sealed class SliceStream : Stream
    {
        readonly Stream inner;
        readonly long start;
        readonly long length;
        long pos;

        public SliceStream(Stream inner, long start, long length)
        {
            this.inner = inner; this.start = start; this.length = length; this.pos = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position
        {
            get { return pos; }
            set { if (value < 0 || value > length) throw new ArgumentOutOfRangeException(); pos = value; }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long left = length - pos;
            if (left <= 0) return 0;
            if (count > left) count = (int)left;
            inner.Seek(start + pos, SeekOrigin.Begin);
            int n = inner.Read(buffer, offset, count);
            if (n > 0) pos += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long p = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? pos + offset : length + offset;
            if (p < 0 || p > length) throw new ArgumentOutOfRangeException();
            pos = p;
            return pos;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    static class Native
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
                if (args[i] == "--dir" && i + 1 < args.Length) SetupForm.OverrideTarget = args[i + 1];
            Application.EnableVisualStyles();
            Application.Run(new SetupForm());
        }
    }
}
