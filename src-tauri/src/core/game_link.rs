//! OrigamiVPN: game mode (test). Every UDP packet of the game's tunnel goes over several paths at once.
//!
//! The game's traffic goes to a Hysteria2 proxy in the core whose server is this multiplexer on
//! 127.0.0.1. The multiplexer copies every datagram onto all paths (Russian bridges and directly to
//! the anchor); the anchor near the game servers keeps the first copy, drops the rest and holds the
//! one connection to the game. Replies come back on every path and the first copy wins here too, so a
//! slow or lossy path no longer turns into a lag spike.
//!
//! Wire format, the same on both ends (origami-infra/tools/gamelink/gamelink.py): 1 byte version (1),
//! 8 bytes session id, 4 bytes sequence number (big-endian), then the payload.

use std::collections::{HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const VERSION: u8 = 1;
pub const HEADER: usize = 1 + 8 + 4;
const WINDOW: usize = 8192;
const STATS_EVERY: Duration = Duration::from_secs(60);
const DEFAULT_PORT: u16 = 24480;
const DEFAULT_SNI: &str = "gl.origamirealms.com";
// World of Warcraft: retail, Classic and their test clients.
const DEFAULT_APPS: [&str; 6] = [
    "Wow.exe",
    "WowClassic.exe",
    "WowB.exe",
    "WowT.exe",
    "WowClassicT.exe",
    "Wow-64.exe",
];

/// One way to the anchor: a bridge that forwards UDP to it, or the anchor itself.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GamePath {
    pub name: String,
    pub addr: SocketAddr,
}

/// What a game mode code holds. The password and the certificate pin are secrets: the code is given
/// to a tester privately and lives only in the local settings.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GameLinkConfig {
    pub password: String,
    /// sha256 of the anchor's certificate, hex.
    pub fingerprint: String,
    #[serde(default = "default_sni")]
    pub sni: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub paths: Vec<GamePath>,
    /// Process names whose traffic goes through game mode.
    #[serde(default = "default_apps")]
    pub apps: Vec<String>,
}

fn default_sni() -> String {
    DEFAULT_SNI.to_owned()
}
const fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_apps() -> Vec<String> {
    DEFAULT_APPS.iter().map(|name| (*name).to_owned()).collect()
}

impl GameLinkConfig {
    /// A code is the JSON itself or the same JSON in base64 (plain or URL-safe, with or without padding).
    pub fn parse(code: &str) -> Result<Self> {
        let code = code.trim();
        if code.is_empty() {
            bail!("empty game mode code");
        }
        let json = if code.starts_with('{') {
            code.to_owned()
        } else {
            let compact: String = code.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = [
                base64::engine::general_purpose::STANDARD,
                base64::engine::general_purpose::STANDARD_NO_PAD,
            ]
            .iter()
            .find_map(|engine| engine.decode(&compact).ok())
            .or_else(|| {
                [
                    base64::engine::general_purpose::URL_SAFE,
                    base64::engine::general_purpose::URL_SAFE_NO_PAD,
                ]
                .iter()
                .find_map(|engine| engine.decode(&compact).ok())
            })
            .context("game mode code is neither JSON nor base64")?;
            String::from_utf8(bytes).context("game mode code is not text")?
        };
        let config: Self = serde_json::from_str(&json).context("game mode code is not valid")?;
        if config.password.is_empty() || config.fingerprint.is_empty() {
            bail!("game mode code has no password or certificate pin");
        }
        if config.paths.is_empty() {
            bail!("game mode code has no paths");
        }
        Ok(config)
    }

    /// Hosts the multiplexer sends to: they must go past the TUN and the rules.
    pub fn path_ips(&self) -> Vec<IpAddr> {
        let mut ips: Vec<IpAddr> = self.paths.iter().map(|path| path.addr.ip()).collect();
        ips.sort();
        ips.dedup();
        ips
    }
}

