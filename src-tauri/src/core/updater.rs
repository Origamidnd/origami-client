use crate::{config::Config, singleton, utils::dirs};
use anyhow::{Context as _, Result};
use chrono::Utc;
use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio_util::sync::CancellationToken;

pub struct SilentUpdater {
    update_ready: AtomicBool,
    manual_cancel: Mutex<Option<CancellationToken>>,
    background_cancel: Mutex<Option<CancellationToken>>,
}

singleton!(SilentUpdater, SILENT_UPDATER);

impl SilentUpdater {
    const fn new() -> Self {
        Self {
            update_ready: AtomicBool::new(false),
            manual_cancel: Mutex::new(None),
            background_cancel: Mutex::new(None),
        }
    }

    pub fn is_update_ready(&self) -> bool {
        self.update_ready.load(Ordering::Acquire)
    }
}

#[derive(Serialize, Deserialize, specta::Type)]
struct UpdateCacheMeta {
    version: String,
    downloaded_at: String,
}

impl SilentUpdater {
    fn cache_dir() -> Result<PathBuf> {
        Ok(dirs::app_home_dir()?.join("update_cache"))
    }

    fn write_cache(bytes: &[u8], version: &str) -> Result<()> {
        let cache_dir = Self::cache_dir()?;
        std::fs::create_dir_all(&cache_dir)
            .with_context(|| format!("failed to create update cache directory {}", cache_dir.display()))?;

        let bin_path = cache_dir.join("pending_update.bin");
        std::fs::write(&bin_path, bytes)
            .with_context(|| format!("failed to write update cache {}", bin_path.display()))?;

        let meta = UpdateCacheMeta {
            version: version.to_string(),
            downloaded_at: Utc::now().to_rfc3339(),
        };
        let meta_path = cache_dir.join("pending_update.json");
        std::fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)
            .with_context(|| format!("failed to write update metadata {}", meta_path.display()))?;

        logging!(
            info,
            Type::System,
            "Update cache written: version={}, size={} bytes",
            version,
            bytes.len()
        );
        Ok(())
    }

    fn read_cache_bytes() -> Result<Vec<u8>> {
        let bin_path = Self::cache_dir()?.join("pending_update.bin");
        std::fs::read(&bin_path).with_context(|| format!("failed to read update cache {}", bin_path.display()))
    }

    fn read_cache_meta() -> Result<UpdateCacheMeta> {
        let meta_path = Self::cache_dir()?.join("pending_update.json");
        let content = std::fs::read_to_string(meta_path)?;
        Ok(serde_json::from_str(&content)?)
    }

    fn skipped_version() -> Option<String> {
        let path = Self::cache_dir().ok()?.join("skipped_version");
        std::fs::read_to_string(path).ok().map(|v| v.trim().to_owned())
    }

    fn remember_skipped(version: &str) {
        let Ok(cache_dir) = Self::cache_dir() else {
            return;
        };
        if let Err(e) = std::fs::write(cache_dir.join("skipped_version"), version) {
            logging!(warn, Type::System, "Failed to remember the postponed update: {e}");
        }
    }

    fn delete_cache() {
        if let Ok(cache_dir) = Self::cache_dir()
            && cache_dir.exists()
        {
            if let Err(e) = std::fs::remove_dir_all(&cache_dir) {
                logging!(
                    warn,
                    Type::System,
                    "Failed to delete update cache {}: {e}",
                    cache_dir.display()
                );
            } else {
                logging!(info, Type::System, "Update cache deleted");
            }
        }
    }

    /// Returns the cached installer for `update`, deleting a cache that does not match it.
    fn verified_cache(app_handle: &tauri::AppHandle, update: &Update) -> Option<Vec<u8>> {
        let meta = Self::read_cache_meta().ok()?;
        let bytes = if meta.version == update.version {
            Self::read_cache_bytes().and_then(|bytes| {
                verify_signature(app_handle, &bytes, &update.signature, &update.version)?;
                Ok(bytes)
            })
        } else {
            Err(anyhow::anyhow!("server offers v{}", update.version))
        };
        match bytes {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                logging!(
                    info,
                    Type::System,
                    "Update cache v{} is unusable: {e:#}, cleaning up",
                    meta.version
                );
                Self::delete_cache();
                None
            }
        }
    }
}

