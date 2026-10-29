using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;

namespace Breeze
{
    static class Program
    {
        const string VERSION = "1.0.0";
        const string MODEL_FILE = "breeze-tts-2-q4_k.gguf";
        const string MODEL_URL = "https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/" + MODEL_FILE;
        const string MIRROR_URL = "https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/" + MODEL_FILE;

        static string AppDir, DataDir, ModelPath, VoicesDir, LogDir;
        static int UiPort = 18080;
        static int SrvPort = 18099;
        static Process Server;
        static volatile bool ServerReady, Starting, Downloading;
        static long DlBytes, DlTotal;
        static string DlError, SpeedText = "";
        static string LastServerLine = "";
        static string Backend = "";
        static readonly object QLock = new object();
        static readonly Queue<string> ServerLog = new Queue<string>();

        static int Main(string[] args)
        {
            bool uninstall = false, noOpen = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--uninstall") uninstall = true;
                if (args[i] == "--no-open") noOpen = true;
            }

            AppDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BreezeTTS2");
            ModelPath = FindModel();
            VoicesDir = Path.Combine(DataDir, "voices");
            LogDir = Path.Combine(DataDir, "logs");
            SafeMkDir(Path.GetDirectoryName(ModelPath));
            SafeMkDir(VoicesDir);
            SafeMkDir(LogDir);

            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            ServicePointManager.DefaultConnectionLimit = 8;

            if (uninstall) { Uninstall(); return 0; }

            bool created;
            Mutex single;
            try
            {
                single = new Mutex(true, "Local\\BreezeTTS2-UI", out created);
            }
            catch { created = true; single = null; }
            if (!created)
            {
                OpenBrowser("http://127.0.0.1:" + UiPort + "/");
                return 0;
            }