pub fn pack(session: &[u8; 8], seq: u32, payload: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER + payload.len());
    packet.push(VERSION);
    packet.extend_from_slice(session);
    packet.extend_from_slice(&seq.to_be_bytes());
    packet.extend_from_slice(payload);
    packet
}

/// The sequence number and payload of a packet of this session, or None.
pub fn unpack<'a>(session: &[u8; 8], packet: &'a [u8]) -> Option<(u32, &'a [u8])> {
    if packet.len() < HEADER || packet[0] != VERSION || packet[1..9] != session[..] {
        return None;
    }
    let seq = u32::from_be_bytes([packet[9], packet[10], packet[11], packet[12]]);
    Some((seq, &packet[HEADER..]))
}

/// Recent sequence numbers, to keep only the first copy of each packet.
#[derive(Debug, Default)]
pub struct Window {
    seen: HashSet<u32>,
    order: VecDeque<u32>,
}

impl Window {
    /// True for the first copy.
    pub fn add(&mut self, seq: u32) -> bool {
        if !self.seen.insert(seq) {
            return false;
        }
        self.order.push_back(seq);
        if self.order.len() > WINDOW
            && let Some(old) = self.order.pop_front()
        {
            self.seen.remove(&old);
        }
        true
    }
}

#[derive(Debug, Default, Clone)]
struct PathStats {
    up: u64,
    first: u64,
    dup: u64,
    err: u64,
    rx_err: u64,
}

/// Counters for the periodic log line. They only grow, so once anything happened every tick reports.
#[derive(Debug, Default)]
struct Stats {
    from_game: u64,
    to_game: u64,
    local_err: u64,
    paths: Vec<PathStats>,
}

impl Stats {
    fn new(paths: usize) -> Self {
        Self {
            paths: vec![PathStats::default(); paths],
            ..Self::default()
        }
    }