/// The cache directory is user-writable and feeds an elevated installer, so it is re-verified
/// with the same rules `Update::download` applies.
fn verify_signature(app_handle: &tauri::AppHandle, bytes: &[u8], signature: &str, version: &str) -> Result<()> {
    use base64::Engine as _;

    let decode = |value: &str| -> Result<String> {
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(value)?,
        )?)
    };
    let config: tauri_plugin_updater::Config = serde_json::from_value(
        app_handle
            .config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .context("updater is not configured")?,
    )?;

    let public_key = minisign_verify::PublicKey::decode(&decode(&config.pubkey)?)?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?)?;
    public_key
        .verify(bytes, &signature, true)
        .context("signature mismatch")?;

    match signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
    {
        Some(signed) => anyhow::ensure!(
            signed.trim_start_matches('v') == version,
            "signed for v{signed}, not v{version}"
        ),
        None => anyhow::ensure!(!config.require_signed_version, "signature carries no version"),
    }
    Ok(())
}

pub fn is_build_to_stable(current: &str, remote: &str) -> bool {
    let Some((base, build)) = current.trim_start_matches('v').split_once('+') else {
        return false;
    };
    !build.is_empty() && !base.contains('-') && base == remote.trim_start_matches('v')
}

/// Compares numeric version components after stripping version suffixes.
fn version_lte(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("0")
            .split('.')
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
    };

    let a_parts = parse(a);
    let b_parts = parse(b);
    let len = a_parts.len().max(b_parts.len());

    for i in 0..len {
        let av = a_parts.get(i).copied().unwrap_or(0);
        let bv = b_parts.get(i).copied().unwrap_or(0);
        if av < bv {
            return true;
        }
        if av > bv {
            return false;
        }
    }
    true // equal
}

/// Maps UI language to one of the three NSIS translations, defaulting to English.
#[cfg(target_os = "windows")]
fn nsis_language_id(app_language: &str) -> &'static str {
    match app_language {
        "zh" | "zhtw" => "2052", // SimpChinese
        "ru" => "1049",          // Russian
        _ => "1033",             // English
    }
}

/// Same wire shape as the updater plugin's JS `DownloadEvent`.
#[derive(Clone, Serialize, specta::Type)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

// OrigamiVPN: GitHub first, then our own copy of the release behind the subscription host, which
// opens from Russia when GitHub is slow. The copy holds the same signed files, and the updater
// checks the signature against our key, so the mirror cannot swap them.
const GITHUB_RELEASES: &str = "https://github.com/Origamidnd/origami-client/releases/download/";
const MIRROR: &str = "https://sub.origamivpn.pro/client/";
/// A source delivering less than this per window is dropped for the next one.
const MIN_PROGRESS: u64 = 1024 * 1024;
const PROGRESS_WINDOW: Duration = Duration::from_secs(30);

/// The manifest's URL, then the same file on the mirror (`<tag>/<file>`).
fn download_sources(url: &tauri::Url) -> Vec<tauri::Url> {
    let mut sources = vec![url.clone()];
    if let Some(rest) = url.as_str().strip_prefix(GITHUB_RELEASES)
        && let Ok(mirror) = tauri::Url::parse(&format!("{MIRROR}{rest}"))
    {
        sources.push(mirror);
    }
    sources
}