            try
            {
                if (!File.Exists(Path.Combine(AppDir, "breeze-server.exe")))
                {
                    Msg("找不到 breeze-server.exe。请把本程序放在安装目录内运行，或重新安装。");
                    return 1;
                }
                StartUi();
                if (File.Exists(ModelPath)) StartServer(); else Msg("model missing, waiting for download");
                AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };
                Thread.Sleep(400);
                if (!noOpen) OpenBrowser("http://127.0.0.1:" + UiPort + "/");
                Thread.Sleep(Timeout.Infinite);
            }
            catch (Exception ex)
            {
                Msg("启动失败：" + ex.Message);
                return 1;
            }
            finally { Shutdown(); if (single != null) single.ReleaseMutex(); }
            return 0;
        }

        static string FindModel()
        {
            string[] cands = new string[] {
                Path.Combine(DataDir, "models", MODEL_FILE),
                Path.Combine(AppDir, "models", MODEL_FILE),
                Path.Combine(AppDir, MODEL_FILE)
            };
            for (int i = 0; i < cands.Length; i++) if (File.Exists(cands[i])) return cands[i];
            return Path.Combine(DataDir, "models", MODEL_FILE);
        }

        static void SafeMkDir(string dir)
        {
            try { if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir); }
            catch (Exception ex) { Msg("mkdir failed " + dir + ": " + ex.Message); }
        }

        static void Msg(string text)
        {
            string line = DateTime.Now.ToString("s") + "  " + text + Environment.NewLine;
            try { File.AppendAllText(Path.Combine(LogDir, "launcher.log"), line, Encoding.UTF8); return; }
            catch { }
            try { File.AppendAllText(Path.Combine(AppDir, "launcher.log"), line, Encoding.UTF8); }
            catch { }
        }

        static void OpenBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception ex) { Msg("打开浏览器失败: " + ex.Message); }
        }

        /* ---------------- UI host ---------------- */
        static void StartUi()
        {
            for (int attempt = 0; attempt < 40; attempt++)
            {
                try
                {
                    var l = new HttpListener();
                    l.Prefixes.Add("http://127.0.0.1:" + UiPort + "/");
                    l.Start();
                    var t = new Thread(delegate () { AcceptLoop(l); });
                    t.IsBackground = true;
                    t.Start();
                    Msg("UI listening on " + UiPort);
                    return;
                }
                catch (Exception ex)
                {
                    Msg("bind " + UiPort + " failed: " + ex.Message);
                    UiPort++;
                }
            }
            throw new Exception("无法绑定本地端口");
        }

        static void AcceptLoop(HttpListener listener)
        {
            while (true)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); }
                catch { return; }
                ThreadPool.QueueUserWorkItem(delegate (object o) { Handle((HttpListenerContext)o); }, ctx);
            }
        }

        static void Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = ctx.Request.Url.AbsolutePath;
                if (path.StartsWith("/api/")) { Proxy(ctx, path); return; }
                if (path == "/local/status") { Json(ctx, StatusJson()); return; }
                if (path == "/local/download" && ctx.Request.HttpMethod == "POST") { StartDownload(); Json(ctx, "{\"ok\":true}"); return; }
                if (path == "/local/quit" && ctx.Request.HttpMethod == "POST") { Json(ctx, "{\"ok\":true}"); ThreadPool.QueueUserWorkItem(delegate { Thread.Sleep(300); Environment.Exit(0); }); return; }
                if (path == "/local/voices-dir" && ctx.Request.HttpMethod == "POST") { try { Process.Start("explorer.exe", "\"" + VoicesDir + "\""); } catch { } Json(ctx, "{\"ok\":true}"); return; }
                ServeStatic(ctx, path);
            }
            catch (Exception ex)
            {
                try { Json(ctx, "{\"error\":\"" + JsonEsc(ex.Message) + "\"}", 500); } catch { }
            }
        }

        static void ServeStatic(HttpListenerContext ctx, string path)
        {
            string name = path == "/" || path.Length == 0 ? "index.html" : path.TrimStart('/');
            string type = "text/plain";
            if (name.EndsWith(".html")) type = "text/html; charset=utf-8";
            else if (name.EndsWith(".css")) type = "text/css; charset=utf-8";
            else if (name.EndsWith(".js")) type = "text/javascript; charset=utf-8";

            byte[] body = null;
            string disk = Path.Combine(AppDir, "ui", name.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(disk)) body = File.ReadAllBytes(disk);
            else
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var s = asm.GetManifestResourceStream("ui." + name.Replace('/', '.')))
                {
                    if (s != null)
                    {
                        using (var ms = new MemoryStream())
                        {
                            var buf = new byte[16384];
                            int n;
                            while ((n = s.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
                            body = ms.ToArray();
                        }
                    }
                }
            }
            if (body == null) { ctx.Response.StatusCode = 404; ctx.Response.Close(); return; }
            ctx.Response.ContentType = type;
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.ContentLength64 = body.Length;
            ctx.Response.OutputStream.Write(body, 0, body.Length);
            ctx.Response.Close();
        }

        static void Json(HttpListenerContext ctx, string json, int code)
        {
            byte[] b = Encoding.UTF8.GetBytes(json);
            ctx.Response.StatusCode = code;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.ContentLength64 = b.Length;
            ctx.Response.OutputStream.Write(b, 0, b.Length);
            ctx.Response.Close();
        }
        static void Json(HttpListenerContext ctx, string json) { Json(ctx, json, 200); }

        static string JsonEsc(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static string StatusJson()
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"version\":\"" + VERSION + "\",");
            sb.Append("\"uiPort\":" + UiPort + ",");
            sb.Append("\"serverPort\":" + SrvPort + ",");
            sb.Append("\"modelPresent\":" + (File.Exists(ModelPath) ? "true" : "false") + ",");
            sb.Append("\"modelBytes\":" + (File.Exists(ModelPath) ? new FileInfo(ModelPath).Length : 0) + ",");
            sb.Append("\"modelTotal\":" + DlTotal + ",");
            sb.Append("\"downloading\":" + (Downloading ? "true" : "false") + ",");
            sb.Append("\"downloadBytes\":" + DlBytes + ",");
            sb.Append("\"speedText\":\"" + JsonEsc(SpeedText) + "\",");
            sb.Append("\"serverReady\":" + (ServerReady ? "true" : "false") + ",");
            sb.Append("\"starting\":" + (Starting ? "true" : "false") + ",");
            sb.Append("\"backend\":\"" + JsonEsc(Backend) + "\",");
            sb.Append("\"error\":\"" + JsonEsc(DlError) + "\",");
            sb.Append("\"message\":\"" + JsonEsc(LastServerLine) + "\"");
            sb.Append("}");
            return sb.ToString();
        }

        /* ---------------- proxy ---------------- */
        static void Proxy(HttpListenerContext ctx, string path)
        {
            string up;
            if (path == "/api/health") up = "/health";
            else if (path == "/api/speech") up = "/v1/audio/speech";
            else if (path == "/api/convert") up = "/v1/audio/convert";
            else if (path.StartsWith("/api/voices")) up = "/v1/voices" + path.Substring("/api/voices".Length);
            else up = path.Replace("/api/", "/v1/");
            string url = "http://127.0.0.1:" + SrvPort + up;

            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = ctx.Request.HttpMethod;
            req.Timeout = 600000;
            req.ReadWriteTimeout = 600000;
            req.KeepAlive = false;

            string ct = ctx.Request.ContentType;
            if (!string.IsNullOrEmpty(ct)) req.ContentType = ct;

            if (ctx.Request.HasEntityBody)
            {
                byte[] body;
                using (var ms = new MemoryStream())
                {
                    var buf = new byte[65536];
                    int n;
                    while ((n = ctx.Request.InputStream.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
                    body = ms.ToArray();
                }
                req.ContentLength = body.Length;
                using (var up1 = req.GetRequestStream()) up1.Write(body, 0, body.Length);
            }

            HttpWebResponse res = null;
            try
            {
                res = (HttpWebResponse)req.GetResponse();
            }
            catch (WebException wex)
            {
                var err = wex.Response as HttpWebResponse;
                if (err == null) { Json(ctx, "{\"error\":\"" + JsonEsc(wex.Message) + "\"}", 502); return; }
                res = err;
            }

            ctx.Response.StatusCode = (int)res.StatusCode;
            if (!string.IsNullOrEmpty(res.ContentType)) ctx.Response.ContentType = res.ContentType;
            foreach (string h in res.Headers.AllKeys)
            {
                try
                {
                    if (h.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) continue;
                    if (h.Equals("Connection", StringComparison.OrdinalIgnoreCase)) continue;
                    if (h.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) continue;
                    if (h.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                    ctx.Response.Headers[h] = res.Headers[h];
                }
                catch { }
            }
            ctx.Response.Headers["Cache-Control"] = "no-store";

            bool chunked = res.Headers["Transfer-Encoding"] != null &&
                           res.Headers["Transfer-Encoding"].IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
            if (chunked)
            {
                ctx.Response.SendChunked = true;
            }
            else if (res.ContentLength > 0)
            {
                ctx.Response.ContentLength64 = res.ContentLength;
            }

            try
            {
                var outS = ctx.Response.OutputStream;
                using (var inS = res.GetResponseStream())
                {
                    var buf = new byte[16384];
                    int n;
                    while ((n = inS.Read(buf, 0, buf.Length)) > 0)
                    {
                        outS.Write(buf, 0, n);
                        outS.Flush();
                    }
                }
                ctx.Response.Close();
            }
            catch { try { ctx.Response.Abort(); } catch { } }
            finally { try { res.Close(); } catch { } }
        }

        /* ---------------- model download ---------------- */
        static void StartDownload()
        {
            if (Downloading) return;
            Downloading = true;
            DlError = null;
            var t = new Thread(DownloadWorker);
            t.IsBackground = true;
            t.Start();
        }

        static void DownloadWorker()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(ModelPath));
                string part = ModelPath + ".part";
                long have = File.Exists(part) ? new FileInfo(part).Length : 0;

                foreach (string url in new string[] { MODEL_URL, MIRROR_URL })
                {
                    try
                    {
                        if (Fetch(url, part, ref have)) { Downloading = false; return; }
                    }
                    catch (Exception ex)
                    {
                        DlError = ex.Message;
                        Msg("download failed from " + url + ": " + ex.Message);
                    }
                }
                Downloading = false;
                if (DlError == null) DlError = "所有下载源均失败";
            }
            catch (Exception ex)
            {
                DlError = ex.Message;
                Downloading = false;
            }
        }

        static bool Fetch(string url, string part, ref long have)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "BreezeTTS2-Setup/" + VERSION;
            req.Timeout = 60000;
            req.ReadWriteTimeout = 120000;
            req.AllowAutoRedirect = true;
            if (have > 0) req.AddRange(have);

            using (var res = (HttpWebResponse)req.GetResponse())
            {
                if (res.StatusCode != HttpStatusCode.OK && res.StatusCode != HttpStatusCode.PartialContent)
                    throw new Exception("HTTP " + (int)res.StatusCode);

                if (res.StatusCode == HttpStatusCode.OK && have > 0) have = 0;

                DlTotal = have + res.ContentLength;
                DlBytes = have;
                var clock = Stopwatch.StartNew();
                long startAt = have;

                using (var fs = new FileStream(part, have > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read))
                using (var inS = res.GetResponseStream())
                {
                    var buf = new byte[262144];
                    int n;
                    while ((n = inS.Read(buf, 0, buf.Length)) > 0)
                    {
                        fs.Write(buf, 0, n);
                        DlBytes += n;
                        if (clock.ElapsedMilliseconds > 900)
                        {
                            double mbps = (DlBytes - startAt) / 1048576.0 / clock.Elapsed.TotalSeconds;
                            SpeedText = mbps.ToString("0.0") + " MB/s";
                            clock.Restart();
                            startAt = DlBytes;
                        }
                    }
                }
                SpeedText = "";
                if (DlTotal > 0 && DlBytes < DlTotal) throw new Exception("传输中断，已保留进度可续传");

                if (File.Exists(ModelPath)) File.Delete(ModelPath);
                File.Move(part, ModelPath);
                StartServer();
                return true;
            }
        }

        /* ---------------- server child process ---------------- */
        static void EnsureServer()
        {
            if (ServerReady || Starting) return;
            if (!File.Exists(ModelPath)) return;
            StartServer();
        }

        static void StartServer()
        {
            if (Starting || ServerReady) return;
            Starting = true;
            ThreadPool.QueueUserWorkItem(delegate (object o) { StartServerWorker(); });
        }

        static void StartServerWorker()
        {
            try
            {
                if (Server != null) { try { Server.Kill(); } catch { } Server = null; }

                var psi = new ProcessStartInfo();
                psi.FileName = Path.Combine(AppDir, "breeze-server.exe");
                psi.Arguments = "\"" + ModelPath + "\" --port " + SrvPort + " --host 127.0.0.1 --no-warmup --voices-dir \"" + VoicesDir + "\"";
                psi.WorkingDirectory = AppDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                Server = new Process();
                Server.StartInfo = psi;
                Server.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { Note(e.Data); };
                Server.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { Note(e.Data); };
                Server.Start();
                Server.BeginOutputReadLine();
                Server.BeginErrorReadLine();
                Server.EnableRaisingEvents = true;
                Server.Exited += delegate { ServerReady = false; Starting = false; Msg("server exited"); };

                for (int i = 0; i < 900; i++)
                {
                    Thread.Sleep(500);
                    try
                    {
                        var rq = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + SrvPort + "/health");
                        rq.Timeout = 1500;
                        using (var rs = (HttpWebResponse)rq.GetResponse())
                        {
                            if (rs.StatusCode == HttpStatusCode.OK) { ServerReady = true; Starting = false; return; }
                        }
                    }
                    catch { }
                    if (Server.HasExited) { Starting = false; Msg("server exited during startup"); return; }
                }
                Starting = false;
            }
            catch (Exception ex)
            {
                Msg("StartServer failed: " + ex.Message);
                Starting = false;
            }
        }

        static void Note(string line)
        {
            if (line == null) return;
            LastServerLine = line;
            lock (QLock)
            {
                ServerLog.Enqueue(DateTime.Now.ToString("HH:mm:ss") + " " + line);
                while (ServerLog.Count > 300) ServerLog.Dequeue();
            }
            if (line.IndexOf("Vulkan", StringComparison.OrdinalIgnoreCase) >= 0 && Backend.Length == 0) Backend = "Vulkan";
            if (line.IndexOf("CPU backend", StringComparison.OrdinalIgnoreCase) >= 0) Backend = "CPU";
        }

        static void Shutdown()
        {
            try
            {
                if (Server != null && !Server.HasExited)
                {
                    try { Server.Kill(); } catch { }
                    Server.WaitForExit(4000);
                }
            }
            catch { }
        }

        /* ---------------- uninstall ---------------- */
        static void Uninstall()
        {
            try
            {
                Shutdown();
                string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Breeze TTS 2");
                if (Directory.Exists(sm)) Directory.Delete(sm, true);
                string desk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Breeze TTS 2.lnk");
                if (File.Exists(desk)) File.Delete(desk);
                try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BreezeTTS2", false); } catch { }
                try { if (Directory.Exists(VoicesDir)) Msg("voices kept at " + VoicesDir); } catch { }
                // 程序目录由延迟的 cmd 删除，避免删掉正在运行的自身
                if (AppDir != null && AppDir.Length > 10 && Directory.Exists(AppDir))
                {
                    var psi = new ProcessStartInfo("cmd.exe", "/c ping -n 4 127.0.0.1 >nul & rmdir /s /q \"" + AppDir + "\"");
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                }
                Msg("uninstall done");
            }
            catch (Exception ex) { Msg("uninstall: " + ex.Message); }
        }
    }
}
