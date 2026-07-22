using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace NativeWiaScanner
{
    class Program
    {
        static void Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "list")
            {
                ListScanners();
                return;
            }

            string scannerId = args.Length > 0 ? args[0] : "";
            int dpi = args.Length > 1 ? int.Parse(args[1]) : 300;
            string colorMode = args.Length > 2 ? args[2] : "Color";
            string source = args.Length > 3 ? args[3] : "Flatbed";

            ScanDocument(scannerId, dpi, colorMode, source);
        }

        static void ListScanners()
        {
            try {
                Type devMgrType = Type.GetTypeFromProgID("WIA.DeviceManager");
                if (devMgrType == null) {
                    Console.WriteLine("[]");
                    return;
                }

                dynamic devMgr = Activator.CreateInstance(devMgrType);
                List<string> jsonItems = new List<string>();

                foreach (dynamic info in devMgr.DeviceInfos) {
                    if (info.Type == 1) { // 1 = ScannerDeviceType
                        string id = info.DeviceID;
                        string name = "Canon G3410 / WIA Scanner";
                        try {
                            name = info.Properties["Name"].Value.ToString();
                        } catch {}

                        string cleanId = EscapeJson(id);
                        string cleanName = EscapeJson(name);
                        jsonItems.Add(string.Format("{{\"id\":\"wia:{0}\",\"name\":\"{1}\",\"type\":\"WIA\"}}", cleanId, cleanName));
                    }
                }

                Console.WriteLine("[" + string.Join(",", jsonItems.ToArray()) + "]");
            } catch (Exception ex) {
                Console.WriteLine("[]");
            }
        }

        static void ScanDocument(string scannerId, int dpi, string colorMode, string source)
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "wia_cs_" + Guid.NewGuid().ToString());
            Directory.CreateDirectory(tempDir);

            try {
                Type devMgrType = Type.GetTypeFromProgID("WIA.DeviceManager");
                if (devMgrType == null) {
                    Console.WriteLine("{\"success\":false,\"error\":\"WIA Component not registered on this Windows PC.\"}");
                    return;
                }

                dynamic devMgr = Activator.CreateInstance(devMgrType);
                dynamic device = null;

                string cleanTargetId = scannerId.Replace("wia:", "");

                if (!string.IsNullOrEmpty(cleanTargetId)) {
                    foreach (dynamic info in devMgr.DeviceInfos) {
                        if (info.DeviceID.ToString() == cleanTargetId) {
                            try { device = info.Connect(); break; } catch {}
                        }
                    }
                }

                if (device == null) {
                    foreach (dynamic info in devMgr.DeviceInfos) {
                        if (info.Type == 1) {
                            try { device = info.Connect(); break; } catch {}
                        }
                    }
                }

                if (device == null) {
                    Console.WriteLine("{\"success\":false,\"error\":\"No Canon PIXMA G3410 WIA scanner found. Ensure scanner is powered on and USB/Wi-Fi connected.\"}");
                    return;
                }

                dynamic item = device.Items[1];

                // Configure DPI (Horizontal=6147, Vertical=6148)
                try { item.Properties["6147"].Value = dpi; } catch {}
                try { item.Properties["6148"].Value = dpi; } catch {}

                // Color Intent: 1=Color, 2=Grayscale, 4=BW
                int intent = 1;
                if (colorMode.Equals("Grayscale", StringComparison.OrdinalIgnoreCase)) intent = 2;
                if (colorMode.Equals("Black & White", StringComparison.OrdinalIgnoreCase) || colorMode.Equals("BW", StringComparison.OrdinalIgnoreCase)) intent = 4;
                try { item.Properties["6146"].Value = intent; } catch {}

                // Paper Source: 1=Flatbed, 2=ADF
                int paperSourceVal = source.Equals("ADF", StringComparison.OrdinalIgnoreCase) ? 2 : 1;
                try { device.Properties["3088"].Value = paperSourceVal; } catch {}

                string jpegFormatGuid = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}";
                List<string> base64Pages = new List<string>();

                int maxPages = source.Equals("ADF", StringComparison.OrdinalIgnoreCase) ? 50 : 1;

                for (int i = 0; i < maxPages; i++) {
                    try {
                        dynamic imageFile = item.Transfer(jpegFormatGuid);
                        if (imageFile != null) {
                            string pagePath = Path.Combine(tempDir, string.Format("page_{0}.jpg", i + 1));
                            if (File.Exists(pagePath)) File.Delete(pagePath);
                            imageFile.SaveFile(pagePath);

                            byte[] bytes = File.ReadAllBytes(pagePath);
                            base64Pages.Add("data:image/jpeg;base64," + Convert.ToBase64String(bytes));

                            if (source != "ADF") break;
                        } else {
                            break;
                        }
                    } catch (Exception transferEx) {
                        if (base64Pages.Count > 0) break; // Batch completed
                        throw transferEx;
                    }
                }

                if (base64Pages.Count == 0) {
                    Console.WriteLine("{\"success\":false,\"cancelled\":true}");
                    return;
                }

                List<string> pagesJsonArr = new List<string>();
                foreach (string page in base64Pages) {
                    pagesJsonArr.Add("\"" + page + "\"");
                }

                Console.WriteLine("{\"success\":true,\"method\":\"WIA_CS\",\"pages\":[" + string.Join(",", pagesJsonArr.ToArray()) + "]}");

            } catch (Exception ex) {
                string msg = EscapeJson(ex.Message);
                Console.WriteLine(string.Format("{{\"success\":false,\"error\":\"{0}\"}}", msg));
            } finally {
                try {
                    if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
                } catch {}
            }
        }

        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
        }
    }
}