/// Tries every source with a throughput floor, then again stopping only on a stall, so a link
/// that is slow everywhere still finishes.
async fn download(update: &Update, on_event: impl Fn(DownloadEvent) + Sync) -> Result<Vec<u8>> {
    let sources = download_sources(&update.download_url);
    let mut last_error = None;
    for floor in [MIN_PROGRESS, 1] {
        for url in &sources {
            logging!(info, Type::System, "Downloading update v{} from {url}", update.version);
            match download_from(update, url, floor, &on_event).await {
                Ok(bytes) => {
                    on_event(DownloadEvent::Finished);
                    return Ok(bytes);
                }
                Err(e) => {
                    logging!(warn, Type::System, "Update download from {url} failed: {e:#}");
                    last_error = Some(e);
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no update download source")))
}

async fn download_from(
    update: &Update,
    url: &tauri::Url,
    floor: u64,
    on_event: &(impl Fn(DownloadEvent) + Sync),
) -> Result<Vec<u8>> {
    let mut source = update.clone();
    source.download_url = url.clone();
    let received = AtomicU64::new(0);
    let mut started = false;
    let fetch = source.download(
        |chunk_length, content_length| {
            if !std::mem::replace(&mut started, true) {
                on_event(DownloadEvent::Started { content_length });
            }
            received.fetch_add(chunk_length as u64, Ordering::Relaxed);
            on_event(DownloadEvent::Progress { chunk_length });
        },
        || {},
    );
    tokio::pin!(fetch);
    let mut seen = 0;
    loop {
        tokio::select! {
            result = &mut fetch => return Ok(result?),
            () = tokio::time::sleep(PROGRESS_WINDOW) => {
                let total = received.load(Ordering::Relaxed);
                anyhow::ensure!(total - seen >= floor, "only {} bytes in {PROGRESS_WINDOW:?}", total - seen);
                seen = total;
            }
        }
    }
}

impl SilentUpdater {
    /// Checks the server; Windows receives `/LANG` to suppress the NSIS language dialog,
    /// see `packages/windows/installer.nsi`.
    async fn check(app_handle: &tauri::AppHandle) -> Result<Option<Update>> {
        let updater_builder = app_handle.updater_builder();
        #[cfg(target_os = "windows")]
        let updater_builder = {
            let verge_lang = Config::verge().await.latest_arc().language.clone();
            let lang_id = nsis_language_id(&clash_verge_i18n::current_language(verge_lang.as_deref()));
            updater_builder.installer_arg(format!("/LANG={lang_id}"))
        };
        Ok(updater_builder.build()?.check().await?)
    }

    async fn install(update: Update, bytes: Vec<u8>) -> Result<()> {
        Ok(tokio::task::spawn_blocking(move || update.install(&bytes)).await??)
    }

    /// Installs a newer cached update before normal startup, if the user confirms.
    pub async fn try_install_on_startup(&self, app_handle: &tauri::AppHandle) -> bool {
        if let Some(manager) = crate::utils::package::system_package_manager() {
            logging!(
                info,
                Type::System,
                "Updates come from {manager}, skipping the built-in updater"
            );
            Self::delete_cache();
            return false;
        }
        if !Config::verge().await.latest_arc().auto_check_update.unwrap_or(true) {
            Self::delete_cache();
            return false;
        }

        let current_version = env!("CARGO_PKG_VERSION");

        let meta = match Self::read_cache_meta() {
            Ok(meta) => meta,
            Err(_) => return false, // No cache, nothing to do
        };

        let cached_version = &meta.version;

        if !is_build_to_stable(current_version, cached_version) && version_lte(cached_version, current_version) {
            logging!(
                info,
                Type::System,
                "Update cache version ({}) <= current ({}), cleaning up",
                cached_version,
                current_version
            );
            Self::delete_cache();
            return false;
        }

        logging!(
            info,
            Type::System,
            "Update cache version ({}) > current ({}), asking user to install",
            cached_version,
            current_version
        );

        // OrigamiVPN: "Later" postpones this version for good; a newer download asks again,
        // and Settings can still install it.
        if Self::skipped_version().as_deref() == Some(cached_version.as_str()) {
            logging!(
                info,
                Type::System,
                "Update v{cached_version} was postponed, not asking again"
            );
            return false;
        }

        // Preserve the cache when skipped so Settings can install it without downloading again.
        if !Self::ask_user_to_install(app_handle, cached_version).await {
            logging!(info, Type::System, "User skipped update install, starting normally");
            Self::remember_skipped(cached_version);
            return false;
        }

        // OrigamiVPN: shown right after the click, so the check and the UAC prompt do not look
        // like nothing happened.
        Self::show_update_splash(app_handle, cached_version);

        let update = match Self::check(app_handle).await {
            Ok(Some(u)) => u,
            Ok(None) => {
                logging!(
                    info,
                    Type::System,
                    "No update available from server, cache may be stale, cleaning up"
                );
                Self::delete_cache();
                Self::close_update_splash(app_handle);
                return false;
            }
            Err(e) => {
                logging!(
                    warn,
                    Type::System,
                    "Failed to check for update at startup: {e:#}, will retry next launch"
                );
                Self::close_update_splash(app_handle);
                return false; // Keep cache for next attempt
            }
        };

        let Some(bytes) = Self::verified_cache(app_handle, &update) else {
            Self::close_update_splash(app_handle);
            return false;
        };

        let version = update.version.clone();
        logging!(info, Type::System, "Installing cached update v{version} at startup...");

        // `install()` may hang (#2558); on Windows NSIS can take over without returning.
        let install = tokio::time::timeout(std::time::Duration::from_secs(30), Self::install(update, bytes));
        match install
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("install timed out (30s)")))
        {
            Ok(()) => {
                logging!(info, Type::System, "Update v{version} install triggered at startup");
                Self::delete_cache();
                true
            }
            Err(e) => {
                logging!(
                    warn,
                    Type::System,
                    "Startup install failed: {e:#}, will retry next launch"
                );
                Self::close_update_splash(app_handle);
                false
            }
        }
    }

    /// Installs `version` for the update dialog, reusing the cache when it holds that version;
    /// `false` when cancelled before the installer starts.
    pub async fn install_update(
        &self,
        app_handle: &tauri::AppHandle,
        version: &str,
        on_event: impl Fn(DownloadEvent) + Sync,
    ) -> Result<bool> {
        let cancel = CancellationToken::new();
        *self.manual_cancel.lock() = Some(cancel.clone());
        let prepared = tokio::select! {
            prepared = Self::prepare_install(app_handle, version, on_event) => Some(prepared),
            () = cancel.cancelled() => None,
        };
        // `cancel_download` cancels under the lock, so once the token is taken back its state is
        // final; a cancel during the last synchronous poll of `prepare_install` still wins.
        self.manual_cancel.lock().take();
        let Some((update, bytes)) = prepared.filter(|_| !cancel.is_cancelled()).transpose()? else {
            logging!(info, Type::System, "Update v{version} cancelled");
            return Ok(false);
        };

        logging!(info, Type::System, "Installing update v{version}...");
        Self::install(update, bytes).await?;
        Self::delete_cache();
        Ok(true)
    }

    async fn prepare_install(
        app_handle: &tauri::AppHandle,
        version: &str,
        on_event: impl Fn(DownloadEvent) + Sync,
    ) -> Result<(Update, Vec<u8>)> {
        let update = Self::check(app_handle)
            .await?
            .filter(|update| update.version == version)
            .with_context(|| format!("v{version} is no longer offered"))?;
        let bytes = match Self::verified_cache(app_handle, &update) {
            Some(bytes) => bytes,
            None => download(&update, on_event).await?,
        };
        Ok((update, bytes))
    }

    pub fn cancel_download(&self) {
        let mut slot = self.manual_cancel.lock();
        if let Some(cancel) = slot.take() {
            cancel.cancel();
        }
    }

    /// Drops the downloaded update and aborts a background download in flight.
    pub fn discard_pending(&self) {
        let cancel = self.background_cancel.lock().take();
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        self.update_ready.store(false, Ordering::Release);
        Self::delete_cache();
    }
}

impl SilentUpdater {
    async fn ask_user_to_install(app_handle: &tauri::AppHandle, version: &str) -> bool {
        use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};

        let title = clash_verge_i18n::t!("notifications.updateReady.title");
        let body = clash_verge_i18n::t!("notifications.updateReady.body").replace("{version}", version);
        let install_now = clash_verge_i18n::t!("notifications.updateReady.installNow").into_owned();
        let later = clash_verge_i18n::t!("notifications.updateReady.later").into_owned();

        let (tx, rx) = tokio::sync::oneshot::channel();

        let mut dialog = app_handle
            .dialog()
            .message(body)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(install_now, later))
            .kind(MessageDialogKind::Info);
        // OrigamiVPN: owned by the main window, so a click on the app cannot bury the prompt
        // under it (the window is disabled while the prompt is open).
        if let Some(window) = crate::utils::window_manager::WindowManager::get_main_window() {
            dialog = dialog.parent(&window);
        }
        dialog.show(move |confirmed| {
            let _ = tx.send(confirmed);
        });

        rx.await.unwrap_or(false)
    }
}

