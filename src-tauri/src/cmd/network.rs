use super::CmdResult;
use crate::cmd::StringifyErr as _;
use crate::core::{proxy_control, sysopt::Sysopt};

use gethostname::gethostname;
use sysproxy::{Autoproxy, Sysproxy};
use tauri_plugin_clash_verge_sysinfo;

#[tauri::command]
#[specta::specta]
pub async fn get_sys_proxy() -> CmdResult<SystemProxy> {
    Sysopt::global().wait_idle().await;
    // With no network service there is no proxy configured anywhere, which reads as disabled.
    let sys_proxy = match Sysproxy::get_system_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Sysproxy::default(),
        other => other.stringify_err()?,
    };
    let Sysproxy {
        host,
        bypass,
        port,
        enable,
    } = sys_proxy;

    Ok(SystemProxy {
        enable,
        server: format!("{host}:{port}"),
        bypass,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_auto_proxy() -> CmdResult<AutoProxy> {
    Sysopt::global().wait_idle().await;
    let auto_proxy = match Autoproxy::get_auto_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Autoproxy::default(),
        other => other.stringify_err()?,
    };
    let Autoproxy { enable, url } = auto_proxy;

    Ok(AutoProxy { enable, url })
}

#[tauri::command]
#[specta::specta]
pub fn get_embedded_server_port() -> CmdResult<u16> {
    crate::utils::server::embedded_server_port().stringify_err()
}

/// OrigamiVPN: package manager that updates this install (Arch), or `None` for built-in updates.
#[tauri::command]
#[specta::specta]
pub fn get_package_manager() -> Option<String> {
    crate::utils::package::system_package_manager()
}

#[tauri::command]
#[specta::specta]
pub fn get_system_hostname() -> String {
    match gethostname().into_string() {
        Ok(name) => name,
        Err(os_string) => {
            let fallback = format!("{os_string:?}");
            fallback.trim_matches('"').to_string()
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_network_interfaces() -> Vec<String> {
    tauri_plugin_clash_verge_sysinfo::list_network_interfaces()
}

#[tauri::command]
#[specta::specta]
pub fn get_network_interfaces_info() -> CmdResult<Vec<crate::ipc::NetworkInterfaceView>> {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};

    let names = get_network_interfaces();
    let interfaces = NetworkInterface::show().stringify_err()?;

    let mut result = Vec::new();

    for interface in interfaces {
        if names.contains(&interface.name) {
            result.push(interface.into());
        }
    }

    Ok(result)
}

#[derive(serde::Serialize, specta::Type)]
pub struct SystemProxy {
    pub enable: bool,
    pub server: String,
    pub bypass: String,
}

#[derive(serde::Serialize, specta::Type)]
pub struct AutoProxy {
    pub enable: bool,
    pub url: String,
}

/// OrigamiVPN: of the given proxies, the ones whose server address the core cannot resolve.
///
/// A delay test reports a dead server and an unresolvable name the same way, so the Servers tab
/// asks this for the silent ones and names the second case "address not found". Servers given as
/// an IP and names missing from the runtime config are never listed.
#[tauri::command]
#[specta::specta]
pub async fn origami_unresolved_servers(names: Vec<std::string::String>) -> CmdResult<Vec<std::string::String>> {
    let hosts: Vec<(std::string::String, std::string::String)> = {
        let runtime = crate::config::Config::runtime().await;
        let runtime = runtime.latest_arc();
        let proxies = runtime
            .config
            .as_ref()
            .and_then(|config| config.get("proxies"))
            .and_then(serde_yaml_ng::Value::as_sequence)
            .cloned()
            .unwrap_or_default();
        names
            .into_iter()
            .filter_map(|name| {
                let proxy = proxies
                    .iter()
                    .find(|proxy| proxy.get("name").and_then(serde_yaml_ng::Value::as_str) == Some(name.as_str()))?;
                let server = proxy.get("server").and_then(serde_yaml_ng::Value::as_str)?.trim();
                let bare = server.trim_start_matches('[').trim_end_matches(']');
                (bare.parse::<std::net::IpAddr>().is_err() && !bare.is_empty()).then(|| (name, bare.to_owned()))
            })
            .collect()
    };

    let mut unresolved = Vec::new();
    for (name, host) in hosts {
        if !core_resolves(&host).await {
            unresolved.push(name);
        }
    }
    Ok(unresolved)
}

// Asks the core's own DNS (`/dns/query`), the resolver it uses to reach servers. An API error counts
// as resolved: only a clear "no address" answer should change what the user sees.
async fn core_resolves(host: &str) -> bool {
    let mihomo = crate::core::handle::Handle::mihomo();
    let request = match mihomo.load_ctx().build_request(reqwest::Method::GET, "/dns/query") {
        Ok(request) => request,
        Err(_) => return true,
    };
    let Ok(response) = request
        .query(&[("name", host), ("type", "A")])
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    else {
        return true;
    };
    if !response.status().is_success() {
        return true;
    }
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return true;
    };
    // DNS RCODE: 2 = the resolver failed, 3 = no such name. Anything else counts as found.
    !matches!(body.get("Status").and_then(serde_json::Value::as_u64), Some(2 | 3))
}

/// OrigamiVPN: what the link watch found last, for a window that opens after the change.
#[tauri::command]
#[specta::specta]
pub fn origami_get_link_state() -> crate::core::link_watch::LinkState {
    crate::core::link_watch::current()
}
