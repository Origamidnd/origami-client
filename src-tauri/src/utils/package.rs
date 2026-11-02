//! OrigamiVPN: packages for distributions the built-in updater cannot install (Arch) leave a marker
//! naming their package manager; the app then leaves updates to that package manager.

#[cfg(target_os = "linux")]
const MARKER: &str = "/usr/share/origamivpn/package-manager";

/// Package manager that owns this install, e.g. `pacman`; `None` when the built-in updater applies.
pub fn system_package_manager() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let name = std::fs::read_to_string(MARKER).ok()?;
        let name = name.trim();
        (!name.is_empty()).then(|| name.to_owned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}