impl SilentUpdater {
    /// Uses injected HTML so the splash has no bundled-file dependency.
    /// OrigamiVPN: paper look of the app, the crane inline, text in the app language.
    fn show_update_splash(app_handle: &tauri::AppHandle, version: &str) {
        use base64::Engine as _;
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        let title = clash_verge_i18n::t!("notifications.updateInstalling.title");
        let body = clash_verge_i18n::t!("notifications.updateInstalling.body").replace("{version}", version);

        let window = match WebviewWindowBuilder::new(app_handle, "update-splash", WebviewUrl::App("index.html".into()))
            .title(title.as_ref())
            .inner_size(360.0, 220.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .decorations(false)
            .center()
            .always_on_top(true)
            .visible(true)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                logging!(warn, Type::System, "Failed to create update splash: {e}");
                return;
            }
        };

        let crane = base64::engine::general_purpose::STANDARD.encode(include_bytes!("../../icons/128x128@2x.png"));
        let js = format!(
            r#"
            document.documentElement.innerHTML = `
            <head><meta charset="utf-8"/><style>
              *{{margin:0;padding:0;box-sizing:border-box}}
              html,body{{height:100%;overflow:hidden;user-select:none;-webkit-user-select:none;
                font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}}
              body{{background:#F2F2EF;color:#16203C;padding:10px}}
              .sheet{{height:100%;border:1.5px dashed #A9ABB3;border-radius:14px;display:flex;flex-direction:column;
                align-items:center;justify-content:center;text-align:center;padding:0 24px}}
              .crane{{width:72px;height:72px;margin-bottom:12px;animation:float 2.4s ease-in-out infinite}}
              .title{{font-size:17px;font-weight:700;margin-bottom:6px}}
              .sub{{font-size:12.5px;line-height:1.4;color:#5B6078;margin-bottom:16px}}
              .bar{{width:180px;height:4px;background:#ECECE8;border-radius:2px;overflow:hidden}}
              .fill{{height:100%;width:30%;background:#EE7C34;border-radius:2px;animation:ind 1.5s ease-in-out infinite}}
              @media(prefers-color-scheme:dark){{
                body{{background:#0E1530;color:#F2F2EF}}.sheet{{border-color:#4A5379}}
                .sub{{color:#9EA4BF}}.bar{{background:#222C4D}}
              }}
              @keyframes ind{{0%{{width:0;margin-left:0}}50%{{width:40%;margin-left:30%}}100%{{width:0;margin-left:100%}}}}
              @keyframes float{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-4px)}}}}
            </style></head>
            <body><div class="sheet">
              <img class="crane" src="data:image/png;base64,{crane}" alt=""/>
              <div class="title">{title}</div>
              <div class="sub">{body}</div>
              <div class="bar"><div class="fill"></div></div>
            </div></body>`;
            "#
        );

