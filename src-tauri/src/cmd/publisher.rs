//! OrigamiVPN: who signed a program's file. Programs of one publisher go one way together, also a
//! game nobody has listed yet (src/origami/routes/publishers.ts).
use std::collections::HashMap;
use std::string::String as StdString;

#[cfg(any(windows, test))]
const MAX_PATHS: usize = 64;

/// Reads the paths as JSON from stdin, so that no path is ever part of the script. It holds no double
/// quote and fits one line, since it travels as one command line argument. It runs under any execution
/// policy, so it asks for none: antivirus programs watch for PowerShell started with a bypass.
#[cfg(any(windows, test))]
const SCRIPT: &str = "$utf8 = New-Object Text.UTF8Encoding $false; \
[Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; \
$q = [char]34; $tab = [char]9; \
$pattern = '(?:^|, )O=(?:' + $q + '([^' + $q + ']+)' + $q + '|([^,]+))'; \
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; \
foreach ($path in $paths) { try { \
$signature = Get-AuthenticodeSignature -LiteralPath $path; \
if ($signature.Status -eq 'Valid') { \
$found = [regex]::Match($signature.SignerCertificate.Subject, $pattern); \
if ($found.Success) { [Console]::Out.WriteLine($path + $tab + $found.Groups[1].Value + $found.Groups[2].Value) } } \
} catch {} }";

/// `path<TAB>publisher` per line.
#[cfg(any(windows, test))]
fn parse_output(output: &str) -> HashMap<StdString, StdString> {
    output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(path, publisher)| (path.trim().to_owned(), publisher.trim().to_owned()))
        .filter(|(path, publisher)| !path.is_empty() && !publisher.is_empty())
        .collect()
}

#[cfg(any(windows, test))]
fn usable_paths(mut paths: Vec<StdString>) -> Vec<StdString> {
    paths.retain(|path| {
        let mut chars = path.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.next() == Some(':')
            && chars.next() == Some('\\')
            && !path.chars().any(char::is_control)
    });
    paths.truncate(MAX_PATHS);
    paths
}

/// Runs the command with `input` on stdin and returns its stdout, or None when it fails or is still
/// running at the deadline; then the process is killed instead of being left behind.
#[cfg(any(windows, test))]
fn run_with_deadline(
    mut command: std::process::Command,
    input: &[u8],
    deadline: std::time::Duration,
) -> Option<StdString> {
    use std::io::{Read as _, Write as _};
    use std::process::Stdio;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // On their own threads, so that a full pipe on either side cannot stall the wait below.
    let mut stdin = child.stdin.take()?;
    let input = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = std::time::Instant::now();
    let finished = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if started.elapsed() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => break false,
        }
    };
    if !finished {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = writer.join();
    let out = reader.join().ok()?;
    finished.then(|| StdString::from_utf8_lossy(&out).into_owned())
}

#[cfg(windows)]
fn read_publishers(paths: &[StdString]) -> Option<HashMap<StdString, StdString>> {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
    let root = std::env::var_os("SystemRoot")?;
    let powershell = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = std::process::Command::new(powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW);
    let input = serde_json::to_vec(paths).ok()?;
    run_with_deadline(command, &input, DEADLINE).map(|output| parse_output(&output))
}

#[cfg(windows)]
async fn publishers_of(paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    let paths = usable_paths(paths);
    if paths.is_empty() {
        return HashMap::new();
    }
    match tokio::task::spawn_blocking(move || read_publishers(&paths)).await {
        Ok(Some(found)) => found,
        _ => HashMap::new(),
    }
}

#[cfg(not(windows))]
#[allow(
    clippy::unused_async,
    reason = "the same call as on Windows, where it waits for a process"
)]
async fn publishers_of(_paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    HashMap::new()
}

/// Publisher by path, for the files with a valid signature. Without one a program has no publisher and
/// is linked by its folder alone, so any failure here only means that.
#[tauri::command]
#[specta::specta]
pub async fn origami_program_publishers(paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    publishers_of(paths).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    #[test]
    fn the_script_fits_one_argument_without_double_quotes() {
        assert!(!SCRIPT.contains('"'));
        assert!(!SCRIPT.contains('\n'));
    }

    #[test]
    fn reads_the_lines_of_the_script() {
        let found =
            parse_output("C:\\Games\\Игра\\a.exe\tBlizzard Entertainment, Inc.\r\nnoise\n\tno path\nC:\\b.exe\t\n");
        assert_eq!(found.len(), 1);
        assert_eq!(
            found.get("C:\\Games\\Игра\\a.exe").unwrap(),
            "Blizzard Entertainment, Inc."
        );
    }

    #[test]
    fn asks_only_about_windows_paths_and_not_too_many() {
        let paths = usable_paths(vec![
            "C:\\a.exe".into(),
            "/usr/bin/a".into(),
            "".into(),
            "C:\\a\nb.exe".into(),
            "relative\\a.exe".into(),
        ]);
        assert_eq!(paths, ["C:\\a.exe"]);
        assert_eq!(usable_paths(vec!["C:\\a.exe".into(); 100]).len(), MAX_PATHS);
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_lookup_is_killed_at_the_deadline() {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "cat >/dev/null; sleep 30"]);
        let started = std::time::Instant::now();
        let output = run_with_deadline(command, b"[]", std::time::Duration::from_millis(300));
        assert!(output.is_none());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "waited for the process"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_quick_lookup_returns_its_output() {
        let command = std::process::Command::new("cat");
        let output = run_with_deadline(command, b"C:\\a.exe\tValve\n", std::time::Duration::from_secs(5));
        assert_eq!(output.unwrap(), "C:\\a.exe\tValve\n");
    }
}
