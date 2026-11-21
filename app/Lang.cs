using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace JDControl
{
    /** Idiomas del panel: ingles, espanol y portugues (Brasil). */
    static class L
    {
        public const string EN = "en";
        public const string ES = "es";
        public const string PT = "pt";

        public static string Code = EN;

        /* Cada clave: [ingles, espanol, portugues] */
        static readonly Dictionary<string, string[]> Map = new Dictionary<string, string[]>
        {
            { "subLocal",       new[] { "LOCAL ROOM", "SALA LOCAL", "SALA LOCAL" } },
            { "subHost",        new[] { "ONLINE ROOM · HOST", "SALA ONLINE · ANFITRIÓN", "SALA ONLINE · ANFITRIÃO" } },
            { "subMember",      new[] { "ONLINE ROOM · {0}", "SALA ONLINE · {0}", "SALA ONLINE · {0}" } },
            { "connectedTag",   new[] { "CONNECTED", "CONECTADO", "CONECTADO" } },
            { "connectingTag",  new[] { "CONNECTING", "CONECTANDO", "CONECTANDO" } },
            { "adminTag",       new[] { "ADMIN", "ADMIN", "ADMIN" } },

            { "code",           new[] { "CODE", "CÓDIGO", "CÓDIGO" } },
            { "requireIp",      new[] { "Require IP to join", "Solicitar IP al unirse", "Exigir IP para entrar" } },
            { "tipRequireIp",   new[] { "Forces players to type the IP. If unchecked, the code is enough.",
                                        "Obliga a escribir la IP para unirse. Si está desmarcado, basta el código.",
                                        "Obriga a digitar o IP. Se desmarcado, o código basta." } },

            { "openServer",     new[] { "Open server", "Abrir servidor", "Abrir servidor" } },
            { "closeServer",    new[] { "Close server", "Cerrar servidor", "Fechar servidor" } },
            { "joinRoom",       new[] { "Join room", "Unirse a sala", "Entrar na sala" } },
            { "tipOpen",        new[] { "Opens the room and the public tunnel so anyone can play from any network.",
                                        "Abre la sala y el túnel público (cloudflared) para jugar desde cualquier red.",
                                        "Abre a sala e o túnel público (cloudflared) para jogar de qualquer rede." } },
            { "tipClose",       new[] { "Closes the room and stops the public tunnel.",
                                        "Cierra la sala y apaga el túnel público.",
                                        "Fecha a sala e desliga o túnel público." } },

            { "players",        new[] { "PLAYERS IN ROOM", "JUGADORES EN SALA", "JOGADORES NA SALA" } },
            { "serverTag",      new[] { "server", "servidor", "servidor" } },
            { "emptyPlayers",   new[] { "nobody connected yet", "nadie conectado todavía", "ninguém conectado ainda" } },

            { "gameWaiting",    new[] { "Game: waiting...", "Juego: esperando...", "Jogo: esperando..." } },
            { "gameDancing",    new[] { "Game: dancing ({0})", "Juego: bailando ({0})", "Jogo: dançando ({0})" } },
            { "gameConnected",  new[] { "Game: {0} connected", "Juego: {0} conectado(s)", "Jogo: {0} conectado(s)" } },
            { "roomError",      new[] { "Room: {0}", "Sala: {0}", "Sala: {0}" } },
            { "roomStarting",   new[] { "Room: all ready · starting...", "Sala: todos listos · comenzando...",
                                        "Sala: todos prontos · começando..." } },
            { "roomReadyWait",  new[] { "Room: ready {0}/{1} · waiting", "Sala: listos {0}/{1} · esperando",
                                        "Sala: prontos {0}/{1} · esperando" } },

            { "stCreating",     new[] { "creating room...", "creando sala...", "criando sala..." } },
            { "stCreated",      new[] { "room created: ", "sala creada: ", "sala criada: " } },
            { "stOnline",       new[] { "online active", "online activo", "online ativo" } },
            { "stNoTunnel",     new[] { "No tunnel active.", "Sin túnel activo.", "Sem túnel ativo." } },
            { "stOpenFirst",    new[] { "Open the server to create the public tunnel.",
                                        "Abre el servidor para generar el túnel público.",
                                        "Abre o servidor para criar o túnel público." } },
            { "stTunnelError",  new[] { "Tunnel unavailable: {0}", "Túnel no disponible: {0}", "Túnel indisponível: {0}" } },

            { "stateDancing",   new[] { "Dancing", "Bailando", "Dançando" } },
            { "stateReady",     new[] { "Ready", "Listo", "Pronto" } },
            { "stateMenu",      new[] { "In the game", "En el menú", "No jogo" } },
            { "stateOff",       new[] { "Out of the game", "Fuera del juego", "Fora do jogo" } },

            { "devPad",         new[] { "Controller", "Mando", "Controle" } },
            { "devKinect",      new[] { "Kinect", "Kinect", "Kinect" } },
            { "devCamera",      new[] { "Camera", "Cámara", "Câmera" } },
            { "devJoycon",      new[] { "Joy-Con", "Joy-Con", "Joy-Con" } },
            { "devWiimote",     new[] { "Wiimote", "Wiimote", "Wiimote" } },
            { "devPsmove",      new[] { "PS Move", "PS Move", "PS Move" } },
            { "devDs4",         new[] { "DualShock", "DualShock", "DualShock" } },
            { "devDance",       new[] { "Can dance", "Puede bailar", "Pode dançar" } },
            { "devMenusOnly",   new[] { "Menus only", "Solo menús", "Só menus" } },

            { "copyCode",       new[] { "Copy code", "Copiar código", "Copiar código" } },
            { "copyLink",       new[] { "Copy phone link", "Copiar enlace del móvil", "Copiar link do celular" } },
            { "copyIp",         new[] { "Copy host IP", "Copiar IP del anfitrión", "Copiar IP do anfitrião" } },
            { "copyFail",       new[] { "Could not copy.", "No se pudo copiar.", "Não foi possível copiar." } },
            { "copyDone",       new[] { "Copied", "Copiado", "Copiado" } },

            { "serverFail",     new[] { "Could not reach the server.", "No se pudo hablar con el servidor.",
                                        "Não foi possível falar com o servidor." } },
            { "noNode",         new[] { "Could not start the server: Node.js is missing.",
                                        "No se pudo iniciar el servidor: falta Node.js.",
                                        "Não foi possível iniciar o servidor: falta o Node.js." } },
            { "missingFiles",   new[] { "Files missing next to JD CONTROL.exe:", "Faltan archivos junto a JD CONTROL.exe:",
                                        "Faltam arquivos ao lado do JD CONTROL.exe:" } },
            { "missingHelp",    new[] { "The .exe is only the window; the server lives in the folder.\n" +
                                        "Unzip the whole \"JD CONTROL\" folder and run the .exe from there.\n\nCurrent folder:\n",
                                        "El .exe solo es la ventana; el servidor va en la carpeta.\n" +
                                        "Descomprime la carpeta \"JD CONTROL\" completa y abre el .exe desde ahí\n" +
                                        "(no lo saques a Descargas ni al escritorio).\n\nCarpeta actual:\n",
                                        "O .exe é só a janela; o servidor fica na pasta.\n" +
                                        "Descompacte a pasta \"JD CONTROL\" inteira e abra o .exe de dentro dela.\n\nPasta atual:\n" } },

            { "joinTitle",      new[] { "JOIN A ROOM", "UNIRSE A UNA SALA", "ENTRAR EM UMA SALA" } },
            { "joinHost",       new[] { "HOST IP/URL (OPTIONAL)", "IP/URL (OPCIONAL)", "IP/URL (OPCIONAL)" } },
            { "joinTip",        new[] { "Optional on your local network; from another network type the host's tunnel URL.",
                                        "Opcional en tu red local; desde otra red, escribe la URL del túnel del anfitrión.",
                                        "Opcional na sua rede local; de outra rede, digite a URL do túnel do anfitrião." } },
            { "joinOk",         new[] { "JOIN", "UNIRSE", "ENTRAR" } },
            { "cancel",         new[] { "CANCEL", "CANCELAR", "CANCELAR" } },
            { "joinWait",       new[] { "CONNECTING…", "CONECTANDO…", "CONECTANDO…" } },
            { "joinBadCode",    new[] { "The code has 5 digits.", "El código tiene 5 dígitos.", "O código tem 5 dígitos." } },
            { "joinFail",       new[] { "Could not join the room.", "No se pudo unir a la sala.", "Não foi possível entrar na sala." } },
            { "joinTitleShort", new[] { "Join room", "Unirse a sala", "Entrar na sala" } },

            { "settings",       new[] { "SETTINGS", "CONFIGURACIÓN", "CONFIGURAÇÕES" } },
            { "language",       new[] { "Language", "Idioma", "Idioma" } },
            { "checkUpdates",   new[] { "Show available updates", "Mostrar actualizaciones disponibles",
                                        "Mostrar atualizações disponíveis" } },
            { "checkUpdatesTip",new[] { "Checks the public repository for a newer release when the panel starts.",
                                        "Consulta el repositorio público al abrir el panel y avisa si hay versión nueva.",
                                        "Consulta o repositório público ao abrir o painel e avisa se houver versão nova." } },
            { "sendLogs",       new[] { "Send logs for analysis and bug fixes",
                                        "Enviar logs para análisis y arreglo de bugs",
                                        "Enviar logs para análise e correção de bugs" } },
            { "sendLogsTip",    new[] { "Uploads server.log, ghost.log and ui.jsonl to the developer's Discord. No video or audio is sent.",
                                        "Sube server.log, ghost.log y ui.jsonl al Discord del desarrollador. No se envía vídeo ni audio.",
                                        "Envia server.log, ghost.log e ui.jsonl ao Discord do desenvolvedor. Não envia vídeo nem áudio." } },
            { "logsSending",    new[] { "Sending logs…", "Enviando logs…", "Enviando logs…" } },
            { "logsSent",       new[] { "Logs sent. Thank you!", "Logs enviados. ¡Gracias!", "Logs enviados. Obrigado!" } },
            { "logsFail",       new[] { "Could not send logs: {0}", "No se pudieron enviar los logs: {0}",
                                        "Não foi possível enviar os logs: {0}" } },
            { "logsNoHook",     new[] { "Webhook not configured (webhook.txt).",
                                        "Webhook no configurado (webhook.txt).",
                                        "Webhook não configurado (webhook.txt)." } },
            { "logsOff",        new[] { "Logs will not be sent.", "No se enviarán logs.",
                                        "Os logs não serão enviados." } },
            { "version",        new[] { "Version", "Versión", "Versão" } },
            { "close",          new[] { "CLOSE", "CERRAR", "FECHAR" } },
            { "settingsTip",    new[] { "Settings", "Configuración", "Configurações" } },

            { "updateAvailable",new[] { "Update available: {0}", "Actualización disponible: {0}", "Atualização disponível: {0}" } },
            { "updateHint",     new[] { "Click to open the download page", "Clic para abrir la página de descarga",
                                        "Clique para abrir a página de download" } },

            { "trayShow",       new[] { "Open panel", "Abrir panel", "Abrir painel" } },
            { "trayExit",       new[] { "Exit", "Salir", "Sair" } },
            { "trayTitle",      new[] { "JD CONTROL", "JD CONTROL", "JD CONTROL" } },
            { "trayStill",      new[] { "Still running", "Sigue en segundo plano", "Continua em segundo plano" } },
            { "trayStillText",  new[] { "The room stays active. Click the icon to come back.",
                                        "La sala continúa activa. Un clic en el icono para volver.",
                                        "A sala continua ativa. Um clique no ícone para voltar." } },
        };

        static int Index()
        {
            if (Code == ES) return 1;
            if (Code == PT) return 2;
            return 0;
        }

        public static string T(string key)
        {
            string[] row;
            if (!Map.TryGetValue(key, out row)) return key;
            int i = Index();
            if (i >= row.Length) i = 0;
            return row[i];
        }

        public static string F(string key, params object[] args)
        {
            try { return string.Format(T(key), args); }
            catch { return T(key); }
        }
    }

    /** settings.json junto al exe: idioma elegido y aviso de actualizaciones. */
    static class Settings
    {
        public static string Lang = "";
        public static bool CheckUpdates = true;
        public static bool SendLogs = false;
        public static string UpdateUrl = "";

        public const string DEFAULT_UPDATE_URL =
            "https://api.github.com/repos/nxx-sudo/JD-Control/releases/latest";

        static string PathFile()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "settings.json");
        }

        /** Idioma del sistema, con ingles como red de seguridad. */
        public static string Detect()
        {
            try
            {
                string two = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.ToLowerInvariant();
                if (two == "es") return L.ES;
                if (two == "pt") return L.PT;
            }
            catch { }
            return L.EN;
        }

        public static void Load()
        {
            Lang = Detect();
            try
            {
                string file = PathFile();
                if (!File.Exists(file)) return;

                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> st = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                if (st == null) return;

                if (st.ContainsKey("lang") && st["lang"] != null)
                {
                    string code = st["lang"].ToString().Trim().ToLowerInvariant();
                    if (code == L.EN || code == L.ES || code == L.PT) Lang = code;
                }
                if (st.ContainsKey("checkUpdates") && st["checkUpdates"] != null)
                    CheckUpdates = Convert.ToBoolean(st["checkUpdates"]);
                if (st.ContainsKey("sendLogs") && st["sendLogs"] != null)
                    SendLogs = Convert.ToBoolean(st["sendLogs"]);
                if (st.ContainsKey("updateUrl") && st["updateUrl"] != null)
                    UpdateUrl = st["updateUrl"].ToString().Trim();
            }
            catch { }
        }

        public static void Save()
        {
            try
            {
                Dictionary<string, object> st = new Dictionary<string, object>();
                st["lang"] = Lang;
                st["checkUpdates"] = CheckUpdates;
                st["sendLogs"] = SendLogs;
                if (UpdateUrl.Length > 0) st["updateUrl"] = UpdateUrl;

                JavaScriptSerializer ser = new JavaScriptSerializer();
                File.WriteAllText(PathFile(), ser.Serialize(st));
            }
            catch { }
        }
    }
}