        // The new webview may not accept evaluation immediately.
        std::thread::spawn(move || {
            use crate::utils::retry::{RetryError, RetryPolicy, retry_sync};
            let _ = retry_sync(
                RetryPolicy::fixed(std::num::NonZeroUsize::MIN.saturating_add(9), std::time::Duration::ZERO),
                |index| {
                    std::thread::sleep(std::time::Duration::from_millis(100 * (index as u64 + 1)));
                    window.eval(&js).map_err(RetryError::Retry)
                },
            );
        });

        logging!(info, Type::System, "Update splash window shown");
    }

    fn close_update_splash(app_handle: &tauri::AppHandle) {
        use tauri::Manager as _;
        if let Some(window) = app_handle.get_webview_window("update-splash") {
            let _ = window.close();
            logging!(info, Type::System, "Update splash window closed");
        }
    }
}

impl SilentUpdater {
    async fn check_and_download(&self, app_handle: &tauri::AppHandle) -> Result<()> {
        // Registered before reading the switch, so `discard_pending` either cancels it or ran first.
        let cancel = CancellationToken::new();
        *self.background_cancel.lock() = Some(cancel.clone());
        let auto_check = Config::verge().await.latest_arc().auto_check_update.unwrap_or(true)
            && crate::utils::package::system_package_manager().is_none();
        if !auto_check {
            logging!(debug, Type::System, "Silent update skipped: auto_check_update is false");
            return Ok(());
        }

        if self.is_update_ready() {
            logging!(debug, Type::System, "Silent update skipped: update already pending");
            return Ok(());
        }

        logging!(info, Type::System, "Silent updater: checking for updates...");

        let updater = app_handle.updater()?;
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                logging!(info, Type::System, "Silent updater: no update available");
                return Ok(());
            }
            Err(e) => {
                logging!(warn, Type::System, "Silent updater: check failed: {e}");
                return Err(e.into());
            }
        };

        let version = update.version.clone();
        logging!(info, Type::System, "Silent updater: update available: v{version}");

        if let Some(body) = &update.body
            && body.to_lowercase().contains("break change")
        {
            logging!(
                info,
                Type::System,
                "Silent updater: breaking change detected in v{version}, notifying frontend"
            );
            super::handle::Handle::notice(
                super::notify::NoticeStatus::Info,
                format!("New version v{version} contains breaking changes. Please update manually."),
            );
            return Ok(());
        }

        if Self::verified_cache(app_handle, &update).is_some() {
            logging!(info, Type::System, "Silent updater: v{version} already cached");
        } else {
            logging!(info, Type::System, "Silent updater: downloading v{version}...");
            let downloaded = tokio::select! {
                bytes = download(&update, |_| {}) => Some(bytes),
                () = cancel.cancelled() => None,
            };
            let Some(bytes) = downloaded else {
                logging!(info, Type::System, "Silent updater: download cancelled");
                return Ok(());
            };
            let bytes = bytes?;
            logging!(info, Type::System, "Silent updater: download complete");
            Self::write_cache(&bytes, &version)?;
        }

        // Serialized with `discard_pending` in the verge patch, which holds the same lock.
        let _config_write = Config::lock_config_write().await;
        if cancel.is_cancelled() || !Config::verge().await.latest_arc().auto_check_update.unwrap_or(true) {
            logging!(
                info,
                Type::System,
                "Silent updater: auto check was disabled, discarding v{version}"
            );
            Self::delete_cache();
            return Ok(());
        }

        self.update_ready.store(true, Ordering::Release);

        logging!(
            info,
            Type::System,
            "Silent updater: v{version} ready for startup install on next launch"
        );
        Ok(())
    }

    pub async fn start_background_check(&self, app_handle: tauri::AppHandle) {
        // Permanent watcher: daily update cycles for the lifetime of the app.
        logging!(info, Type::System, "Silent updater: background task started");

        tokio::time::sleep(std::time::Duration::from_secs(10)).await;

        loop {
            if let Err(e) = self.check_and_download(&app_handle).await {
                logging!(warn, Type::System, "Silent updater: cycle error: {e}");
            }

            tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
        }
    }
}

#[cfg(test)]
mod origami_mirror_tests {
    use super::download_sources;

    #[test]
    fn github_release_files_fall_back_to_the_mirror() -> Result<(), tauri::Error> {
        let url = tauri::Url::parse(
            "https://github.com/Origamidnd/origami-client/releases/download/v0.1.7/OrigamiVPN_0.1.7_x64-setup.exe",
        )
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
        let sources: Vec<String> = download_sources(&url).iter().map(ToString::to_string).collect();
        assert_eq!(
            sources,
            [
                "https://github.com/Origamidnd/origami-client/releases/download/v0.1.7/OrigamiVPN_0.1.7_x64-setup.exe",
                "https://sub.origamivpn.pro/client/v0.1.7/OrigamiVPN_0.1.7_x64-setup.exe",
            ]
        );
        Ok(())
    }

    #[test]
    fn other_urls_have_no_mirror() -> Result<(), tauri::Error> {
        let url = tauri::Url::parse("https://example.com/file.exe").map_err(|e| tauri::Error::Anyhow(e.into()))?;
        assert_eq!(download_sources(&url).len(), 1);
        Ok(())
    }
}
