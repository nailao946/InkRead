using System;
using System.IO;
using System.Threading;
using InkRead;

namespace ServerSmoke
{
    /// <summary>
    /// LocalServer 冒烟测试宿主（无 GUI）：
    ///   server-smoke.exe &lt;web根目录&gt; [端口写出文件]
    /// 启动后把实际端口写入指定文件，便于外部脚本读取并请求验证。
    /// </summary>
    internal static class Program
    {
        private static void Main(string[] args)
        {
            string root = args.Length > 0 ? args[0] : Directory.GetCurrentDirectory();
            string portFile = args.Length > 1 ? args[1] : null;

            try
            {
                using (var server = new LocalServer(root, null))
                {
                    Console.WriteLine("PORT=" + server.Port);
                    if (!string.IsNullOrEmpty(portFile))
                        File.WriteAllText(portFile, server.Port.ToString());
                    Console.Out.Flush();
                    Thread.Sleep(Timeout.Infinite);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERROR=" + ex);
                Console.Out.Flush();
            }
        }
    }
}