    /// The log line, or None while nothing at all happened (no packet and no error).
    fn report(&self, names: &[&str]) -> Option<String> {
        let idle = self.from_game == 0
            && self.to_game == 0
            && self.local_err == 0
            && self
                .paths
                .iter()
                .all(|p| p.up == 0 && p.first == 0 && p.dup == 0 && p.err == 0 && p.rx_err == 0);
        if idle {
            return None;
        }
        let paths = names
            .iter()
            .zip(&self.paths)
            .map(|(name, s)| {
                format!(
                    "{name} up={} first={} dup={} err={} rx_err={}",
                    s.up, s.first, s.dup, s.err, s.rx_err
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        Some(format!(
            "game mode: from game {}, to game {}, local errors {}; {paths}",
            self.from_game, self.to_game, self.local_err
        ))
    }
}

/// What a path's reader hands to the main loop.
enum FromPath {
    Packet(Vec<u8>),
    Error(std::io::Error),
}

/// Runs until aborted: forwards the game tunnel between `local` and every path.
pub async fn run(config: GameLinkConfig, local: UdpSocket) -> Result<()> {
    run_with(config, local, STATS_EVERY, |line| logging!(info, Type::Core, "{line}")).await
}

async fn run_with(
    config: GameLinkConfig,
    local: UdpSocket,
    stats_every: Duration,
    mut log: impl FnMut(String),
) -> Result<()> {
    let mut session = [0u8; 8];
    getrandom::fill(&mut session).context("failed to make a game mode session id")?;
    let local = Arc::new(local);
    let names: Vec<&str> = config.paths.iter().map(|path| path.name.as_str()).collect();

    let mut sockets = Vec::with_capacity(config.paths.len());
    let (tx, mut rx) = mpsc::channel::<(usize, FromPath)>(1024);
    let mut readers = Vec::new();
    for (index, path) in config.paths.iter().enumerate() {
        let bind: SocketAddr = if path.addr.is_ipv4() {
            "0.0.0.0:0".parse()?
        } else {
            "[::]:0".parse()?
        };
        let socket = Arc::new(UdpSocket::bind(bind).await?);
        socket.connect(path.addr).await?;
        let reader = Arc::clone(&socket);
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 65535];
            loop {
                // An error (a refused send shows up here on some systems) only means a missed packet,
                // but it is counted so a dead path shows in the log.
                let item = match reader.recv(&mut buf).await {
                    Ok(n) => FromPath::Packet(buf[..n].to_vec()),
                    Err(err) => FromPath::Error(err),
                };
                let failed = matches!(item, FromPath::Error(_));
                if tx.send((index, item)).await.is_err() {
                    break;
                }
                if failed {
                    // Do not spin if the system keeps reporting the same error.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }));
        sockets.push(socket);
    }
    drop(tx);
    let _readers = AbortOnDrop(readers);

    log(format!(
        "game mode: listening on {} with {} path(s): {}",
        local
            .local_addr()
            .map_or_else(|_| "?".to_owned(), |addr| addr.to_string()),
        names.len(),
        names.join(", ")
    ));

    let mut stats = Stats::new(names.len());
    let mut window = Window::default();
    let mut seq: u32 = 0;
    let mut app: Option<SocketAddr> = None;
    let mut buf = vec![0u8; 65535];
    let mut tick = tokio::time::interval(stats_every);
    tick.tick().await;

    loop {
        tokio::select! {
            received = local.recv_from(&mut buf) => {
                let (n, from) = match received {
                    Ok(received) => received,
                    Err(err) => {
                        stats.local_err += 1;
                        if stats.local_err == 1 {
                            log(format!("game mode: local receive failed: {err}"));
                        }
                        continue;
                    }
                };
                if app != Some(from) {
                    log(format!("game mode: packets from the game at {from}, sending over {} path(s)", names.len()));
                }
                app = Some(from);
                stats.from_game += 1;
                seq = seq.wrapping_add(1);
                let packet = pack(&session, seq, &buf[..n]);
                for (index, socket) in sockets.iter().enumerate() {
                    let path = &mut stats.paths[index];
                    match socket.send(&packet).await {
                        Ok(_) => path.up += 1,
                        Err(err) => {
                            path.err += 1;
                            if path.err == 1 {
                                log(format!("game mode: path {} send failed: {err}", names[index]));
                            }
                        }
                    }
                }
            }
            Some((index, item)) = rx.recv() => {
                let packet = match item {
                    FromPath::Packet(packet) => packet,
                    FromPath::Error(err) => {
                        let path = &mut stats.paths[index];
                        path.rx_err += 1;
                        if path.rx_err == 1 {
                            log(format!("game mode: path {} receive failed: {err}", names[index]));
                        }
                        continue;
                    }
                };
                let (Some(app), Some((seq, payload))) = (app, unpack(&session, &packet)) else { continue };
                let path = &mut stats.paths[index];
                if path.first == 0 && path.dup == 0 {
                    log(format!("game mode: path {} answers", names[index]));
                }
                if window.add(seq) {
                    path.first += 1;
                    stats.to_game += 1;
                    let _ = local.send_to(payload, app).await;
                } else {
                    path.dup += 1;
                }
            }
            _ = tick.tick() => {
                if let Some(line) = stats.report(&names) {
                    log(line);
                }
            }
        }
    }
}

struct AbortOnDrop(Vec<JoinHandle<()>>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        for handle in &self.0 {
            handle.abort();
        }
    }
}

struct Running {
    config: GameLinkConfig,
    task: tauri::async_runtime::JoinHandle<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Starts, restarts or stops the multiplexer to match the settings. Called on every config build.
pub async fn ensure(config: Option<GameLinkConfig>) {
    {
        let running = RUNNING.lock();
        if running.as_ref().map(|r| &r.config) == config.as_ref()
            && running.as_ref().is_none_or(|r| !r.task.inner().is_finished())
        {
            return;
        }
    }
    let old = RUNNING.lock().take();
    if let Some(old) = old {
        if old.task.inner().is_finished() {
            logging!(warn, Type::Core, "game mode: the previous run ended, starting again");
        }
        old.task.abort();
        // Wait until the old run is dropped: only then its socket lets go of the port.
        let _ = old.task.await;
        logging!(info, Type::Core, "game mode: stopped");
    }
    let Some(config) = config else { return };
    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let mut attempt = 0;
    let local = loop {
        match UdpSocket::bind(addr).await {
            Ok(socket) => break socket,
            // The system can hold a just closed port for a moment.
            Err(_) if attempt < 10 => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(err) => {
                logging!(warn, Type::Core, "game mode: port {} is busy: {err}", config.port);
                return;
            }
        }
    };
    let for_task = config.clone();
    let task = crate::process::AsyncHandler::spawn(move || async move {
        if let Err(err) = run(for_task, local).await {
            logging!(warn, Type::Core, "game mode: stopped on error: {err:#}");
        }
    });
    *RUNNING.lock() = Some(Running { config, task });
}

/// The settings' code, when game mode is on and the code reads.
pub fn from_settings(enabled: bool, code: &str) -> Option<GameLinkConfig> {
    if !enabled {
        return None;
    }
    match GameLinkConfig::parse(code) {
        Ok(config) => Some(config),
        Err(err) => {
            logging!(warn, Type::Core, "game mode: {err:#}");
            None
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, reason = "tests")]
mod tests {
    use super::*;

    const JSON: &str = r#"{"password":"p","fingerprint":"ab","paths":[{"name":"msk2","addr":"192.0.2.1:24443"},{"name":"direct","addr":"192.0.2.9:24443"}]}"#;

    #[test]
    fn a_code_reads_as_json_or_base64_with_defaults() {
        let from_json = GameLinkConfig::parse(JSON).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(JSON);
        let url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(JSON);
        assert_eq!(GameLinkConfig::parse(&b64).unwrap(), from_json);
        assert_eq!(GameLinkConfig::parse(&format!("  {url}\n")).unwrap(), from_json);
        assert_eq!(from_json.port, 24480);
        assert_eq!(from_json.sni, "gl.origamirealms.com");
        assert!(from_json.apps.iter().any(|app| app == "Wow.exe"));
        assert_eq!(from_json.path_ips().len(), 2);
    }

    #[test]
    fn a_code_without_secrets_or_paths_is_refused() {
        assert!(GameLinkConfig::parse("").is_err());
        assert!(GameLinkConfig::parse(r#"{"password":"","fingerprint":"ab","paths":[]}"#).is_err());
        assert!(GameLinkConfig::parse(r#"{"password":"p","fingerprint":"ab","paths":[]}"#).is_err());
        assert!(GameLinkConfig::parse("not a code").is_err());
    }

    #[test]
    fn packets_round_trip_and_other_sessions_are_ignored() {
        let session = [1, 2, 3, 4, 5, 6, 7, 8];
        let packet = pack(&session, 0xA0B0_C0D0, b"quic");
        assert_eq!(packet.len(), HEADER + 4);
        assert_eq!(unpack(&session, &packet), Some((0xA0B0_C0D0, &b"quic"[..])));
        assert_eq!(unpack(&[9; 8], &packet), None);
        assert_eq!(unpack(&session, &packet[..5]), None);
    }

    #[test]
    fn the_window_keeps_the_first_copy_only() {
        let mut window = Window::default();
        assert!(window.add(1));
        assert!(!window.add(1));
        assert!(window.add(2));
        for seq in 3..(WINDOW as u32 + 10) {
            window.add(seq);
        }
        // Long forgotten numbers count as new again; recent ones stay duplicates.
        assert!(window.add(1));
        assert!(!window.add(WINDOW as u32));
    }

    /// Two fake paths: the game's packet reaches both with the same number, and when both answer
    /// the game gets the reply once.
    #[tokio::test]
    async fn every_packet_goes_over_every_path_and_the_game_gets_one_reply() {
        let path_a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let path_b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let config = GameLinkConfig {
            password: "p".into(),
            fingerprint: "ab".into(),
            sni: DEFAULT_SNI.into(),
            port: 0,
            paths: vec![
                GamePath {
                    name: "a".into(),
                    addr: path_a.local_addr().unwrap(),
                },
                GamePath {
                    name: "b".into(),
                    addr: path_b.local_addr().unwrap(),
                },
            ],
            apps: default_apps(),
        };
        let local = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mux_addr = local.local_addr().unwrap();
        let task = tokio::spawn(run(config, local));

        let game = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        game.send_to(b"hello", mux_addr).await.unwrap();

        let mut buf = vec![0u8; 2048];
        let (n_a, from_a) = path_a.recv_from(&mut buf).await.unwrap();
        let got_a = buf[..n_a].to_vec();
        let (n_b, from_b) = path_b.recv_from(&mut buf).await.unwrap();
        let got_b = buf[..n_b].to_vec();
        assert_eq!(got_a, got_b, "both paths carry the same copy");
        assert_eq!(&got_a[HEADER..], b"hello");
        let mut session = [0u8; 8];
        session.copy_from_slice(&got_a[1..9]);

        let reply = pack(&session, 1, b"world");
        path_b.send_to(&reply, from_b).await.unwrap();
        path_a.send_to(&reply, from_a).await.unwrap();

        let (n, _) = tokio::time::timeout(Duration::from_secs(2), game.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf[..n], b"world");
        let second = tokio::time::timeout(Duration::from_millis(300), game.recv_from(&mut buf)).await;
        assert!(second.is_err(), "the second copy of the reply is dropped");
        task.abort();
    }

    #[test]
    fn the_report_shows_up_when_sends_only_fail() {
        let names = ["msk2", "direct"];
        let mut stats = Stats::new(2);
        assert_eq!(stats.report(&names), None, "nothing happened yet");
        stats.paths[1].err = 3;
        let line = stats.report(&names).expect("errors alone are worth a line");
        assert!(line.contains("direct up=0 first=0 dup=0 err=3"), "{line}");
        let mut stats = Stats::new(2);
        stats.paths[0].rx_err = 1;
        assert!(stats.report(&names).is_some(), "receive errors alone are worth a line");
    }

    /// The periodic line comes out while no path answers, and the first packet is logged at once.
    #[tokio::test]
    async fn the_stats_line_comes_on_the_tick_while_no_path_answers() {
        let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let config = GameLinkConfig {
            password: "p".into(),
            fingerprint: "ab".into(),
            sni: DEFAULT_SNI.into(),
            port: 0,
            paths: vec![GamePath {
                name: "a".into(),
                addr: silent.local_addr().unwrap(),
            }],
            apps: default_apps(),
        };
        let local = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mux_addr = local.local_addr().unwrap();
        let (lines_tx, mut lines) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(run_with(config, local, Duration::from_millis(100), move |line| {
            let _ = lines_tx.send(line);
        }));

        let game = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        game.send_to(b"hello", mux_addr).await.unwrap();

        let mut seen = Vec::new();
        let found = tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(line) = lines.recv().await {
                seen.push(line.clone());
                if line.contains("from game 1,") && line.contains("a up=1") {
                    return;
                }
            }
        })
        .await;
        task.abort();
        assert!(found.is_ok(), "no stats line, got {seen:?}");
        assert!(seen.iter().any(|l| l.contains("packets from the game at")), "{seen:?}");
    }

    /// A new code while game mode runs: the old multiplexer lets go of the port and the new one
    /// listens on it.
    #[tokio::test]
    async fn a_new_code_restarts_on_the_same_port() {
        let port = UdpSocket::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = |last: u8| GameLinkConfig {
            password: "p".into(),
            fingerprint: "ab".into(),
            sni: DEFAULT_SNI.into(),
            port,
            paths: vec![GamePath {
                name: "direct".into(),
                addr: SocketAddr::from(([192, 0, 2, last], 24443)),
            }],
            apps: default_apps(),
        };
        ensure(Some(config(1))).await;
        ensure(Some(config(2))).await;
        let running = RUNNING.lock().as_ref().map(|r| r.config.clone());
        ensure(None).await;
        assert_eq!(running, Some(config(2)), "the new code runs");
    }
}
