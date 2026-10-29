using System;
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

        Label title, sub, pathLabel, note;
        TextBox pathBox;
        Button browse, primary, cancel;
        Panel barBg, bar;
        bool failed, installing;

        public static string OverrideTarget;

        public SetupForm()
        {
            Text = "Breeze TTS 2 安装程序";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 330);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9f);

            title = new Label();
            title.Text = "B R E E Z E   T T S   2";
            title.Font = new Font("Segoe UI", 12f);
            title.ForeColor = Color.Black;
            title.SetBounds(40, 36, 440, 26);
            Controls.Add(title);

            sub = new Label();
            sub.Text = "选择安装位置，然后点安装";
            sub.ForeColor = Color.FromArgb(120, 120, 120);
            sub.SetBounds(40, 68, 440, 20);
            Controls.Add(sub);

            pathLabel = new Label();
            pathLabel.Text = "安 装 位 置";
            pathLabel.Font = new Font("Segoe UI", 8f);
            pathLabel.ForeColor = Color.FromArgb(150, 150, 150);
            pathLabel.SetBounds(40, 104, 440, 18);
            Controls.Add(pathLabel);

            pathBox = new TextBox();
            pathBox.BorderStyle = BorderStyle.FixedSingle;
            pathBox.Text = DefaultTarget();
            pathBox.SetBounds(40, 126, 348, 24);
            Controls.Add(pathBox);

            browse = new Button();
            browse.Text = "浏览...";
            browse.FlatStyle = FlatStyle.Flat;
            browse.FlatAppearance.BorderColor = Color.FromArgb(180, 180, 180);
            browse.BackColor = Color.White;
            browse.SetBounds(398, 125, 82, 26);
            browse.Click += delegate { PickFolder(); };
            Controls.Add(browse);

            barBg = new Panel();
            barBg.BackColor = Color.FromArgb(228, 228, 228);
            barBg.SetBounds(40, 172, 440, 2);
            Controls.Add(barBg);

            bar = new Panel();
            bar.BackColor = Color.Black;
            bar.SetBounds(0, 0, 0, 2);
            barBg.Controls.Add(bar);

            note = new Label();
            note.ForeColor = Color.FromArgb(150, 150, 150);
            note.SetBounds(40, 188, 440, 60);
            note.Text = "程序约 230 MB。模型权重不在此安装包内，首次启动时下载（约 2.4 GB）。";
            Controls.Add(note);

            cancel = new Button();
            cancel.Text = "取消";
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.FlatAppearance.BorderColor = Color.FromArgb(180, 180, 180);
            cancel.BackColor = Color.White;
            cancel.SetBounds(310, 262, 82, 30);
            cancel.Click += delegate { Close(); };
            Controls.Add(cancel);

            primary = new Button();
            primary.Text = "安装";
            primary.FlatStyle = FlatStyle.Flat;
            primary.FlatAppearance.BorderSize = 0;
            primary.BackColor = Color.Black;
            primary.ForeColor = Color.White;
            primary.SetBounds(398, 262, 82, 30);
            primary.Click += delegate { BeginInstall(); };
            Controls.Add(primary);

            MouseDown += delegate(object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) { Native.ReleaseCapture(); Native.SendMessage(Handle, 0xA1, 0x2, 0); }
            };

            if (!string.IsNullOrEmpty(OverrideTarget))
            {
                pathBox.Text = OverrideTarget;
                Load += delegate { BeginInstall(); };
            }
        }

        static string DefaultTarget()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BreezeTTS2");
        }

        void PickFolder()
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 Breeze TTS 2 的安装位置";
                dlg.ShowNewFolderButton = true;
                string cur = pathBox.Text.TrimEnd('\\');
                try
                {
                    DirectoryInfo d = new DirectoryInfo(cur);
                    while (d != null && !d.Exists) d = d.Parent;
                    if (d != null) dlg.SelectedPath = d.FullName;
                }
                catch { }
                if (dlg.ShowDialog(this) == DialogResult.OK)
                {
                    string picked = dlg.SelectedPath;
                    if (!string.Equals(Path.GetFileName(picked), "BreezeTTS2", StringComparison.OrdinalIgnoreCase))
                        picked = Path.Combine(picked, "BreezeTTS2");
                    pathBox.Text = picked;
                }
            }
        }

        void BeginInstall()
        {
            if (installing) return;
            string target = pathBox.Text.Trim();
            if (target.Length < 4)
            {
                note.Text = "请填写安装位置。";
                return;
            }
            try { target = Path.GetFullPath(target); } catch { note.Text = "路径不合法。"; return; }

            installing = true;
            pathBox.Text = target;
            pathBox.Enabled = false;
            browse.Enabled = false;
            primary.Enabled = false;
            cancel.Enabled = false;
            cancel.Text = "完成后关闭";
            sub.Text = "正在解压程序文件";
            note.Text = "";
            string t = target;
            ThreadPool.QueueUserWorkItem(delegate { Install(t); });
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

        void Finish(bool ok, string message, string target)
        {
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    failed = !ok;
                    installing = false;
                    sub.Text = ok ? "安装完成" : "安装失败";
                    note.Text = message;
                    cancel.Enabled = true;
                    cancel.Text = "关闭";
                    primary.Enabled = true;
                    primary.Text = ok ? "启动程序" : "重试";
                    primary.BackColor = Color.Black;
                    if (ok)
                    {
                        bar.Width = barBg.Width;
                        pathLabel.Visible = false;
                        pathBox.Visible = false;
                        browse.Visible = false;
                        primary.Click -= RestartInstall;
                        primary.Click += delegate
                        {
                            try { Process.Start(Path.Combine(target, "BreezeTTS2.exe")); } catch { }
                            Close();
                        };
                    }
                    else
                    {
                        primary.Click -= RestartInstall;
                        primary.Click += RestartInstall;
                    }
                });
            }
            catch { }
        }

        void RestartInstall(object sender, EventArgs e)
        {
            pathBox.Enabled = true;
            browse.Enabled = true;
            BeginInstall();
        }

        static void Log(string s)
        {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "breeze-setup.log"), DateTime.Now.ToString("HH:mm:ss") + "  " + s + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        void Install(string target)
        {
            try
            {
                Log("install start -> " + target);
                string self = Assembly.GetExecutingAssembly().Location;
                long off, size;
                if (!ReadTrailer(self, out off, out size)) { Finish(false, "安装包已损坏（找不到数据段）", target); return; }
                SetBar(8);

                Directory.CreateDirectory(target);
                if (!CanWrite(target)) { Finish(false, "没有写入权限：" + target + "，请换一个位置。", target); return; }

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
                        if (i % 3 == 0) SetBar(8 + (int)(72.0 * i / Math.Max(1, total)));
                    }
                }
                Log("extracted to " + target);
                SetBar(86);

                MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Breeze TTS 2"),
                             "Breeze TTS 2", Path.Combine(target, "BreezeTTS2.exe"));
                MakeShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                             "Breeze TTS 2", Path.Combine(target, "BreezeTTS2.exe"));
                WriteRegistry(target);
                SetBar(100);

                Finish(true, "已安装到 " + target + Environment.NewLine + "首次启动需要下载模型文件（约 2.4 GB）。", target);
            }
            catch (UnauthorizedAccessException ex)
            {
                Log("FAIL " + ex.Message);
                Finish(false, "没有写入权限：" + target + Environment.NewLine + "请点浏览换一个位置。", target);
            }
            catch (Exception ex)
            {
                Log("FAIL " + ex.ToString());
                Finish(false, ex.Message, target);
            }
        }

        static bool CanWrite(string dir)
        {
            try
            {
                string probe = Path.Combine(dir, ".write-test");
                File.WriteAllText(probe, "x");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
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
                if (Encoding.ASCII.GetString(buf, 0, 8) != MAGIC) return false;
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
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                                            new object[] { Path.Combine(dir, name + ".lnk") });
                lnk.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { exe });
                lnk.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(exe) });
                lnk.GetType().InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Breeze TTS 2 本地语音合成" });
                lnk.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            }
            catch { }
        }

        static void WriteRegistry(string target)
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

    sealed class SliceStream : Stream
    {
        readonly Stream inner;
        readonly long start, length;
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
