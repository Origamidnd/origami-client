use crate::core::notify::NoticeStatus;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;

use crate::{
    config::Config,
    core::{
        CoreManager, Timer,
        handle::Handle,
        hotkey::Hotkey,
        logger,
        manager::CoreFailure,
        service::{SERVICE_MANAGER, ServiceManager},
        tray::Tray,
    },
    core::{auto_backup::AutoBackupManager, autostart::AUTOSTART_ARG, lightweight::auto_lightweight_boot},
    feat,
    process::AsyncHandler,
    utils::{init, server, window_manager::WindowManager},
};
use clash_verge_logging::{Type, logging, logging_error};

#[cfg(target_os = "macos")]
pub mod dns;
mod scheme;
pub(crate) mod window;
mod window_script;

static RESOLVE_DONE: AtomicBool = AtomicBool::new(false);

pub(crate) fn init_work_dir_and_logger() -> anyhow::Result<()> {
    AsyncHandler::block_on(async {
        init_work_config().await;
        logging!(info, Type::Setup, "Initializing logger");
        logger::init().await?;
        Ok(())
    })
}

pub(crate) fn resolve_setup_sync() {
    AsyncHandler::spawn(|| async {
        AsyncHandler::spawn_blocking(init_scheme);
        AsyncHandler::spawn_blocking(server::embed_server);
        #[cfg(target_os = "linux")]
        AsyncHandler::spawn_blocking(watch_linux_theme_changed);
    });
}

pub(crate) fn resolve_setup_async() {
    AsyncHandler::spawn(resolve_setup);
}

#[tracing::instrument(skip_all, level = "info")]
async fn resolve_setup() {
    logging!(info, Type::ClashVergeRev, "Version: {}", env!("CARGO_PKG_VERSION"));

    // Migrate before windows or timers can change the loaded config.
    logging_error!(Type::Setup, init::migrate_short_update_intervals().await);
    #[cfg(target_os = "windows")]
    logging_error!(Type::Setup, init::migrate_strict_route().await);

    #[cfg(target_os = "macos")]
    resolve_dock_show().await;
    init_startup_script().await;
    init_service_manager().await;
    let config_initialized = init_verge_config_before_window().await;
    init_window().await;
    feat::reconcile_startup_tun_availability().await;
    init_resources().await;
    if let Err(e) = init::init_dns_config().await {
        logging!(warn, Type::Setup, "DNS config initialization failed: {}", e);
    }
    if config_initialized {
        init_verge_config().await;
    }
    Config::verify_config_initialization().await;

    // Live before the core starts, so a service appearing mid-start is not missed.
    #[cfg(target_os = "macos")]
    crate::core::network_watch::start();

    let core_init = AsyncHandler::spawn(|| async {
        init_core_manager().await;
    });

    let _ = futures::join!(
        core_init,
        init_tray(),
        init_timer(),
        init_hotkey(),
        init_auto_lightweight_boot(),
        init_auto_backup(),
        init_silent_updater(),
        init_autostart(),
    );

    // OrigamiVPN: after the core, so the first checks find it running.
    crate::core::link_watch::start();

    Handle::refresh_clash();
    refresh_tray_menu().await;
    resolve_done();
}

pub async fn resolve_reset_async() -> Result<(), anyhow::Error> {
    CoreManager::global().stop_core().await?;

    #[cfg(target_os = "macos")]
    {
        use dns::restore_public_dns;
        restore_public_dns().await?;
    }

    Ok(())
}

fn init_scheme() {
    logging_error!(Type::Setup, init::init_scheme());
}

pub(crate) async fn resolve_scheme(param: &str) {
    logging_error!(Type::Setup, scheme::resolve_scheme(param).await);
}

#[cfg(target_os = "linux")]
fn watch_linux_theme_changed() {
    match dark_light::subscribe() {
        Ok(watcher) => {
            for mode in watcher.iter() {
                use crate::core::notification;

                let theme = match mode {
                    dark_light::Mode::Light => tauri::Theme::Light,
                    dark_light::Mode::Dark => tauri::Theme::Dark,
                    dark_light::Mode::Unspecified => tauri::Theme::Light, // fallback to light
                };
                notification::NotificationSystem::send_event(
                    Handle::app_handle().clone(),
                    notification::FrontendEvent::ThemeChanged { theme },
                );
            }
        }
        Err(e) => {
            logging_error!(Type::Setup, "Fail to watch linux theme changed: {}", e);
        }
    }
}

async fn init_resources() {
    logging_error!(Type::Setup, init::init_resources().await);
}

async fn init_startup_script() {
    logging_error!(Type::Setup, init::startup_script().await);
}

async fn init_timer() {
    logging_error!(Type::Setup, Timer::global().init().await);
}

