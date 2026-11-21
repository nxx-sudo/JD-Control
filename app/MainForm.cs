using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace JDControl
{
    public class MainForm : Form
    {
        const string BASE = "http://127.0.0.1:8081";
        public const string APP_VERSION = "0.2";
        public const string APP_CHANNEL = "BETA";
        const int ROW_H = 34;
        const int CAPTION_H = 32; // barra de titulo propia (mismo color que el fondo)

        static Process serverProc;
        static bool serverExternal;
        static bool serverErrorShown;
        static DateTime lastServerRetry = DateTime.MinValue;

        Label lblTitle;
        Label lblSub;
        Label lblCodeCaption;
        Label lblCode;
        PictureBox picQr;
        Label lblUrl;
        Label lblTunnel;
        Label lblTunnelOk;
        Label lblUpdate;
        Label lblGame;
        Label lblPlayers;
        Panel pnlPlayers;
        Panel content;
        Panel caption;
        Button btnMin;
        Button btnClose;
        Button btnSettings;
        Button btnOnline;
        Button btnOffline;
        Button btnJoin;
        Button btnCopyCode;
        Button btnCopyLink;
        Button btnCopyIp;
        CheckBox chkRequireIp;
        ToolTip tips;
        System.Windows.Forms.Timer copyTimer;
        Button copyButton;
        bool suppressRequireIp = false;

        // Iconos Lucide ya rasterizados (se dibujan muchas veces por segundo)
        Bitmap iconPc;
        Bitmap iconPhone;
        Bitmap iconPlus;
        Bitmap iconPad;
        Bitmap iconPadDim;
        Bitmap iconKinect;
        Bitmap iconKinectDim;
        Bitmap iconCamera;
        Bitmap iconCameraDim;
        const int DEVICE_ICON = 14;

        class PlayerRow
        {
            public string Name;
            public string Song;
            public string AvatarUrl;
            public int State; // 0 = fuera del juego, 1 = en el menu, 2 = bailando
            public bool AsciiName; // la fuente JD (DEMO) no dibuja acentos
            public bool Admin;
            public bool Online; // fila de otro PC de la sala
            public bool Pc;     // juega desde un PC con JD CONTROL
            public bool Phone;  // tiene el movil conectado como control
            public bool Ready;  // ha marcado listo para esta cancion
            public string Device; // mando/kinect/camara detectado (null en jugadores)
            public bool Dance;    // ese dispositivo puede puntuar (si no, solo menus)
            public string StateText; // texto fijo de la columna estado (dispositivos)

            public string Signature
            {
                get { return Name + "|" + State + "|" + (Song ?? "") + "|" + (AvatarUrl ?? "") + "|" + Admin + "|" + Online + "|" + Pc + "|" + Phone + "|" + Ready + "|" + (Device ?? "") + "|" + Dance + "|" + (StateText ?? ""); }
            }
        }

        List<PlayerRow> playerRows = new List<PlayerRow>();
        bool playersEmpty = true; // true cuando no hay nadie conectado

        Dictionary<string, Image> avatarCache = new Dictionary<string, Image>();
        HashSet<string> avatarPending = new HashSet<string>();
        HashSet<string> avatarFailed = new HashSet<string>();

        Font fontName;
        Font fontNameFallback;
        Font fontSmall;
        Font fontEmpty;

        FontFamily jdFamily;
        PrivateFontCollection jdFonts;

        NotifyIcon tray;
        Icon trayIcon;
        Icon appIcon;

        Dictionary<string, object> lastState;
        string pendingUpdateUrl = "";
        string pendingUpdateTag = "";

        string currentCode = "";
        string currentUrl = "";
        string currentIp = "";
        string lastPlayersSignature = "";
        string onlineRole = "";
        string onlineCode = "";
        string lastOnlineHost = "";
        string tunnelBase = "";
        bool tunnelActive = false;
        string tunnelState = "";
        string tunnelError = "";
        volatile bool running = true;

        public MainForm()
        {
            Text = "JD CONTROL";
            ClientSize = new Size(420, CAPTION_H + 648);
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(10, 10, 12);
            ForeColor = Color.FromArgb(230, 230, 236);
            Font = new Font("Segoe UI", 9f);
            AutoScaleMode = AutoScaleMode.None;

            LoadJdFont();
            appIcon = LoadAppIcon();
            if (appIcon != null) Icon = appIcon;

            BuildUi();
            BuildTray();

            Load += delegate
            {
                EnsureServer();
                StartPolling();
                if (Settings.SendLogs) SendLogs("inicio del panel", null);
                if (Settings.CheckUpdates) CheckUpdates();
            };
            FormClosing += OnFormClosing;
        }

        /** Sin borde del sistema no hay sombra: se pide CS_DROPSHADOW. */
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000;
                return cp;
            }
        }

        /* ------------------------------------------------------------ */
        /*  Tipografia e icono                                           */
        /* ------------------------------------------------------------ */
        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        static extern int AddFontResourceEx(string lpFileName, uint fl, IntPtr pdv);

        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        /** Barra de titulo oscura para los dialogos (Win10 1809+ y Win11). */
        static void DarkTitleBar(IntPtr hwnd)
        {
            int on = 1;
            if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref on, 4);

            int caption = 10 | (10 << 8) | (12 << 16);   // 0x000C0A0A
            DwmSetWindowAttribute(hwnd, 35, ref caption, 4);  // Win11
            int text = 230 | (230 << 8) | (236 << 16);
            DwmSetWindowAttribute(hwnd, 36, ref text, 4);     // Win11
            int border = 30 | (30 << 8) | (36 << 16);
            DwmSetWindowAttribute(hwnd, 34, ref border, 4);   // Win11
        }

        /** Carga RBNo2.1 Black solo para este proceso (no instala nada). */
        void LoadJdFont()
        {
            try
            {
                string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    "public", "fonts", "RBNo2.1-Black.otf");
                if (!File.Exists(p)) return;

                AddFontResourceEx(p, 0x10, IntPtr.Zero); // FR_PRIVATE
                jdFonts = new PrivateFontCollection();
                jdFonts.AddFontFile(p);
                if (jdFonts.Families.Length > 0) jdFamily = jdFonts.Families[0];
            }
            catch { jdFamily = null; }
        }

        /**
         * RBNo2.1 no trae tildes ni "ñ": las pinta como cajas. Todo lo que se
         * dibuja con esa fuente pasa antes por aquí.
         */
        static string JdText(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";

            char[] c = text.ToCharArray();
            for (int i = 0; i < c.Length; i++)
            {
                switch (c[i])
                {
                    case 'á': case 'à': case 'ä': case 'â': case 'ã': case 'å': c[i] = 'a'; break;
                    case 'Á': case 'À': case 'Ä': case 'Â': case 'Ã': case 'Å': c[i] = 'A'; break;
                    case 'é': case 'è': case 'ë': case 'ê': c[i] = 'e'; break;
                    case 'É': case 'È': case 'Ë': case 'Ê': c[i] = 'E'; break;
                    case 'í': case 'ì': case 'ï': case 'î': c[i] = 'i'; break;
                    case 'Í': case 'Ì': case 'Ï': case 'Î': c[i] = 'I'; break;
                    case 'ó': case 'ò': case 'ö': case 'ô': case 'õ': c[i] = 'o'; break;
                    case 'Ó': case 'Ò': case 'Ö': case 'Ô': case 'Õ': c[i] = 'O'; break;
                    case 'ú': case 'ù': case 'ü': case 'û': c[i] = 'u'; break;
                    case 'Ú': case 'Ù': case 'Ü': case 'Û': c[i] = 'U'; break;
                    case 'ñ': c[i] = 'n'; break;
                    case 'Ñ': c[i] = 'N'; break;
                    case 'ç': c[i] = 'c'; break;
                    case 'Ç': c[i] = 'C'; break;
                }
            }
            return new string(c);
        }

        /** RBNo2.1 solo trae un peso: se usa recta, sin negrita sintetica. */
        Font JdFont(float size, FontStyle fallbackStyle)
        {
            if (jdFamily != null) return new Font(jdFamily, size, FontStyle.Regular);
            return new Font("Segoe UI", size, fallbackStyle);
        }

        /** Baja el tamaño del titulo hasta que entra en el ancho del panel. */
        Font FitJdTitle(string text, int width)
        {
            float size = 18f;
            while (size > 10f)
            {
                Font f = JdFont(size, FontStyle.Bold);
                if (TextRenderer.MeasureText(text, f).Width <= width) return f;
                f.Dispose();
                size -= 0.5f;
            }
            return JdFont(10f, FontStyle.Bold);
        }

        static Icon LoadAppIcon()
        {
            try
            {
                string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "jd.ico");
                if (File.Exists(p)) return new Icon(p);
            }
            catch { }

            try
            {
                Icon i = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (i != null) return i;
            }
            catch { }

            return null;
        }

        /* ------------------------------------------------------------ */
        /*  Interfaz                                                     */
        /* ------------------------------------------------------------ */
        void BuildUi()
        {
            // El contenido vive en un panel propio para dejar arriba la barra
            // de titulo, con el mismo color que el fondo del exe.
            content = new Panel();
            content.SetBounds(0, CAPTION_H, 420, 648);
            content.BackColor = BackColor;
            Controls.Add(content);
            BuildCaption();

            fontName = JdFont(10f, FontStyle.Bold);
            fontNameFallback = new Font("Segoe UI", 10f, FontStyle.Bold);
            fontSmall = new Font("Segoe UI", 8f);
            fontEmpty = new Font("Segoe UI", 9f);

            Color iconColor = Color.FromArgb(150, 150, 162);
            Color iconDim = Color.FromArgb(84, 84, 96);
            iconPc = Lucide.Render(Lucide.Monitor, DEVICE_ICON, iconColor);
            iconPhone = Lucide.Render(Lucide.Smartphone, DEVICE_ICON, iconColor);
            iconPlus = Lucide.Render(Lucide.Plus, 9, Color.FromArgb(100, 100, 112));
            iconPad = Lucide.Render(Lucide.Gamepad, DEVICE_ICON, iconColor);
            iconPadDim = Lucide.Render(Lucide.Gamepad, DEVICE_ICON, iconDim);
            iconKinect = Lucide.Render(Lucide.Kinect, DEVICE_ICON, iconColor);
            iconKinectDim = Lucide.Render(Lucide.Kinect, DEVICE_ICON, iconDim);
            iconCamera = Lucide.Render(Lucide.Camera, DEVICE_ICON, iconColor);
            iconCameraDim = Lucide.Render(Lucide.Camera, DEVICE_ICON, iconDim);

            lblTitle = new Label();
            lblTitle.Text = "JD CONTROL";
            lblTitle.Font = FitJdTitle("JD CONTROL", 368);
            lblTitle.ForeColor = Color.FromArgb(245, 245, 250);
            lblTitle.SetBounds(24, 10, 372, 30);

            lblSub = new Label();
            lblSub.Text = L.T("subLocal");
            lblSub.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblSub.ForeColor = Color.FromArgb(150, 150, 160);
            lblSub.SetBounds(26, 42, 372, 16);

            lblCodeCaption = new Label();
            lblCodeCaption.Text = L.T("code");
            lblCodeCaption.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblCodeCaption.ForeColor = Color.FromArgb(120, 120, 130);
            lblCodeCaption.SetBounds(26, 66, 372, 14);

            lblCode = new Label();
            lblCode.Text = "-----";
            lblCode.Font = new Font("Consolas", 34f, FontStyle.Bold);
            lblCode.ForeColor = Color.FromArgb(238, 238, 243);
            lblCode.TextAlign = ContentAlignment.MiddleCenter;
            lblCode.BackColor = Color.FromArgb(20, 20, 24);
            lblCode.SetBounds(24, 82, 372, 52);

            picQr = new PictureBox();
            picQr.SetBounds(130, 142, 160, 160);
            picQr.SizeMode = PictureBoxSizeMode.Zoom;
            picQr.BackColor = Color.FromArgb(20, 20, 24);

            lblUrl = new Label();
            lblUrl.Text = "";
            lblUrl.Font = new Font("Segoe UI", 7.5f);
            lblUrl.ForeColor = Color.FromArgb(120, 120, 130);
            lblUrl.TextAlign = ContentAlignment.MiddleCenter;
            lblUrl.AutoEllipsis = true;
            // 44..376 queda centrado en el panel (210) y deja libre el margen
            // derecho donde va el boton de copiar (378..396).
            lblUrl.SetBounds(44, 311, 332, 20);

            // Copiar código / enlace / IP con un clic (compartir es mas practico)
            tips = new ToolTip();
            tips.AutoPopDelay = 4000;
            tips.InitialDelay = 350;
            tips.ReshowDelay = 200;
            tips.SetToolTip(btnSettings, L.T("settingsTip"));

            btnCopyCode = MakeCopyButton(364, 95, 26, Color.FromArgb(20, 20, 24), L.T("copyCode"));
            btnCopyCode.Click += delegate { CopyToClipboard(currentCode, btnCopyCode); };

            // Los dos comparten el mismo hueco: solo se ve el que toca
            // (enlace si hay tunel, IP si no).
            btnCopyLink = MakeCopyButton(378, 312, 18, BackColor, L.T("copyLink"));
            btnCopyLink.Click += delegate { CopyToClipboard(currentUrl, btnCopyLink); };
            btnCopyLink.Visible = false;

            btnCopyIp = MakeCopyButton(378, 312, 18, BackColor, L.T("copyIp"));
            btnCopyIp.Click += delegate { CopyToClipboard(currentIp, btnCopyIp); };
            btnCopyIp.Visible = false;

            // Solo el anfitrion decide si el codigo basta o se exige la IP.
            chkRequireIp = new CheckBox();
            chkRequireIp.Text = L.T("requireIp");
            chkRequireIp.Font = new Font("Segoe UI", 7.5f);
            chkRequireIp.ForeColor = Color.FromArgb(140, 140, 150);
            chkRequireIp.BackColor = Color.FromArgb(10, 10, 12);
            chkRequireIp.FlatStyle = FlatStyle.Flat;
            chkRequireIp.TextAlign = ContentAlignment.MiddleRight;
            chkRequireIp.SetBounds(214, 61, 182, 20);
            chkRequireIp.Enabled = false;
            chkRequireIp.CheckedChanged += delegate
            {
                if (suppressRequireIp) return;
                if (!SetRequireIp(chkRequireIp.Checked))
                {
                    suppressRequireIp = true;
                    chkRequireIp.Checked = !chkRequireIp.Checked;
                    suppressRequireIp = false;
                }
            };
            tips.SetToolTip(chkRequireIp, L.T("tipRequireIp"));

            lblGame = new Label();
            lblGame.Text = L.T("gameWaiting");
            lblGame.ForeColor = Color.FromArgb(175, 175, 185);
            lblGame.SetBounds(26, 342, 372, 18);

            lblPlayers = new Label();
            lblPlayers.Text = L.T("players");
            lblPlayers.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblPlayers.ForeColor = Color.FromArgb(120, 120, 130);
            lblPlayers.SetBounds(26, 364, 372, 14);

            pnlPlayers = new BufferedPanel();
            pnlPlayers.SetBounds(24, 382, 372, 174);
            pnlPlayers.BackColor = Color.FromArgb(14, 14, 17);
            pnlPlayers.Paint += DrawPlayersTable;

            // Los tres botones comparten exactamente el mismo ancho.
            btnOnline = MakeButton(L.T("openServer"), 24, 566, 118);
            btnOnline.BackColor = Color.FromArgb(30, 30, 36);
            btnOnline.ForeColor = Color.FromArgb(238, 238, 243);
            btnOnline.Click += delegate { SendRoom(true); };
            tips.SetToolTip(btnOnline, L.T("tipOpen"));

            btnOffline = MakeButton(L.T("closeServer"), 151, 566, 118);
            btnOffline.BackColor = Color.FromArgb(18, 18, 22);
            btnOffline.ForeColor = Color.FromArgb(226, 226, 232);
            btnOffline.Click += delegate { SendRoom(false); };
            tips.SetToolTip(btnOffline, L.T("tipClose"));

            btnJoin = MakeButton(L.T("joinRoom"), 278, 566, 118);
            btnJoin.BackColor = Color.FromArgb(18, 18, 22);
            btnJoin.ForeColor = Color.FromArgb(200, 200, 208);
            btnJoin.Click += delegate { ShowJoinDialog(); };

            // Estado del tunel: se abre y se cierra junto con el servidor.
            lblTunnel = new Label();
            lblTunnel.Text = L.T("stNoTunnel");
            lblTunnel.Font = new Font("Segoe UI", 7.5f);
            lblTunnel.ForeColor = Color.FromArgb(110, 110, 120);
            lblTunnel.TextAlign = ContentAlignment.MiddleLeft;
            lblTunnel.AutoSize = false;
            lblTunnel.SetBounds(24, 606, 372, 18);

            // Segunda mitad de la linea, en verde ("online activo").
            lblTunnelOk = new Label();
            lblTunnelOk.Text = "";
            lblTunnelOk.Font = lblTunnel.Font;
            lblTunnelOk.ForeColor = Color.FromArgb(104, 196, 126);
            lblTunnelOk.TextAlign = ContentAlignment.MiddleLeft;
            lblTunnelOk.AutoSize = false;
            lblTunnelOk.SetBounds(24, 606, 372, 18);
            lblTunnelOk.Visible = false;

            // Aviso de version nueva: debajo de los botones, sin tapar nada.
            lblUpdate = new Label();
            lblUpdate.Text = "";
            lblUpdate.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblUpdate.ForeColor = Color.FromArgb(228, 182, 96);
            lblUpdate.TextAlign = ContentAlignment.MiddleCenter;
            lblUpdate.SetBounds(24, 628, 372, 18);
            lblUpdate.Cursor = Cursors.Hand;
            lblUpdate.Visible = false;
            lblUpdate.Click += delegate
            {
                if (pendingUpdateUrl.Length == 0) return;
                try { Process.Start(pendingUpdateUrl); } catch { }
            };

            content.Controls.Add(lblTitle);
            content.Controls.Add(lblSub);
            content.Controls.Add(lblCodeCaption);
            content.Controls.Add(lblCode);
            content.Controls.Add(picQr);
            content.Controls.Add(lblUrl);
            content.Controls.Add(lblGame);
            content.Controls.Add(lblPlayers);
            content.Controls.Add(pnlPlayers);
            content.Controls.Add(btnOnline);
            content.Controls.Add(btnOffline);
            content.Controls.Add(btnJoin);
            content.Controls.Add(chkRequireIp);
            content.Controls.Add(btnCopyCode);
            content.Controls.Add(btnCopyLink);
            content.Controls.Add(btnCopyIp);
            content.Controls.Add(lblTunnel);
            content.Controls.Add(lblTunnelOk);
            content.Controls.Add(lblUpdate);

            btnCopyCode.BringToFront();
            btnCopyLink.BringToFront();
            btnCopyIp.BringToFront();
        }

        /** Barra de titulo propia: fondo del panel, sin borde y con dos botones. */
        void BuildCaption()
        {
            caption = new Panel();
            caption.SetBounds(0, 0, 420, CAPTION_H);
            caption.BackColor = BackColor;
            caption.MouseDown += DragWindow;

            btnMin = MakeCaptionButton("–", 420 - 92, 12f);
            btnMin.Click += delegate { WindowState = FormWindowState.Minimized; };

            btnClose = MakeCaptionButton("✕", 420 - 46, 9.5f);
            btnClose.Click += delegate { Close(); };

            // Ajustes: solo el icono, sin borde ni fondo (queda limpio).
            btnSettings = MakeCaptionButton("", 420 - 138, 9f);
            btnSettings.Image = Lucide.Render(Lucide.Sliders, 15, Color.FromArgb(150, 150, 162));
            btnSettings.ImageAlign = ContentAlignment.MiddleCenter;
            btnSettings.Click += delegate { ShowSettingsDialog(); };

            caption.Controls.Add(btnSettings);
            caption.Controls.Add(btnMin);
            caption.Controls.Add(btnClose);
            Controls.Add(caption);
            caption.BringToFront();
        }

        Button MakeCaptionButton(string glyph, int x, float size)
        {
            Button b = new Button();
            b.Text = glyph;
            b.SetBounds(x, 0, 46, CAPTION_H);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(26, 26, 32);
            b.FlatAppearance.MouseDownBackColor = Color.FromArgb(38, 38, 46);
            b.BackColor = BackColor;
            b.ForeColor = Color.FromArgb(146, 146, 158);
            b.Font = new Font("Segoe UI", size);
            b.Cursor = Cursors.Hand;
            b.TabStop = false;
            return b;
        }

        void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero); // WM_NCLBUTTONDOWN / HTCAPTION
        }

        void DrawPlayersTable(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;

            Rectangle box = pnlPlayers.ClientRectangle;

            using (Brush bg = new SolidBrush(Color.FromArgb(14, 14, 17)))
                g.FillRectangle(bg, box);

            using (Pen border = new Pen(Color.FromArgb(30, 30, 36)))
                g.DrawRectangle(border, 0, 0, box.Width - 1, box.Height - 1);

            if (playersEmpty)
            {
                using (StringFormat sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    using (Brush fg = new SolidBrush(Color.FromArgb(108, 108, 122)))
                        g.DrawString(L.T("emptyPlayers"), fontEmpty, fg,
                            new RectangleF(0, 0, box.Width, box.Height), sf);
                }
                return;
            }

            const int COL_CIRCLE = 34;   // zona cuadrada del circulo de estado
            const int COL_STATUS = 214;  // division nombre / estado

            int y = 1;
            int w = box.Width - 2;

            for (int i = 0; i < playerRows.Count; i++)
            {
                PlayerRow p = playerRows[i];
                if (y + ROW_H > box.Height - 1) break;

                Rectangle row = new Rectangle(1, y, w, ROW_H);

                // Linea divisoria entre filas
                if (i > 0)
                {
                    using (Pen sep = new Pen(Color.FromArgb(24, 24, 29)))
                        g.DrawLine(sep, row.X + 12, row.Y, row.Right - 12, row.Y);
                }

                /* --- Columna 1: circulo de estado (sin halo) --- */
                Color dot =
                    p.State == 2 ? Color.FromArgb(74, 190, 112) :
                    p.State == 1 ? Color.FromArgb(226, 184, 60) :
                                   Color.FromArgb(214, 76, 76);

                const int DIAM = 10;
                Rectangle circle = new Rectangle(
                    COL_CIRCLE / 2 - DIAM / 2,
                    row.Y + (ROW_H - DIAM) / 2,
                    DIAM, DIAM);

                using (Brush b = new SolidBrush(dot))
                    g.FillEllipse(b, circle);

                using (Pen ring = new Pen(Color.FromArgb(30, 0, 0, 0)))
                    g.DrawEllipse(ring, circle);

                /* --- Divisiones de la tabla --- */
                using (Pen div = new Pen(Color.FromArgb(38, 38, 44)))
                {
                    g.DrawLine(div, COL_CIRCLE, row.Y + 7, COL_CIRCLE, row.Bottom - 7);
                    g.DrawLine(div, COL_STATUS, row.Y + 7, COL_STATUS, row.Bottom - 7);
                }

                /* --- Columna 2: avatar + nombre --- */
                int nameX = COL_CIRCLE + 10;

                Image avatar;
                if (p.AvatarUrl != null && avatarCache.TryGetValue(p.AvatarUrl, out avatar))
                {
                    Rectangle ar = new Rectangle(nameX, row.Y + (ROW_H - 20) / 2, 20, 20);
                    g.DrawImage(avatar, ar);
                    using (Pen avPen = new Pen(Color.FromArgb(52, 52, 60)))
                        g.DrawEllipse(avPen, ar);
                    nameX = ar.Right + 7;
                }

                // Iconos de dispositivo a la derecha del nombre: [pc] + [movil]
                // o el mando / Kinect / camara detectado (atenuado si solo sirve
                // para menus, o sea, no puede puntuar en una cancion).
                List<Image> icons = new List<Image>();
                if (p.Pc) icons.Add(iconPc);
                if (p.Pc && p.Phone) icons.Add(iconPlus);
                if (p.Phone) icons.Add(iconPhone);
                if (p.Device == "kinect") icons.Add(p.Dance ? iconKinect : iconKinectDim);
                else if (p.Device == "camera") icons.Add(p.Dance ? iconCamera : iconCameraDim);
                else if (p.Device != null) icons.Add(p.Dance ? iconPad : iconPadDim);

                int devW = 0;
                foreach (Image di in icons) devW += di.Width + 3;
                if (devW > 0) devW += 4;

                Font nf = p.AsciiName ? fontName : fontNameFallback;
                int nameMax = Math.Max(20, COL_STATUS - nameX - 8 - devW);
                TextFormatFlags tf = TextFormatFlags.Left | TextFormatFlags.VerticalCenter |
                    TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
                TextRenderer.DrawText(g, p.Name, nf,
                    new Rectangle(nameX, row.Y, nameMax, ROW_H),
                    Color.FromArgb(238, 238, 243), tf);

                int ix = nameX + Math.Min(nameMax,
                    TextRenderer.MeasureText(g, p.Name, nf, new Size(int.MaxValue, ROW_H), tf).Width) + 7;
                foreach (Image di in icons)
                {
                    g.DrawImage(di, ix, row.Y + (ROW_H - di.Height) / 2, di.Width, di.Height);
                    ix += di.Width + 3;
                }

                /* --- Columna 3: estado y cancion --- */
                string stateWord =
                    p.StateText != null ? p.StateText :
                    p.State == 2 ? L.T("stateDancing") :
                    p.Ready ? L.T("stateReady") :
                    p.State == 1 ? L.T("stateMenu") : L.T("stateOff");
                if (p.Admin) stateWord = "Admin · " + stateWord;

                int stX = COL_STATUS + 10;
                int stW = row.Right - stX - 8;
                bool showSong = p.State != 0 && p.Song != null && p.Song.Length > 0;

                if (showSong)
                {
                    TextRenderer.DrawText(g, stateWord, fontSmall,
                        new Rectangle(stX, row.Y + 4, stW, 13),
                        Color.FromArgb(140, 140, 150),
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

                    TextRenderer.DrawText(g, p.Song, fontSmall,
                        new Rectangle(stX, row.Y + 17, stW, 13),
                        Color.FromArgb(232, 232, 238),
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                }
                else
                {
                    TextRenderer.DrawText(g, stateWord, fontSmall,
                        new Rectangle(stX, row.Y, stW, ROW_H),
                        Color.FromArgb(148, 148, 158),
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                }

                y += ROW_H;
            }
        }

        Button MakeButton(string text, int x, int y, int w)
        {
            Button b = new Button();
            b.Text = text;
            b.SetBounds(x, y, w, 38);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(38, 38, 46);
            b.FlatAppearance.MouseDownBackColor = Color.FromArgb(14, 14, 18);
            b.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            b.Cursor = Cursors.Hand;
            return b;
        }

        /** Boton cuadrado con el icono "copy" de Lucide; al copiar pasa a "check". */
        Button MakeCopyButton(int x, int y, int size, Color surface, string tip)
        {
            int icon = size >= 24 ? 14 : 12;

            Button b = new Button();
            b.Text = "";
            b.SetBounds(x, y, size, size);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(26, 26, 32);
            b.FlatAppearance.MouseDownBackColor = Color.FromArgb(38, 38, 46);
            b.BackColor = surface;
            b.Image = Lucide.Render(Lucide.Copy, icon, Color.FromArgb(150, 150, 162));
            b.ImageAlign = ContentAlignment.MiddleCenter;
            b.Tag = new Image[] { b.Image, Lucide.Render(Lucide.Check, icon, Color.FromArgb(74, 190, 112)) };
            b.Cursor = Cursors.Hand;
            b.TabStop = false;
            tips.SetToolTip(b, tip);
            return b;
        }

        void CopyToClipboard(string text, Button source)
        {
            if (string.IsNullOrEmpty(text)) return;

            try
            {
                Clipboard.SetText(text);
                ShowCopied(source);
            }
            catch (Exception ex)
            {
                MessageBox.Show(L.T("copyFail") + "\n\n" + ex.Message,
                    "JD CONTROL", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void ShowCopied(Button b)
        {
            if (copyTimer == null)
            {
                copyTimer = new System.Windows.Forms.Timer();
                copyTimer.Interval = 1100;
                copyTimer.Tick += delegate
                {
                    copyTimer.Stop();
                    SetCopyIcon(copyButton, false);
                    copyButton = null;
                };
            }

            if (copyButton != null && copyButton != b) SetCopyIcon(copyButton, false);

            copyButton = b;
            SetCopyIcon(b, true);
            copyTimer.Stop();
            copyTimer.Start();
        }

        static void SetCopyIcon(Button b, bool copied)
        {
            Image[] icons = b == null ? null : b.Tag as Image[];
            if (icons != null) b.Image = icons[copied ? 1 : 0];
        }

        /** Activa/desactiva que la sala exija la IP ademas del codigo. */
        bool SetRequireIp(bool enabled)
        {
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Encoding = System.Text.Encoding.UTF8;
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";

                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["enabled"] = enabled;

                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    string json = ser.Serialize(body);
                    string res = wc.UploadString(BASE + "/api/online/require-ip", "POST", json);

                    Dictionary<string, object> st = ser.Deserialize<Dictionary<string, object>>(res);
                    return st == null || !st.ContainsKey("ok") || Convert.ToBoolean(st["ok"]);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(L.T("copyFail") + "\n\n" + ex.Message,
                    "JD CONTROL", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
        }


        void BuildTray()
        {
            trayIcon = appIcon != null ? appIcon : MakeFallbackIcon();

            ContextMenuStrip menu = new ContextMenuStrip();
            // Exactamente el mismo fondo que el exe; el menu no se queda blanco.
            menu.Renderer = new ToolStripProfessionalRenderer(new DarkMenuColors());
            menu.BackColor = BackColor;
            menu.ForeColor = Color.FromArgb(230, 230, 236);
            menu.ShowImageMargin = false;
            menu.ShowCheckMargin = false;
            menu.Font = new Font("Segoe UI", 9f);

            menu.Items.Add(L.T("trayShow"), null, delegate { RestoreFromTray(); });
            menu.Items.Add(L.T("joinRoom"), null, delegate { ShowJoinDialog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(L.T("trayExit"), null, delegate { RealExit(); });

            foreach (ToolStripItem it in menu.Items)
            {
                it.ForeColor = Color.FromArgb(230, 230, 236);
                if (it is ToolStripMenuItem) it.Padding = new Padding(8, 2, 8, 2);
            }

            tray = new NotifyIcon();
            tray.Icon = trayIcon;
            tray.Text = "JD CONTROL";
            tray.Visible = true;
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) RestoreFromTray();
            };
        }

        static Icon MakeFallbackIcon()
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (Brush bg = new SolidBrush(Color.FromArgb(12, 12, 15)))
                    g.FillEllipse(bg, 0, 0, 31, 31);
                using (Brush fg = new SolidBrush(Color.FromArgb(228, 228, 234)))
                    g.FillEllipse(fg, 8, 8, 16, 16);
            }
            IntPtr h = bmp.GetHicon();
            return Icon.FromHandle(h);
        }

        /* ------------------------------------------------------------ */
        /*  Servidor                                                     */
        /* ------------------------------------------------------------ */
        /* Lo minimo que tiene que estar junto al exe para que arranque el servidor.
           Si se comparte solo el .exe, el servidor no existe y nada funciona. */
        static readonly string[] REQUIRED_FILES = {
            "server.js", "cloudflared.exe",
            @"src\gamephone.js",
            @"public\mobile.html", @"public\mobile.js",
            @"node_modules\ws\package.json", @"node_modules\qrcode\package.json",
            @"node_modules\selfsigned\package.json",
        };

        static List<string> MissingFiles()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            List<string> missing = new List<string>();
            foreach (string f in REQUIRED_FILES)
                if (!File.Exists(Path.Combine(dir, f))) missing.Add(f);
            return missing;
        }

        static string MissingFilesText(List<string> missing)
        {
            return L.T("missingFiles") + "\n\n  " +
                string.Join("\n  ", missing.ToArray()) + "\n\n" +
                L.T("missingHelp") + AppDomain.CurrentDomain.BaseDirectory;
        }

        /** node.exe incluido en runtime\ (paquete para compartir) o el instalado. */
        static string NodePath()
        {
            string bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime", "node.exe");
            return File.Exists(bundled) ? bundled : "node";
        }

        void EnsureServer()
        {
            if (TryGetState() != null) { serverExternal = true; return; }

            List<string> missing = MissingFiles();
            if (missing.Count > 0)
            {
                LogServer("faltan archivos: " + string.Join(", ", missing.ToArray()));
                if (!serverErrorShown)
                {
                    serverErrorShown = true;
                    MessageBox.Show(MissingFilesText(missing), "JD CONTROL",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = NodePath();
                psi.Arguments = "server.js";
                psi.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                serverProc = Process.Start(psi);

                // Sin esto un fallo de arranque es invisible: queda en logs/server.log
                serverProc.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { LogServer(e.Data); };
                serverProc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { LogServer(e.Data); };
                serverProc.BeginOutputReadLine();
                serverProc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                if (!serverErrorShown)
                {
                    serverErrorShown = true;
                    MessageBox.Show("No se pudo iniciar el servidor: falta Node.js.\n\n" +
                        "Usa el paquete que trae runtime\\node.exe, o instala Node.js desde nodejs.org.\n\n" + ex.Message,
                        "JD CONTROL", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return;
            }

            for (int i = 0; i < 40; i++)
            {
                Thread.Sleep(150);
                if (TryGetState() != null) return;
            }
        }

        void StartPolling()
        {
            Thread t = new Thread(delegate ()
            {
                int fails = 0;

                while (running)
                {
                    Dictionary<string, object> st = TryGetState();
                    if (st != null)
                    {
                        fails = 0;
                        serverExternal = serverProc == null;
                        try { BeginInvoke(new Action<Dictionary<string, object>>(ApplyState), st); }
                        catch { }
                    }
                    else
                    {
                        fails++;

                        // El servidor se cayó (o nunca llegó a arrancar): reintentar
                        // en vez de quedarse con el panel muerto.
                        bool dead = serverProc == null || serverProc.HasExited;
                        if (fails >= 2 && dead &&
                            (DateTime.Now - lastServerRetry).TotalSeconds > 10)
                        {
                            lastServerRetry = DateTime.Now;
                            EnsureServer();
                        }
                    }
                    Thread.Sleep(1000);
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        Dictionary<string, object> TryGetState()
        {
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Encoding = System.Text.Encoding.UTF8;
                    // Sin cache: el panel tiene que ver los moviles en cuanto entran
                    wc.CachePolicy = new System.Net.Cache.HttpRequestCachePolicy(System.Net.Cache.HttpRequestCacheLevel.NoCacheNoStore);
                    wc.Headers[HttpRequestHeader.CacheControl] = "no-cache";
                    wc.Headers[HttpRequestHeader.Pragma] = "no-cache";

                    string json = wc.DownloadString(BASE + "/api/state");
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> st = ser.Deserialize<Dictionary<string, object>>(json);

                    LogPanel("ok pid=" + Str(st, "pid") + " code=" + Str(st, "code") + " phones=" + PhoneCount(st) + " bytes=" + json.Length);
                    return st;
                }
            }
            catch (Exception ex)
            {
                LogPanel("ERROR " + ex.GetType().Name + ": " + ex.Message);
                return null;
            }
        }

        static string Str(Dictionary<string, object> st, string key)
        {
            if (!st.ContainsKey(key) || st[key] == null) return "-";
            return st[key].ToString();
        }

        static string Val(Dictionary<string, object> st, string key)
        {
            if (st == null || !st.ContainsKey(key) || st[key] == null) return "";
            return st[key].ToString();
        }

        /* JavaScriptSerializer devuelve ArrayList (no object[]) para los arrays,
           por eso el panel nunca veia los moviles. Esto lo normaliza. */
        static List<object> AsList(object value)
        {
            List<object> list = new List<object>();
            if (value == null || value is string) return list;

            System.Collections.IEnumerable en = value as System.Collections.IEnumerable;
            if (en == null) return list;

            foreach (object item in en) list.Add(item);
            return list;
        }

        static bool AsBool(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return false;
            try { return Convert.ToBoolean(d[key]); } catch { return false; }
        }

        static double AsNumber(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return 0;
            try { return Convert.ToDouble(d[key]); } catch { return 0; }
        }

        static bool IsAscii(string s)
        {
            if (s == null) return true;
            foreach (char c in s)
            {
                if (c < 0x20 || c > 0x7E) return false;
            }
            return true;
        }

        static int PhoneCount(Dictionary<string, object> st)
        {
            if (!st.ContainsKey("phones")) return 0;
            return AsList(st["phones"]).Count;
        }

        static string lastPanelLog = "";
        static bool logsSending;

        /* ------------------------------------------------------------ */
        /*  Envio de logs al Discord (solo si el usuario lo activa)     */
        /* ------------------------------------------------------------ */

        static string WebhookFile()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webhook.txt");
        }

        /** URL del webhook de Discord; las lineas con # son comentarios. */
        static string WebhookUrl()
        {
            try
            {
                string file = WebhookFile();
                if (!File.Exists(file)) return "";
                foreach (string raw in File.ReadAllLines(file))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    if (line.StartsWith("https://")) return line;
#if LOGS_TEST
                    // Solo en la compilacion de prueba del envio de logs.
                    if (line.StartsWith("http://127.0.0.1:") || line.StartsWith("http://localhost:")) return line;
#endif
                }
            }
            catch { }
            return "";
        }

        /** Ultimos bytes de un log (Discord limita el tamaño por archivo). */
        static string ReadTail(string file, int maxBytes)
        {
            try
            {
                if (!File.Exists(file)) return null;
                using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    long length = fs.Length;
                    long start = Math.Max(0, length - maxBytes);
                    fs.Seek(start, SeekOrigin.Begin);
                    byte[] buf = new byte[length - start];
                    int off = 0;
                    while (off < buf.Length)
                    {
                        int n = fs.Read(buf, off, buf.Length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                    return System.Text.Encoding.UTF8.GetString(buf, 0, off);
                }
            }
            catch { return null; }
        }

        static string LogsSummary(string reason)
        {
            return "**JD CONTROL · logs**\n" +
                "Motivo: " + reason + "\n" +
                "Version: " + APP_VERSION + " " + APP_CHANNEL + "\n" +
                "Idioma: " + Settings.Lang + "\n" +
                "Windows: " + Environment.OSVersion.VersionString +
                " (" + (Environment.Is64BitOperatingSystem ? "64" : "32") + " bits)\n" +
                "Equipo: " + Environment.MachineName + "\n" +
                "Fecha: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\n" +
                "Server PID: " + (serverProc != null ? serverProc.Id.ToString() : "n/d");
        }

        /** Envia los logs en segundo plano; done recibe el estado para la UI. */
        static void SendLogs(string reason, Action<string> done)
        {
            if (logsSending)
            {
                if (done != null) done(L.T("logsSending"));
                return;
            }

            string hook = WebhookUrl();
            if (hook.Length == 0)
            {
                if (done != null) done(L.T("logsNoHook"));
                return;
            }

            logsSending = true;
            if (done != null) done(L.T("logsSending"));

            ThreadPool.QueueUserWorkItem(delegate
            {
                string status;
                try
                {
                    string err = UploadLogs(hook, reason);
                    status = err == null ? L.T("logsSent") : L.F("logsFail", err);
                    LogPanel("logs: " + (err == null ? "enviados (" + reason + ")" : "fallo " + err));
                }
                catch (Exception ex)
                {
                    status = L.F("logsFail", ex.Message);
                    LogPanel("logs: fallo " + ex.Message);
                }
                logsSending = false;
                if (done != null) { try { done(status); } catch { } }
            });
        }

        /** POST multipart al webhook. null si fue bien; texto si fallo. */
        static string UploadLogs(string hook, string reason)
        {
            string logs = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
            string[][] files = new string[][] {
                new string[] { "server.log", Path.Combine(logs, "server.log") },
                new string[] { "ghost.log",  Path.Combine(logs, "ghost.log") },
                new string[] { "score.log",  Path.Combine(logs, "score.log") },
                new string[] { "panel.log",  Path.Combine(logs, "panel.log") },
                new string[] { "ui.jsonl",   Path.Combine(logs, "ui.jsonl") },
            };

            const int MAX = 1024 * 1024; // 1 MB por archivo
            string boundary = "----JDControl" + DateTime.UtcNow.Ticks.ToString("x");

            JavaScriptSerializer ser = new JavaScriptSerializer();
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["content"] = LogsSummary(reason);
            byte[] payloadJson = System.Text.Encoding.UTF8.GetBytes(ser.Serialize(payload));

            using (MemoryStream body = new MemoryStream())
            {
                Action<string> text = delegate (string s)
                {
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(s);
                    body.Write(b, 0, b.Length);
                };

                text("--" + boundary + "\r\n");
                text("Content-Disposition: form-data; name=\"payload_json\"\r\n");
                text("Content-Type: application/json\r\n\r\n");
                body.Write(payloadJson, 0, payloadJson.Length);
                text("\r\n");

                int index = 0;
                foreach (string[] f in files)
                {
                    string content = ReadTail(f[1], MAX);
                    if (content == null || content.Length == 0) continue;

                    text("--" + boundary + "\r\n");
                    text("Content-Disposition: form-data; name=\"files[" + index + "]\"; filename=\"" + f[0] + "\"\r\n");
                    text("Content-Type: text/plain; charset=utf-8\r\n\r\n");
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(content);
                    body.Write(b, 0, b.Length);
                    text("\r\n");
                    index++;
                }

                text("--" + boundary + "--\r\n");

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(hook);
                req.Method = "POST";
                req.ContentType = "multipart/form-data; boundary=" + boundary;
                req.UserAgent = "JD CONTROL/" + APP_VERSION;
                req.Timeout = 25000;
                req.ReadWriteTimeout = 25000;
                req.ContentLength = body.Length;

                using (Stream s = req.GetRequestStream())
                    body.WriteTo(s);

                try
                {
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        int code = (int)resp.StatusCode;
                        return code >= 200 && code < 300 ? null : "HTTP " + code;
                    }
                }
                catch (WebException ex)
                {
                    HttpWebResponse resp = ex.Response as HttpWebResponse;
                    if (resp == null) return ex.Message;
                    try
                    {
                        using (StreamReader r = new StreamReader(resp.GetResponseStream()))
                        {
                            string detail = r.ReadToEnd();
                            if (detail.Length > 300) detail = detail.Substring(0, 300);
                            return "HTTP " + (int)resp.StatusCode + " " + detail;
                        }
                    }
                    catch { return "HTTP " + (int)resp.StatusCode; }
                }
            }
        }

        /** Salida de node (arranque, errores) en logs/server.log. */
        static void LogServer(string line)
        {
            if (line == null) return;

            try
            {
                string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
                Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "server.log");

                FileInfo fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 512 * 1024) File.WriteAllText(file, "");

                File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss") + "  " + line + Environment.NewLine);
            }
            catch { }
        }

        static void LogPanel(string line)
        {
            if (line == lastPanelLog) return; // solo cambios, para no llenar el disco
            lastPanelLog = line;

            try
            {
                string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
                Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "panel.log");

                FileInfo fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 256 * 1024) File.WriteAllText(file, "");

                File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss") + "  " + line + Environment.NewLine);
            }
            catch { }
        }

        void SendRoom(bool open)
        {
            try
            {
                using (WebClient wc = new WebClient())
                {
                    if (open) wc.UploadString(BASE + "/api/room", "POST", "");
                    else
                    {
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                        wc.UploadString(BASE + "/api/room", "DELETE", "");
                    }
                }
            }
            catch (Exception ex)
            {
                List<string> missing = MissingFiles();
                if (missing.Count > 0)
                {
                    MessageBox.Show(MissingFilesText(missing), "JD CONTROL",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                MessageBox.Show(L.T("serverFail") + "\n\n" + ex.Message +
                    "\n\nlogs\\server.log",
                    "JD CONTROL", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /* ------------------------------------------------------------ */
        /*  Unirse a una sala online                                     */
        /* ------------------------------------------------------------ */
        void ShowJoinDialog()
        {
            Form dlg = new Form();
            dlg.Text = L.T("joinTitleShort");
            dlg.ClientSize = new Size(380, 270);
            dlg.FormBorderStyle = FormBorderStyle.None;
            dlg.MaximizeBox = false;
            dlg.MinimizeBox = false;
            dlg.StartPosition = FormStartPosition.CenterParent;
            dlg.BackColor = BackColor;
            dlg.ForeColor = Color.FromArgb(232, 232, 238);
            dlg.Font = new Font("Segoe UI", 9f);
            dlg.AutoScaleMode = AutoScaleMode.None;
            dlg.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen border = new Pen(Color.FromArgb(30, 30, 36)))
                    e.Graphics.DrawRectangle(border, 0, 0, dlg.ClientSize.Width - 1, dlg.ClientSize.Height - 1);
            };

            Panel dlgCaption = new Panel();
            dlgCaption.SetBounds(0, 0, 380, CAPTION_H);
            dlgCaption.BackColor = BackColor;

            Label captionTitle = new Label();
            captionTitle.Text = dlg.Text;
            captionTitle.Font = new Font("Segoe UI", 9f);
            captionTitle.ForeColor = Color.FromArgb(230, 230, 236);
            captionTitle.TextAlign = ContentAlignment.MiddleLeft;
            captionTitle.SetBounds(12, 0, 280, CAPTION_H);

            Button captionClose = MakeCaptionButton("✕", 380 - 46, 9.5f);
            captionClose.Click += delegate { dlg.DialogResult = DialogResult.Cancel; dlg.Close(); };

            MouseEventHandler dragDialog = delegate (object s, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(dlg.Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
            };
            dlgCaption.MouseDown += dragDialog;
            captionTitle.MouseDown += dragDialog;
            dlgCaption.Controls.Add(captionTitle);
            dlgCaption.Controls.Add(captionClose);

            Label title = new Label();
            title.Text = JdText(L.T("joinTitle"));
            title.Font = JdFont(15f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(244, 244, 249);
            title.SetBounds(24, 50, 332, 24);

            Label lHost = new Label();
            lHost.Text = L.T("joinHost");
            lHost.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lHost.ForeColor = Color.FromArgb(126, 126, 138);
            lHost.SetBounds(24, 86, 332, 14);

            TextBox tbHost = new TextBox();
            tbHost.Text = lastOnlineHost;
            tbHost.SetBounds(24, 104, 332, 26);
            tbHost.BackColor = Color.FromArgb(20, 20, 24);
            tbHost.ForeColor = Color.FromArgb(238, 238, 243);
            tbHost.BorderStyle = BorderStyle.FixedSingle;
            tbHost.Font = new Font("Consolas", 10f);
            tips.SetToolTip(tbHost, L.T("joinTip"));

            Label lCode = new Label();
            lCode.Text = L.T("code");
            lCode.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lCode.ForeColor = Color.FromArgb(126, 126, 138);
            lCode.SetBounds(24, 142, 160, 14);

            TextBox tbCode = new TextBox();
            tbCode.Text = onlineRole == "member" ? onlineCode : "";
            tbCode.SetBounds(24, 160, 160, 26);
            tbCode.MaxLength = 5;
            tbCode.BackColor = Color.FromArgb(20, 20, 24);
            tbCode.ForeColor = Color.FromArgb(238, 238, 243);
            tbCode.BorderStyle = BorderStyle.FixedSingle;
            tbCode.Font = new Font("Consolas", 12f, FontStyle.Bold);
            tbCode.TextAlign = HorizontalAlignment.Center;

            Button ok = MakeDialogButton(L.T("joinOk"), 24, 208, 160);
            ok.BackColor = Color.FromArgb(34, 34, 40);
            ok.ForeColor = Color.FromArgb(244, 244, 249);
            ok.FlatAppearance.BorderColor = ok.BackColor;

            Button cancel = MakeDialogButton(L.T("cancel"), 196, 208, 160);
            cancel.BackColor = Color.FromArgb(18, 18, 22);
            cancel.ForeColor = Color.FromArgb(210, 210, 218);
            cancel.FlatAppearance.BorderColor = cancel.BackColor;

            ok.Click += delegate
            {
                string h = tbHost.Text.Trim();
                string c = tbCode.Text.Replace(" ", "").Trim();

                // Sin IP/URL el servidor busca la sala por codigo en la red local.
                bool digits = c.Length == 5;
                foreach (char ch in c)
                {
                    if (ch < '0' || ch > '9') { digits = false; break; }
                }
                if (!digits)
                {
                    MessageBox.Show(L.T("joinBadCode"), L.T("joinTitleShort"),
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                // Un dominio público puede tardar en responder: se espera fuera del hilo de la ventana.
                ok.Enabled = false;
                tbHost.Enabled = false;
                tbCode.Enabled = false;
                ok.Text = L.T("joinWait");

                ThreadPool.QueueUserWorkItem(delegate
                {
                    string err = JoinRoom(h, c);
                    try
                    {
                        dlg.BeginInvoke(new Action(delegate
                        {
                            if (dlg.IsDisposed) return;
                            ok.Enabled = true;
                            tbHost.Enabled = true;
                            tbCode.Enabled = true;
                            ok.Text = L.T("joinOk");

                            if (err != null)
                            {
                                MessageBox.Show(dlg, err, L.T("joinTitleShort"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
                                return;
                            }

                            lastOnlineHost = h;
                            dlg.DialogResult = DialogResult.OK;
                            dlg.Close();
                        }));
                    }
                    catch { }
                });
            };

            cancel.Click += delegate { dlg.DialogResult = DialogResult.Cancel; dlg.Close(); };

            dlg.Controls.Add(title);
            dlg.Controls.Add(lHost);
            dlg.Controls.Add(tbHost);
            dlg.Controls.Add(lCode);
            dlg.Controls.Add(tbCode);
            dlg.Controls.Add(ok);
            dlg.Controls.Add(cancel);
            dlg.Controls.Add(dlgCaption);
            dlgCaption.BringToFront();

            dlg.AcceptButton = ok;
            dlg.CancelButton = cancel;
            dlg.ShowDialog(this);
        }

        Button MakeDialogButton(string text, int x, int y, int w)
        {
            Button b = new Button();
            b.Text = text;
            b.SetBounds(x, y, w, 36);
            b.FlatStyle = FlatStyle.Flat;
            b.UseVisualStyleBackColor = false;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.BorderColor = b.BackColor;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(38, 38, 46);
            b.FlatAppearance.MouseDownBackColor = Color.FromArgb(14, 14, 18);
            b.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            b.Cursor = Cursors.Hand;
            b.TabStop = false;
            return b;
        }

        string JoinRoom(string host, string code)
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Encoding = System.Text.Encoding.UTF8;
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";

                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["host"] = host;
                    body["code"] = code;

                    return JoinError(ser, wc.UploadString(BASE + "/api/online/join", "POST", ser.Serialize(body)));
                }
            }
            catch (WebException ex)
            {
                // El servidor responde 400 con el motivo en el JSON: WebClient lo
                // convierte en excepcion y antes solo se veia "(400) Bad Request".
                if (ex.Response != null)
                {
                    try
                    {
                        using (StreamReader sr = new StreamReader(ex.Response.GetResponseStream(), System.Text.Encoding.UTF8))
                        {
                            string err = JoinError(ser, sr.ReadToEnd());
                            if (err != null) return err;
                        }
                    }
                    catch { }
                }
                return "No se pudo unir a la sala.\n\n" + ex.Message;
            }
            catch (Exception ex)
            {
                return "No se pudo unir a la sala.\n\n" + ex.Message;
            }
        }

        static string JoinError(JavaScriptSerializer ser, string json)
        {
            Dictionary<string, object> st = ser.Deserialize<Dictionary<string, object>>(json);
            if (st != null && st.ContainsKey("ok") && !Convert.ToBoolean(st["ok"]))
                return st.ContainsKey("error") && st["error"] != null ? st["error"].ToString() : "No se pudo unir a la sala.";
            return null;
        }

        /* ------------------------------------------------------------ */
        /*  Estado                                                       */
        /* ------------------------------------------------------------ */
        void ApplyState(Dictionary<string, object> st)
        {
            lastState = st;
            string code = st.ContainsKey("code") ? (st["code"] == null ? "" : st["code"].ToString()) : "";

            // El enlace del movil: si el tunel esta listo manda ese, porque
            // funciona desde cualquier red.
            Dictionary<string, object> tun = st.ContainsKey("tunnel")
                ? st["tunnel"] as Dictionary<string, object> : null;
            tunnelActive = tun != null && AsBool(tun, "active");
            tunnelBase = tun != null ? Val(tun, "url").TrimEnd('/') : "";
            tunnelState = tun != null ? Val(tun, "state") : "idle";
            tunnelError = tun != null ? Val(tun, "error") : "";

            string localUrl = Val(st, "url");
            string localIp = Val(st, "primaryIP");
            bool usingTunnel = code.Length == 5 && tunnelActive && tunnelBase != "";
            string shareUrl = usingTunnel
                ? tunnelBase + "/m?code=" + code
                : (code.Length == 5 ? localUrl : "");

            // La IP se muestra tal cual, sin https:// ni puerto.

            SetTunnelStatus(usingTunnel, code);

            if (code != currentCode)
            {
                currentCode = code;
                lblCode.Text = code.Length == 5 ? string.Join(" ", code.ToCharArray()) : "-----";
                currentUrl = "";
            }

            if (shareUrl != "")
            {
                if (shareUrl != currentUrl)
                {
                    currentUrl = shareUrl;
                    LoadQr(shareUrl);
                }
            }
            else if (currentUrl != "")
            {
                currentUrl = "";
                picQr.Image = null;
            }

            currentIp = localIp;
            // Se muestra la direccion publica sin el codigo (ya esta arriba);
            // el QR y "copiar enlace" llevan el enlace completo.
            lblUrl.Text = usingTunnel ? tunnelBase + "/m" : localIp;
            tips.SetToolTip(lblUrl, usingTunnel ? shareUrl : localIp);

            // Un solo boton de copiar: enlace si hay tunel, IP si no hay tunel.
            bool showLink = usingTunnel && currentUrl.Length > 0;
            btnCopyLink.Visible = showLink;
            btnCopyIp.Visible = !showLink && currentIp.Length > 0;

            btnCopyCode.Enabled = currentCode.Length == 5;

            Dictionary<string, object> on = st.ContainsKey("online") ? st["online"] as Dictionary<string, object> : null;
            onlineRole = Val(on, "role");
            onlineCode = Val(on, "code");
            bool onlineConnected = AsBool(on, "connected");
            bool onlineAdmin = AsBool(on, "admin");
            string onlineError = Val(on, "error");
            bool requireIp = AsBool(on, "requireIp");

            // La casilla solo manda si este PC es el anfitrion.
            suppressRequireIp = true;
            chkRequireIp.Enabled = onlineRole == "host";
            chkRequireIp.Checked = onlineRole == "host" && requireIp;
            suppressRequireIp = false;

            if (onlineRole == "host")
            {
                lblSub.Text = L.T("subHost");
            }
            else if (onlineRole == "member")
            {
                lblSub.Text = L.F("subMember", (onlineCode.Length == 5 ? onlineCode : "-----")) +
                    (onlineConnected ? " · " + L.T("connectedTag") : " · " + L.T("connectingTag")) +
                    (onlineAdmin ? " · " + L.T("adminTag") : "");
            }
            else
            {
                lblSub.Text = L.T("subLocal");
            }

            int connected = 0;
            int playing = 0;
            List<PlayerRow> rows = new List<PlayerRow>();

            if (st.ContainsKey("phones"))
            {
                List<object> phones = AsList(st["phones"]);
                int localIndex = 0;

                foreach (object o in phones)
                {
                    Dictionary<string, object> p = o as Dictionary<string, object>;
                    if (p == null) continue;

                    // Movil emparejado con un PC de la sala: sale en la fila de ese PC.
                    if (Val(p, "owner") != "") continue;

                    bool c = AsBool(p, "connected");
                    bool s = AsBool(p, "sending");
                    if (c) connected++;
                    if (s) playing++;

                    PlayerRow r = new PlayerRow();
                    r.Name = p.ContainsKey("name") && p["name"] != null ? p["name"].ToString().Trim() : "";
                    if (r.Name == "") r.Name = "user";
                    r.AsciiName = IsAscii(r.Name);
                    r.Admin = onlineRole == "host" && localIndex == 0;
                    r.Ready = localIndex == 0 && AsBool(on, "localReady");
                    r.Online = onlineRole != "" && localIndex == 0;
                    r.Pc = p.ContainsKey("pc") ? AsBool(p, "pc") : localIndex == 0;
                    r.Phone = true;

                    r.Song = p.ContainsKey("song") && p["song"] != null ? p["song"].ToString().Trim() : null;
                    if (r.Song != null && r.Song.Length == 0) r.Song = null;

                    r.AvatarUrl = p.ContainsKey("avatarUrl") && p["avatarUrl"] != null ? p["avatarUrl"].ToString().Trim() : null;
                    if (r.AvatarUrl != null && r.AvatarUrl.Length == 0) r.AvatarUrl = null;
                    if (r.AvatarUrl != null) EnsureAvatar(r.AvatarUrl);

                    r.State = !c ? 0 : (s ? 2 : 1);
                    rows.Add(r);
                    localIndex++;
                }
            }

            // PCs conectados a la sala online (el anfitrión no se duplica)
            if (on != null && on.ContainsKey("members"))
            {
                foreach (object o in AsList(on["members"]))
                {
                    Dictionary<string, object> m = o as Dictionary<string, object>;
                    if (m == null) continue;

                    bool mc = AsBool(m, "connected");
                    string phase = Val(m, "phase");

                    PlayerRow r = new PlayerRow();
                    r.Name = Val(m, "name").Trim();
                    if (r.Name == "") r.Name = "user";
                    r.AsciiName = IsAscii(r.Name);
                    r.Admin = AsBool(m, "admin");
                    r.Ready = AsBool(m, "ready");
                    r.Online = true;
                    r.Pc = !m.ContainsKey("pc") || AsBool(m, "pc");
                    r.Phone = AsBool(m, "phone");

                    r.Song = Val(m, "song").Trim();
                    if (r.Song.Length == 0) r.Song = null;

                    r.State = !mc || phase == "offline" ? 0 : (phase == "dancing" ? 2 : 1);

                    rows.Add(r);
                    if (mc) connected++;
                    if (r.State == 2) playing++;
                }
            }

            // Mandos, Kinect y camara que ve este PC (solo lectura, los detecta
            // el servidor). Un mando normal solo sirve para menus: sale atenuado.
            if (st.ContainsKey("devices"))
            {
                Dictionary<string, object> dv = st["devices"] as Dictionary<string, object>;
                if (dv != null && dv.ContainsKey("devices"))
                {
                    foreach (object o in AsList(dv["devices"]))
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d == null) continue;

                        string kind = Val(d, "kind");
                        if (kind.Length == 0) continue;

                        PlayerRow r = new PlayerRow();
                        r.Name = DeviceLabel(kind);
                        r.AsciiName = IsAscii(r.Name);
                        r.Device = kind;
                        r.Dance = AsBool(d, "dance");
                        r.State = 1;
                        r.StateText = r.Dance ? L.T("devDance") : L.T("devMenusOnly");

                        // Segunda linea: el modelo real que da Windows.
                        string model = Val(d, "name").Trim();
                        r.Song = model.Length > 0 ? model : null;

                        rows.Add(r);
                        if (r.Dance) connected++; // el mando normal no puntua
                    }
                }
            }

            int total = rows.Count;

            int readyCount = on == null ? 0 : (int)AsNumber(on, "readyCount");
            int totalCount = on == null ? 0 : (int)AsNumber(on, "totalCount");
            string onlineHint = Val(on, "hint");
            if (onlineError.Length > 0) lblGame.Text = L.F("roomError", onlineError);
            else if (onlineHint.Contains("otro mando") || onlineHint.Contains("cancelado") ||
                     onlineHint.Contains("no pudo") || onlineHint.Contains("rechazó") ||
                     onlineHint.Contains("no confirmó"))
                lblGame.Text = onlineHint;
            else if (onlineRole != "" && readyCount > 0 && playing == 0)
                lblGame.Text = AsNumber(on, "startAt") > 0
                    ? L.T("roomStarting")
                    : L.F("roomReadyWait", readyCount, totalCount);
            else if (total == 0 || connected == 0) lblGame.Text = L.T("gameWaiting");
            else if (playing > 0) lblGame.Text = L.F("gameDancing", playing);
            else lblGame.Text = L.F("gameConnected", connected);

            string pid = Str(st, "pid");
            lblPlayers.Text = L.T("players") + " (" + total + ")" +
                (pid != "-" ? "   ·   " + L.T("serverTag") + " #" + pid : "");

            playersEmpty = rows.Count == 0;

            List<string> sig = new List<string>();
            foreach (PlayerRow r in rows) sig.Add(r.Signature);

            string signature = playersEmpty ? "empty" : string.Join("\n", sig.ToArray());
            if (signature != lastPlayersSignature)
            {
                lastPlayersSignature = signature;
                playerRows = rows;
                pnlPlayers.Invalidate();
            }
        }

        /** Nombre corto del tipo de dispositivo (el modelo va en la 2a linea). */
        string DeviceLabel(string kind)
        {
            switch (kind)
            {
                case "kinect": return L.T("devKinect");
                case "camera": return L.T("devCamera");
                case "joycon": return L.T("devJoycon");
                case "wiimote": return L.T("devWiimote");
                case "psmove": return L.T("devPsmove");
                case "ds4": return L.T("devDs4");
                default: return L.T("devPad");
            }
        }

        void EnsureAvatar(string url)
        {
            if (url == null || url.Length == 0) return;
            if (avatarCache.ContainsKey(url) || avatarPending.Contains(url) || avatarFailed.Contains(url)) return;

            avatarPending.Add(url);
            ThreadPool.QueueUserWorkItem(delegate { LoadAvatar(url); });
        }

        void LoadAvatar(string url)
        {
            Bitmap small = null;
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.CachePolicy = new System.Net.Cache.HttpRequestCachePolicy(System.Net.Cache.HttpRequestCacheLevel.NoCacheNoStore);
                    byte[] data = wc.DownloadData(BASE + url);

                    using (MemoryStream ms = new MemoryStream(data))
                    using (Image raw = Image.FromStream(ms))
                    {
                        small = new Bitmap(40, 40);
                        using (Graphics g = Graphics.FromImage(small))
                        using (System.Drawing.Drawing2D.GraphicsPath clip = new System.Drawing.Drawing2D.GraphicsPath())
                        {
                            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            clip.AddEllipse(0, 0, 40, 40);
                            g.SetClip(clip);
                            g.DrawImage(raw, 0, 0, 40, 40);
                        }
                    }
                }
            }
            catch
            {
                small = null;
            }

            Bitmap loaded = small;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    avatarPending.Remove(url);
                    if (loaded != null) avatarCache[url] = loaded;
                    else avatarFailed.Add(url);
                    pnlPlayers.Invalidate();
                }));
            }
            catch
            {
                if (loaded != null) loaded.Dispose();
            }
        }

        /** Linea inferior: "creando sala..." / "sala creada: online activo". */
        void SetTunnelStatus(bool usingTunnel, string code)
        {
            if (usingTunnel)
            {
                SetTunnelLine(L.T("stCreated"), L.T("stOnline"), Color.FromArgb(150, 150, 162));
                return;
            }

            if (tunnelState == "starting")
            {
                SetTunnelLine(L.T("stCreating"), "", Color.FromArgb(160, 160, 172));
                return;
            }

            if (tunnelError != "")
            {
                SetTunnelLine(L.F("stTunnelError", tunnelError), "", Color.FromArgb(196, 120, 120));
                return;
            }

            string text = code.Length != 5 ? L.T("stOpenFirst") : L.T("stNoTunnel");
            SetTunnelLine(text, "", Color.FromArgb(110, 110, 120));
        }

        /** Centra la frase y, si hay segunda parte, la pinta en verde detras. */
        void SetTunnelLine(string left, string green, Color leftColor)
        {
            lblTunnel.Text = left;
            lblTunnel.ForeColor = leftColor;

            int leftWidth = TextRenderer.MeasureText(left, lblTunnel.Font).Width;

            if (green.Length == 0)
            {
                lblTunnelOk.Visible = false;
                lblTunnel.SetBounds(24, 606, 372, 18);
                lblTunnel.TextAlign = ContentAlignment.MiddleCenter;
                return;
            }

            int greenWidth = TextRenderer.MeasureText(green, lblTunnelOk.Font).Width;
            int total = leftWidth + greenWidth;
            int start = 24 + (372 - total) / 2;
            if (start < 24) start = 24;

            lblTunnel.TextAlign = ContentAlignment.MiddleLeft;
            lblTunnel.SetBounds(start, 606, leftWidth + 4, 18);

            lblTunnelOk.Text = green;
            lblTunnelOk.Visible = true;
            lblTunnelOk.SetBounds(start + leftWidth, 606, greenWidth + 4, 18);
        }

        void LoadQr(string url)
        {
            try
            {
                using (WebClient wc = new WebClient())
                {
                    byte[] data = wc.DownloadData(BASE + "/api/qr?text=" + Uri.EscapeDataString(url));
                    using (MemoryStream ms = new MemoryStream(data))
                    {
                        Image old = picQr.Image;
                        picQr.Image = Image.FromStream(ms);
                        if (old != null) old.Dispose();
                    }
                }
            }
            catch { }
        }

        /* ------------------------------------------------------------ */
        /*  Ajustes (idioma y actualizaciones)                           */
        /* ------------------------------------------------------------ */
        void ShowSettingsDialog()
        {
            Form dlg = new Form();
            dlg.Text = L.T("settings");
            dlg.ClientSize = new Size(380, 306);
            dlg.FormBorderStyle = FormBorderStyle.None;
            dlg.MaximizeBox = false;
            dlg.MinimizeBox = false;
            dlg.StartPosition = FormStartPosition.CenterParent;
            dlg.BackColor = BackColor;
            dlg.ForeColor = Color.FromArgb(232, 232, 238);
            dlg.Font = new Font("Segoe UI", 9f);
            dlg.AutoScaleMode = AutoScaleMode.None;
            dlg.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen border = new Pen(Color.FromArgb(30, 30, 36)))
                    e.Graphics.DrawRectangle(border, 0, 0, dlg.ClientSize.Width - 1, dlg.ClientSize.Height - 1);
            };

            Panel dlgCaption = new Panel();
            dlgCaption.SetBounds(0, 0, 380, CAPTION_H);
            dlgCaption.BackColor = BackColor;

            Label captionTitle = new Label();
            captionTitle.Text = dlg.Text;
            captionTitle.Font = new Font("Segoe UI", 9f);
            captionTitle.ForeColor = Color.FromArgb(230, 230, 236);
            captionTitle.TextAlign = ContentAlignment.MiddleLeft;
            captionTitle.SetBounds(12, 0, 280, CAPTION_H);

            Button captionClose = MakeCaptionButton("✕", 380 - 46, 9.5f);
            captionClose.Click += delegate { dlg.Close(); };

            MouseEventHandler dragDialog = delegate (object s, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(dlg.Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
            };
            dlgCaption.MouseDown += dragDialog;
            captionTitle.MouseDown += dragDialog;
            dlgCaption.Controls.Add(captionTitle);
            dlgCaption.Controls.Add(captionClose);

            Label title = new Label();
            title.Text = JdText(L.T("settings"));
            title.Font = JdFont(15f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(244, 244, 249);
            title.SetBounds(24, 50, 332, 24);

            Label lLang = new Label();
            lLang.Text = L.T("language");
            lLang.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lLang.ForeColor = Color.FromArgb(126, 126, 138);
            lLang.SetBounds(24, 86, 332, 14);

            // Desplegable propio: el ComboBox nativo pinta la flecha en blanco
            // y rompe el tema oscuro.
            Button cb = new Button();
            cb.Text = LangName(Settings.Lang);
            cb.TextAlign = ContentAlignment.MiddleLeft;
            cb.Padding = new Padding(10, 0, 26, 0);
            cb.SetBounds(24, 104, 332, 30);
            cb.FlatStyle = FlatStyle.Flat;
            cb.FlatAppearance.BorderSize = 1;
            cb.FlatAppearance.BorderColor = Color.FromArgb(44, 44, 52);
            cb.FlatAppearance.MouseOverBackColor = Color.FromArgb(30, 30, 36);
            cb.FlatAppearance.MouseDownBackColor = Color.FromArgb(22, 22, 28);
            cb.BackColor = Color.FromArgb(20, 20, 24);
            cb.ForeColor = Color.FromArgb(238, 238, 243);
            cb.Font = new Font("Segoe UI", 9.5f);
            cb.Cursor = Cursors.Hand;
            cb.Image = Lucide.Render(Lucide.ChevronDown, 14, Color.FromArgb(150, 150, 162));
            cb.ImageAlign = ContentAlignment.MiddleRight;

            ContextMenuStrip langMenu = new ContextMenuStrip();
            langMenu.Renderer = new ToolStripProfessionalRenderer(new DarkMenuColors());
            langMenu.BackColor = Color.FromArgb(16, 16, 20);
            langMenu.ForeColor = Color.FromArgb(232, 232, 238);
            langMenu.ShowImageMargin = false;
            langMenu.Font = new Font("Segoe UI", 9f);

            cb.Click += delegate { langMenu.Show(cb, new Point(0, cb.Height)); };

            CheckBox chk = new CheckBox();
            chk.Text = L.T("checkUpdates");
            chk.Checked = Settings.CheckUpdates;
            chk.Font = new Font("Segoe UI", 9f);
            chk.ForeColor = Color.FromArgb(220, 220, 228);
            chk.BackColor = BackColor;
            chk.FlatStyle = FlatStyle.Flat;
            chk.SetBounds(24, 148, 332, 22);

            CheckBox chkLogs = new CheckBox();
            chkLogs.Text = L.T("sendLogs");
            chkLogs.Checked = Settings.SendLogs;
            chkLogs.Font = new Font("Segoe UI", 9f);
            chkLogs.ForeColor = Color.FromArgb(220, 220, 228);
            chkLogs.BackColor = BackColor;
            chkLogs.FlatStyle = FlatStyle.Flat;
            chkLogs.SetBounds(24, 174, 332, 22);
            tips.SetToolTip(chkLogs, L.T("sendLogsTip"));

            Label lLogs = new Label();
            lLogs.Font = new Font("Segoe UI", 7.5f);
            lLogs.ForeColor = Color.FromArgb(126, 126, 138);
            lLogs.SetBounds(24, 198, 332, 16);
            lLogs.AutoEllipsis = true;
            lLogs.Text = WebhookUrl().Length == 0 && Settings.SendLogs
                ? L.T("logsNoHook")
                : (Settings.SendLogs ? "" : L.T("logsOff"));

            Label ver = new Label();
            ver.Text = L.T("version") + " " + APP_VERSION + " " + APP_CHANNEL;
            ver.Font = new Font("Segoe UI", 8f);
            ver.ForeColor = Color.FromArgb(120, 120, 132);
            ver.SetBounds(24, 220, 332, 16);

            Button ok = MakeDialogButton(L.T("close"), 24, 246, 332);
            ok.BackColor = Color.FromArgb(30, 30, 36);
            ok.ForeColor = Color.FromArgb(240, 240, 246);
            ok.FlatAppearance.BorderColor = ok.BackColor;
            ok.Click += delegate { dlg.Close(); };

            Action<string> pickLanguage = delegate (string code)
            {
                if (code == Settings.Lang) return;

                Settings.Lang = code;
                Settings.Save();
                L.Code = code;
                ApplyLanguage();

                cb.Text = LangName(code);
                dlg.Text = L.T("settings");
                captionTitle.Text = dlg.Text;
                title.Text = JdText(L.T("settings"));
                lLang.Text = L.T("language");
                chk.Text = L.T("checkUpdates");
                chkLogs.Text = L.T("sendLogs");
                tips.SetToolTip(chkLogs, L.T("sendLogsTip"));
                lLogs.Text = !Settings.SendLogs
                    ? L.T("logsOff")
                    : (WebhookUrl().Length == 0 ? L.T("logsNoHook") : lLogs.Text);
                ver.Text = L.T("version") + " " + APP_VERSION + " " + APP_CHANNEL;
                ok.Text = L.T("close");
            };

            foreach (string[] o in new string[][] {
                new string[] { L.EN, "English" },
                new string[] { L.ES, "Español" },
                new string[] { L.PT, "Portuguese (Brasil)" } })
            {
                string code = o[0];
                ToolStripMenuItem item = new ToolStripMenuItem(o[1]);
                item.ForeColor = Color.FromArgb(232, 232, 238);
                item.Click += delegate { pickLanguage(code); };
                langMenu.Items.Add(item);
            }

            chk.CheckedChanged += delegate
            {
                Settings.CheckUpdates = chk.Checked;
                Settings.Save();

                if (chk.Checked) CheckUpdates();
                else
                {
                    pendingUpdateUrl = "";
                    pendingUpdateTag = "";
                    lblUpdate.Visible = false;
                }
            };

            chkLogs.CheckedChanged += delegate
            {
                Settings.SendLogs = chkLogs.Checked;
                Settings.Save();

                if (!chkLogs.Checked)
                {
                    lLogs.Text = L.T("logsOff");
                    return;
                }
                if (WebhookUrl().Length == 0)
                {
                    lLogs.Text = L.T("logsNoHook");
                    return;
                }

                // El resultado llega desde otro hilo: se pinta en el hilo de UI.
                Action<string> sink = delegate (string msg)
                {
                    try
                    {
                        if (dlg.IsDisposed) return;
                        if (dlg.InvokeRequired)
                            dlg.BeginInvoke(new Action(delegate { if (!dlg.IsDisposed) lLogs.Text = msg; }));
                        else
                            lLogs.Text = msg;
                    }
                    catch { }
                };
                SendLogs("activado en configuracion", sink);
            };

            dlg.Controls.Add(dlgCaption);
            dlg.Controls.Add(title);
            dlg.Controls.Add(lLang);
            dlg.Controls.Add(cb);
            dlg.Controls.Add(chk);
            dlg.Controls.Add(chkLogs);
            dlg.Controls.Add(lLogs);
            dlg.Controls.Add(ver);
            dlg.Controls.Add(ok);
            dlg.AcceptButton = ok;
            dlg.CancelButton = ok;
            dlg.ShowDialog(this);
        }

        static string LangName(string code)
        {
            if (code == L.ES) return "Español";
            if (code == L.PT) return "Portuguese (Brasil)";
            return "English";
        }

        /** Reetiqueta el panel sin reiniciar al cambiar de idioma. */
        void ApplyLanguage()
        {
            lblCodeCaption.Text = L.T("code");
            chkRequireIp.Text = L.T("requireIp");
            btnOnline.Text = L.T("openServer");
            btnOffline.Text = L.T("closeServer");
            btnJoin.Text = L.T("joinRoom");
            lblPlayers.Text = L.T("players");
            lblSub.Text = L.T("subLocal");

            tips.SetToolTip(chkRequireIp, L.T("tipRequireIp"));
            tips.SetToolTip(btnOnline, L.T("tipOpen"));
            tips.SetToolTip(btnOffline, L.T("tipClose"));
            tips.SetToolTip(btnCopyCode, L.T("copyCode"));
            tips.SetToolTip(btnCopyLink, L.T("copyLink"));
            tips.SetToolTip(btnCopyIp, L.T("copyIp"));
            tips.SetToolTip(btnSettings, L.T("settingsTip"));

            if (lastState != null) ApplyState(lastState);
            else SetTunnelStatus(false, currentCode);

            if (pendingUpdateTag.Length > 0) ShowUpdateBanner();
            pnlPlayers.Invalidate();
        }

        /* ------------------------------------------------------------ */
        /*  Actualizaciones (releases del repo publico)                  */
        /* ------------------------------------------------------------ */
        void CheckUpdates()
        {
            string url = Settings.UpdateUrl.Length > 0 ? Settings.UpdateUrl : Settings.DEFAULT_UPDATE_URL;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    using (WebClient wc = new WebClient())
                    {
                        wc.Encoding = System.Text.Encoding.UTF8;
                        wc.Headers["User-Agent"] = "JD-CONTROL";
                        wc.Headers["Accept"] = "application/vnd.github+json";

                        string json = wc.DownloadString(url);
                        JavaScriptSerializer ser = new JavaScriptSerializer();
                        Dictionary<string, object> rel = ser.Deserialize<Dictionary<string, object>>(json);
                        if (rel == null) return;

                        string tag = Val(rel, "tag_name").Trim();
                        if (tag.Length == 0) return;
                        if (!IsNewer(tag, APP_VERSION)) return;

                        string page = Val(rel, "html_url").Trim();
                        pendingUpdateTag = tag;
                        pendingUpdateUrl = page.Length > 0
                            ? page
                            : "https://github.com/nxx-sudo/JD-Control/releases";

                        LogPanel("update: hay " + tag + " (actual " + APP_VERSION + ")");
                        try { BeginInvoke(new Action(ShowUpdateBanner)); } catch { }
                    }
                }
                catch (Exception ex)
                {
                    LogPanel("update: " + ex.Message);
                }
            });
        }

        void ShowUpdateBanner()
        {
            if (pendingUpdateTag.Length == 0) return;
            if (!Settings.CheckUpdates) return;

            lblUpdate.Text = L.F("updateAvailable", pendingUpdateTag);
            tips.SetToolTip(lblUpdate, L.T("updateHint"));
            lblUpdate.Visible = true;
        }

        static bool IsNewer(string tag, string current)
        {
            int[] a = VersionParts(tag);
            int[] b = VersionParts(current);

            for (int i = 0; i < 3; i++)
            {
                if (a[i] != b[i]) return a[i] > b[i];
            }
            return false;
        }

        static int[] VersionParts(string text)
        {
            int[] parts = new int[3];
            string digits = "";
            int idx = 0;

            foreach (char ch in (text ?? ""))
            {
                if (ch >= '0' && ch <= '9')
                {
                    digits += ch;
                }
                else if (digits.Length > 0 && idx < 3)
                {
                    parts[idx++] = int.Parse(digits);
                    digits = "";
                }
                if (idx >= 3) break;
            }

            if (digits.Length > 0 && idx < 3) parts[idx] = int.Parse(digits);
            return parts;
        }

        /* ------------------------------------------------------------ */
        /*  Bandeja                                                      */
        /* ------------------------------------------------------------ */
        void HideToTray()
        {
            Hide();
            // Sin aviso emergente: molesta cada vez que se cierra el panel.
        }

        void RestoreFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
            }
        }

        void RealExit()
        {
            running = false;

            // Cierra sala y tunel antes de apagar el servidor (si no, cloudflared
            // puede quedar vivo apuntando a este PC).
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                    wc.UploadString(BASE + "/api/room", "DELETE", "");
                }
            }
            catch { }

            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (!serverExternal && serverProc != null && !serverProc.HasExited)
            {
                try { serverProc.Kill(); } catch { }
            }
            Application.Exit();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // GitHub solo habla TLS 1.2+; .NET 4.0 usa SSL3/TLS1 por defecto.
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch { }

            Settings.Load();
            L.Code = Settings.Lang;

            Application.Run(new MainForm());
        }
    }

    /* Iconos de Lucide (https://lucide.dev, licencia ISC), copiados tal cual de
       lucide-static y dibujados con GDI+: viewBox 24x24, trazo 2, puntas redondas. */
    static class Lucide
    {
        public const string Monitor =
            "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" />" +
            "<line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" />" +
            "<line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />";

        public const string Smartphone =
            "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\" />" +
            "<path d=\"M12 18h.01\" />";

        public const string Copy =
            "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" />" +
            "<path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />";

        /* Mando, sensor Kinect y camara: mismo trazo 24x24 que el resto. */
        public const string Gamepad =
            "<rect width=\"18\" height=\"12\" x=\"3\" y=\"7\" rx=\"4\" />" +
            "<line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\" />" +
            "<line x1=\"6\" x2=\"10\" y1=\"12\" y2=\"12\" />" +
            "<line x1=\"15\" x2=\"15.01\" y1=\"12\" y2=\"12\" />" +
            "<line x1=\"18\" x2=\"18.01\" y1=\"10\" y2=\"10\" />";

        public const string Kinect =
            "<rect width=\"18\" height=\"5\" x=\"3\" y=\"4\" rx=\"2.5\" />" +
            "<rect width=\"3\" height=\"3\" x=\"10.5\" y=\"5\" rx=\"1.5\" />" +
            "<line x1=\"6.5\" x2=\"6.51\" y1=\"6.5\" y2=\"6.5\" />" +
            "<line x1=\"17.5\" x2=\"17.51\" y1=\"6.5\" y2=\"6.5\" />" +
            "<path d=\"M6 12v5\" />" +
            "<path d=\"M12 12v7\" />" +
            "<path d=\"M18 12v5\" />";

        public const string Camera =
            "<rect width=\"20\" height=\"13\" x=\"2\" y=\"7\" rx=\"2\" />" +
            "<path d=\"M8 7l1.5-2h5L16 7\" />" +
            "<rect width=\"6\" height=\"6\" x=\"9\" y=\"10.5\" rx=\"3\" />";

        public const string Check = "<path d=\"M20 6 9 17l-5-5\" />";

        public const string Plus = "<path d=\"M5 12h14\" /><path d=\"M12 5v14\" />";

        /* lucide "sliders-horizontal": el icono de ajustes, solo lineas. */
        public const string ChevronDown = "<path d=\"m6 9 6 6 6-6\" />";

        public const string Sliders =
            "<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\" /><line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\" />" +
            "<line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\" /><line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\" />" +
            "<line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\" /><line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\" />" +
            "<line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\" /><line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\" />" +
            "<line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\" />";

        static readonly System.Text.RegularExpressions.Regex ElementRe =
            new System.Text.RegularExpressions.Regex(@"<(rect|line|path)\b([^>]*)/>");
        static readonly System.Text.RegularExpressions.Regex AttrRe =
            new System.Text.RegularExpressions.Regex(@"([a-z0-9]+)=""([^""]*)""");
        static readonly System.Text.RegularExpressions.Regex TokenRe =
            new System.Text.RegularExpressions.Regex(@"[MmLlHhVvCcZz]|-?(?:\d+\.?\d*|\.\d+)");

        public static Bitmap Render(string svg, int size, Color color)
        {
            Bitmap bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            using (System.Drawing.Drawing2D.GraphicsPath gp = Build(svg))
            using (Pen pen = new Pen(color, 2f))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.ScaleTransform(size / 24f, size / 24f);
                pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;
                g.DrawPath(pen, gp);
            }
            return bmp;
        }

        static System.Drawing.Drawing2D.GraphicsPath Build(string svg)
        {
            System.Drawing.Drawing2D.GraphicsPath gp = new System.Drawing.Drawing2D.GraphicsPath();
            foreach (System.Text.RegularExpressions.Match el in ElementRe.Matches(svg))
            {
                Dictionary<string, string> a = new Dictionary<string, string>();
                foreach (System.Text.RegularExpressions.Match at in AttrRe.Matches(el.Groups[2].Value))
                    a[at.Groups[1].Value] = at.Groups[2].Value;

                gp.StartFigure();
                switch (el.Groups[1].Value)
                {
                    case "rect": AddRect(gp, F(a, "x"), F(a, "y"), F(a, "width"), F(a, "height"), F(a, "rx")); break;
                    case "line": gp.AddLine(F(a, "x1"), F(a, "y1"), F(a, "x2"), F(a, "y2")); break;
                    case "path": AddPath(gp, a.ContainsKey("d") ? a["d"] : ""); break;
                }
            }
            return gp;
        }

        static float F(Dictionary<string, string> a, string key)
        {
            string v;
            return a.TryGetValue(key, out v) ? N(v) : 0f;
        }

        static float N(string s)
        {
            return float.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }

        static void AddRect(System.Drawing.Drawing2D.GraphicsPath gp, float x, float y, float w, float h, float r)
        {
            if (r <= 0) { gp.AddRectangle(new RectangleF(x, y, w, h)); return; }
            float d = r * 2;
            gp.AddArc(x, y, d, d, 180, 90);
            gp.AddArc(x + w - d, y, d, d, 270, 90);
            gp.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            gp.AddArc(x, y + h - d, d, d, 90, 90);
            gp.CloseFigure();
        }

        /* Solo los comandos que usan estos iconos: M L H V C Z (y sus relativos). */
        static void AddPath(System.Drawing.Drawing2D.GraphicsPath gp, string d)
        {
            List<string> t = new List<string>();
            foreach (System.Text.RegularExpressions.Match m in TokenRe.Matches(d)) t.Add(m.Value);

            PointF cur = PointF.Empty, start = PointF.Empty;
            char cmd = 'M';
            int i = 0;
            while (i < t.Count)
            {
                if (char.IsLetter(t[i][0])) cmd = t[i++][0];
                bool rel = char.IsLower(cmd);
                float ox = rel ? cur.X : 0, oy = rel ? cur.Y : 0;

                switch (char.ToUpper(cmd))
                {
                    case 'M':
                        cur = new PointF(ox + N(t[i]), oy + N(t[i + 1])); i += 2;
                        start = cur;
                        gp.StartFigure();
                        cmd = rel ? 'l' : 'L'; // pares extra tras M son lineas
                        break;
                    case 'L':
                        { PointF p = new PointF(ox + N(t[i]), oy + N(t[i + 1])); i += 2; gp.AddLine(cur, p); cur = p; }
                        break;
                    case 'H':
                        { PointF p = new PointF((rel ? cur.X : 0) + N(t[i++]), cur.Y); gp.AddLine(cur, p); cur = p; }
                        break;
                    case 'V':
                        { PointF p = new PointF(cur.X, (rel ? cur.Y : 0) + N(t[i++])); gp.AddLine(cur, p); cur = p; }
                        break;
                    case 'C':
                        {
                            PointF c1 = new PointF(ox + N(t[i]), oy + N(t[i + 1]));
                            PointF c2 = new PointF(ox + N(t[i + 2]), oy + N(t[i + 3]));
                            PointF p = new PointF(ox + N(t[i + 4]), oy + N(t[i + 5]));
                            i += 6;
                            gp.AddBezier(cur, c1, c2, p);
                            cur = p;
                        }
                        break;
                    case 'Z':
                        gp.CloseFigure();
                        cur = start;
                        if (i < t.Count && !char.IsLetter(t[i][0])) return; // numeros sueltos tras Z
                        break;
                    default:
                        return;
                }
            }
        }
    }

    /* Panel con doble buffer: la tabla de jugadores se repinta entera cada segundo. */
    class BufferedPanel : Panel
    {
        public BufferedPanel()
        {
            DoubleBuffered = true;
            ResizeRedraw = true;
        }
    }

    /* Colores del menu del icono de la bandeja, a juego con el panel oscuro. */
    class DarkMenuColors : ProfessionalColorTable
    {
        static readonly Color Bg = Color.FromArgb(10, 10, 12);
        static readonly Color Hover = Color.FromArgb(26, 26, 32);
        static readonly Color Pressed = Color.FromArgb(38, 38, 46);
        static readonly Color Line = Color.FromArgb(30, 30, 36);

        public override Color ToolStripDropDownBackground { get { return Bg; } }
        public override Color ImageMarginGradientBegin { get { return Bg; } }
        public override Color ImageMarginGradientMiddle { get { return Bg; } }
        public override Color ImageMarginGradientEnd { get { return Bg; } }
        public override Color MenuBorder { get { return Line; } }
        public override Color MenuItemBorder { get { return Hover; } }
        public override Color MenuItemSelected { get { return Hover; } }
        public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
        public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
        public override Color MenuItemPressedGradientBegin { get { return Pressed; } }
        public override Color MenuItemPressedGradientEnd { get { return Pressed; } }
        public override Color SeparatorDark { get { return Line; } }
        public override Color SeparatorLight { get { return Bg; } }
    }
}