async fn init_hotkey() {
    let skip_register_hotkeys = !Config::verge().await.latest_arc().enable_global_hotkey.unwrap_or(true);
    logging_error!(Type::Setup, Hotkey::global().init(skip_register_hotkeys).await);
}

async fn init_auto_lightweight_boot() {
    logging_error!(Type::Setup, auto_lightweight_boot().await);
}

async fn init_auto_backup() {
    logging_error!(Type::Setup, AutoBackupManager::global().init().await);
}

async fn init_silent_updater() {
    use crate::core::SilentUpdater;
    use crate::core::handle::Handle;

    logging!(debug, Type::Setup, "Initializing silent updater...");

    let app_handle = Handle::app_handle();

    // Install cached updates before starting background checks.
    if SilentUpdater::global().try_install_on_startup(app_handle).await {
        logging!(info, Type::Setup, "Update installed at startup, restarting...");
        feat::restart_app().await;
    }

    let app_handle = app_handle.clone();
    tokio::spawn(async move {
        SilentUpdater::global().start_background_check(app_handle).await;
    });

    logging!(info, Type::Setup, "Silent updater initialized");
}

// Upstream has no session-end signal support on Linux; see crates/clash-verge-signal.
#[cfg(target_os = "linux")]
pub(crate) fn init_signal() {
    logging!(debug, Type::Setup, "Initializing signal handlers...");
    clash_verge_signal::register(feat::quit);
}

async fn init_work_config() {
    logging_error!(Type::Setup, init::init_config().await);
}

async fn init_tray() {
    logging_error!(Type::Setup, Tray::global().init().await);
}

async fn init_verge_config() {
    logging_error!(Type::Setup, Config::init_runtime_config().await);
}

async fn init_verge_config_before_window() -> bool {
    let result = Config::init_config_before_window().await;
    let success = result.is_ok();
    logging_error!(Type::Setup, result);
    success
}

async fn init_service_manager() {
    clash_verge_service_ipc::set_config(Some(ServiceManager::config())).await;

    SERVICE_MANAGER.detect_startup_status().await;
}

async fn init_core_manager() -> bool {
    match CoreManager::global().init().await {
        Ok(initialized) => initialized,
        Err(error) => {
            logging!(error, Type::Setup, "core manager initialization failed: {error:#}");
            CoreManager::global().record_startup_error(CoreFailure::StartFailed(format!("{error:#}")));
            Handle::notice(NoticeStatus::CoreStartError, "");
            false
        }
    }
}

async fn refresh_tray_menu() {
    logging_error!(Type::Setup, Tray::global().update_part().await);
}

/// OrigamiVPN: started by the system at logon, not by a person, so no window pops up.
fn started_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

/// OrigamiVPN: a silent start (at logon, or the setting) still loads the window, only hidden.
/// Recovery after sleep, the tray link dot, Auto warm-up and the subscription reminder run in its
/// page; without it they stay off until someone opens the window.
#[derive(Debug, PartialEq, Eq)]
enum StartupWindow {
    Shown,
    Hidden,
}

const fn startup_window(is_silent_start: bool) -> StartupWindow {
    if is_silent_start {
        StartupWindow::Hidden
    } else {
        StartupWindow::Shown
    }
}

async fn init_window() {
    let is_silent_start =
        Config::verge().await.data_arc().enable_silent_start.unwrap_or(false) || started_by_autostart();
    match startup_window(is_silent_start) {
        StartupWindow::Shown => WindowManager::create_window(true).await,
        StartupWindow::Hidden => WindowManager::create_hidden_window().await,
    };
}

/// OrigamiVPN: a new install has autostart on before anything patches the setting, and an older
/// task may lack the argument or point at another path, so the entry is written on every start.
async fn init_autostart() {
    if Config::verge().await.latest_arc().enable_auto_launch == Some(true) {
        logging_error!(Type::Setup, crate::core::autostart::update_launch().await);
    }
}

#[cfg(target_os = "macos")]
async fn resolve_dock_show() {
    let is_silent_start =
        Config::verge().await.data_arc().enable_silent_start.unwrap_or(false) || started_by_autostart();
    if is_silent_start {
        Handle::global().set_activation_policy_accessory();
    }
}

fn resolve_done() {
    RESOLVE_DONE.store(true, Ordering::Release);
}

pub(crate) fn is_resolve_done() -> bool {
    RESOLVE_DONE.load(Ordering::Acquire)
}

#[cfg(test)]
mod startup_window_tests {
    use super::{StartupWindow, startup_window};

    /// Recovery after sleep, the tray link dot, Auto warm-up and the subscription reminder run in
    /// the window's page: a start at logon must still load it, only not show it.
    #[test]
    fn a_silent_start_still_loads_the_page_hidden() {
        assert_eq!(startup_window(true), StartupWindow::Hidden);
        assert_eq!(startup_window(false), StartupWindow::Shown);
    }
}
