//! OrigamiVPN: the user's own routes for apps and sites, put in front of the subscription's rules.
//!
//! The subscription and its template stay as they are: removing a route brings back the original
//! behaviour. "Through the VPN" goes to a group of our own, so the user picks its server on the
//! Servers tab like for any other service.
use crate::config::IOrigamiRoute;
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_yaml_ng::{Mapping, Sequence, Value};
use std::sync::LazyLock;

/// The selector "through the VPN" routes use; the UI looks it up by this name.
pub const OWN_GROUP: &str = "⭐ Свои правила";
/// Its members are copied from here: our Auto group and every server, without the direct outbound.
const SOURCE_GROUP: &str = "🚫 Заблокированные сервисы";

/// Local networks, kept direct ahead of "through the VPN" routes: those go first in the rules, before
/// the subscription's own private-network rules, so a game sent through the VPN would otherwise send
/// its LAN play and the router page to the server as well.
const LAN_LINES: [&str; 11] = [
    "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
    "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,169.254.0.0/16,DIRECT,no-resolve",
    "IP-CIDR,224.0.0.0/4,DIRECT,no-resolve",
    "IP-CIDR,255.255.255.255/32,DIRECT,no-resolve",
    "IP-CIDR6,::1/128,DIRECT,no-resolve",
    "IP-CIDR6,fc00::/7,DIRECT,no-resolve",
    "IP-CIDR6,fe80::/10,DIRECT,no-resolve",
    "IP-CIDR6,ff00::/8,DIRECT,no-resolve",
];
const BUILTIN_OUTBOUNDS: [&str; 5] = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"];
const NOT_SERVER_TYPES: [&str; 4] = ["direct", "reject", "dns", "pass"];

/// Programs that go one way together: the UI reads the same file (src/origami/routes/linked.ts).
const FAMILIES_JSON: &str = include_str!("../../../src/origami/routes/families.json");

/// File names many unrelated programs use; the UI reads the same file (src/origami/routes/linked.ts).
const GENERIC_NAMES_JSON: &str = include_str!("../../../src/origami/routes/generic-names.json");

static GENERIC_NAMES: LazyLock<Vec<String>> =
    LazyLock::new(|| serde_json::from_str(GENERIC_NAMES_JSON).unwrap_or_default());

pub fn is_generic_name(name: &str) -> bool {
    GENERIC_NAMES.contains(&name.to_lowercase())
}

#[derive(Deserialize)]
struct FamilySource {
    names: String,
    paths: String,
}

struct Family {
    source: FamilySource,
    name_test: Regex,
}

static FAMILIES: LazyLock<Vec<Family>> = LazyLock::new(|| {
    serde_json::from_str::<Vec<FamilySource>>(FAMILIES_JSON)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|source| {
            let name_test = RegexBuilder::new(&source.names).case_insensitive(true).build().ok()?;
            Some(Family { source, name_test })
        })
        .collect()
});

pub fn use_origami_routes(mut config: Mapping, routes: &[IOrigamiRoute]) -> Mapping {
    let has_group = ensure_own_group(&mut config);

    // A program's own rule goes before the ones that only cover it, so that it can differ from them.
    let ours: Vec<String> = routes
        .iter()
        .filter_map(|route| rule_line(route, has_group))
        .chain(routes.iter().flat_map(|route| linked_lines(route, has_group)))
        .collect();
    if ours.is_empty() {
        return config;
    }
    let through_vpn = ours.iter().any(|line| line.ends_with(&format!(",{OWN_GROUP}")));
    let lines: Sequence = LAN_LINES
        .iter()
        .filter(|_| through_vpn)
        .map(|line| (*line).to_owned())
        .chain(ours)
        .map(Value::from)
        .collect();

    // App rules need the core to look up which process opened a connection.
    if routes.iter().any(|route| route.kind == "app") {
        let key = Value::from("find-process-mode");
        if config.get(&key).and_then(Value::as_str) == Some("off") {
            config.insert(key, Value::from("strict"));
        }
    }

    let key = Value::from("rules");
    let ours = config
        .get(&key)
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let mut rules = lines;
    rules.extend(ours);
    config.insert(key, Value::Sequence(rules));
    config
}

fn target_of(route: &IOrigamiRoute, has_group: bool) -> Option<&'static str> {
    match route.via.as_str() {
        "direct" => Some("DIRECT"),
        "vpn" if has_group => Some(OWN_GROUP),
        _ => None,
    }
}

/// What goes the same way as an app: its family and its folder.
fn linked_lines(route: &IOrigamiRoute, has_group: bool) -> Vec<String> {
    let mut lines = Vec::new();
    if route.kind != "app" {
        return lines;
    }
    let (Some(target), Some(name)) = (target_of(route, has_group), clean_process(&route.value)) else {
        return lines;
    };
    if let Some(family) = FAMILIES.iter().find(|family| family.name_test.is_match(&name)) {
        lines.push(format!("PROCESS-NAME-REGEX,(?i){},{target}", family.source.names));
        lines.push(format!("PROCESS-PATH-REGEX,(?i){},{target}", family.source.paths));
    }
    let also_names = route.also_names.iter().flatten();
    lines.extend(
        also_names
            .filter_map(|name| clean_process(name))
            .map(|name| format!("PROCESS-NAME,{name},{target}")),
    );
    let folders = route.folder.iter().chain(route.also_folders.iter().flatten());
    lines.extend(
        folders
            .filter_map(|folder| folder_pattern(folder))
            .map(|pattern| format!("PROCESS-PATH-REGEX,{pattern},{target}")),
    );
    lines
}

/// Everything under a Windows folder, as in `folderPattern` of linked.ts.
fn folder_pattern(folder: &str) -> Option<String> {
    let mut chars = folder.chars();
    let is_windows_path = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.next() == Some(':')
        && chars.next() == Some('\\')
        && chars.next().is_some();
    if !is_windows_path || !valid_field(folder, true) {
        return None;
    }
    let mut pattern = String::from("(?i)^");
    for c in folder.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push_str(r"\\.*");
    Some(pattern)
}

fn rule_line(route: &IOrigamiRoute, has_group: bool) -> Option<String> {
    let target = target_of(route, has_group)?;
    match route.kind.as_str() {
        // With a folder a common name adds nothing but other programs: the folder rule has this one.
        "app" => clean_process(&route.value)
            .filter(|name| !(is_generic_name(name) && route.folder.as_deref().and_then(folder_pattern).is_some()))
            .map(|name| format!("PROCESS-NAME,{name},{target}")),
        "site" => clean_domain(&route.value).map(|domain| format!("DOMAIN-SUFFIX,{domain},{target}")),
        _ => None,
    }
}

/// A process name as the core reports it: the file name, without a folder.
fn clean_process(value: &str) -> Option<String> {
    let name = value.trim().rsplit(['/', '\\']).next().unwrap_or_default().trim();
    // Windows names may hold spaces ("League of Legends.exe"); the core splits a rule on commas only.
    valid_field(name, true).then(|| name.to_owned())
}

/// `https://www.Example.com/path` -> `example.com`; `*.example.com` -> `example.com`.
fn clean_domain(value: &str) -> Option<String> {
    let mut domain = value.trim().to_lowercase();
    if let Some((_, rest)) = domain.split_once("://") {
        domain = rest.to_owned();
    }
    let host = domain.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    let host = host.split(':').next().unwrap_or_default();
    // "www." would leave the bare domain and its other subdomains out of the rule.
    let host = host
        .trim_start_matches("*.")
        .trim_start_matches("www.")
        .trim_matches('.');
    (valid_field(host, false) && host.contains('.')).then(|| host.to_owned())
}

// One field of a rule line: no separators the core would read as another field.
fn valid_field(value: &str, spaces: bool) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|c| c == ',' || c.is_control() || (c.is_whitespace() && !(spaces && c == ' ')))
}

/// Adds our selector unless it is there already; false when there is no server to put in it.
fn ensure_own_group(config: &mut Mapping) -> bool {
    let groups_key = Value::from("proxy-groups");
    let mut groups = config
        .get(&groups_key)
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    if groups.iter().any(|group| group_name(group) == Some(OWN_GROUP)) {
        return true;
    }

    let members = vpn_members(config, &groups);
    // A subscription may list its servers only through providers; the group then takes them all.
    let providers: Vec<Value> = config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .into_iter()
        .flat_map(Mapping::keys)
        .filter(|name| name.as_str().is_some())
        .cloned()
        .collect();
    if members.is_empty() && providers.is_empty() {
        return false;
    }
    let mut group = Mapping::new();
    group.insert(Value::from("name"), Value::from(OWN_GROUP));
    group.insert(Value::from("type"), Value::from("select"));
    if members.is_empty() {
        group.insert(Value::from("use"), Value::Sequence(providers));
    } else {
        group.insert(
            Value::from("proxies"),
            Value::Sequence(members.into_iter().map(Value::from).collect()),
        );
    }
    groups.push(Value::Mapping(group));
    config.insert(groups_key, Value::Sequence(groups));
    true
}

fn vpn_members(config: &Mapping, groups: &Sequence) -> Vec<String> {
    let not_servers: Vec<&str> = config
        .get("proxies")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter(|proxy| {
            proxy
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| NOT_SERVER_TYPES.contains(&kind.to_lowercase().as_str()))
        })
        .filter_map(|proxy| proxy.get("name").and_then(Value::as_str))
        .collect();
    let is_server = |name: &str| !BUILTIN_OUTBOUNDS.contains(&name) && !not_servers.contains(&name);

    let source = groups.iter().find(|group| group_name(group) == Some(SOURCE_GROUP));
    if let Some(source) = source {
        return source
            .get("proxies")
            .and_then(Value::as_sequence)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| is_server(name))
            .map(str::to_owned)
            .collect();
    }

    // Another subscription: every server it lists.
    config
        .get("proxies")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(|proxy| proxy.get("name").and_then(Value::as_str))
        .filter(|name| is_server(name))
        .map(str::to_owned)
        .collect()
}

fn group_name(group: &Value) -> Option<&str> {
    group.get("name").and_then(Value::as_str)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    fn route(kind: &str, value: &str, via: &str) -> IOrigamiRoute {
        IOrigamiRoute {
            kind: kind.into(),
            value: value.into(),
            via: via.into(),
            ..Default::default()
        }
    }

    fn config() -> Mapping {
        serde_yaml_ng::from_str(
            r#"
find-process-mode: strict
proxies:
  - { name: "🔓 БЕЗ ПРОКСИ (Прямое соединение)", type: direct }
  - { name: "🇫🇮 Финляндия", type: vless }
  - { name: "🇸🇪 Швеция", type: vless }
proxy-groups:
  - name: "🚫 Заблокированные сервисы"
    type: select
    proxies: ["🎲 Авто-выбор (Лучший пинг)", "🔓 БЕЗ ПРОКСИ (Прямое соединение)", "🇫🇮 Финляндия", "🇸🇪 Швеция"]
  - name: "🎲 Авто-выбор (Лучший пинг)"
    type: url-test
    proxies: ["🇫🇮 Финляндия", "🇸🇪 Швеция"]
rules:
  - "PROCESS-NAME,steam.exe,DIRECT"
  - "MATCH,🚫 Заблокированные сервисы"
"#,
        )
        .unwrap()
    }

    fn raw_rules(config: &Mapping) -> Vec<&str> {
        config["rules"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect()
    }

    /// Without the local network lines, which the LAN test checks on its own.
    fn rules(config: &Mapping) -> Vec<&str> {
        raw_rules(config)
            .into_iter()
            .filter(|line| !LAN_LINES.contains(line))
            .collect()
    }

    fn own_group(config: &Mapping) -> &Value {
        config["proxy-groups"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|group| group_name(group) == Some(OWN_GROUP))
            .expect("own group")
    }

    #[test]
    fn no_routes_leaves_the_rules_alone() {
        let out = use_origami_routes(config(), &[]);
        assert_eq!(rules(&out), rules(&config()));
    }

    #[test]
    fn own_group_takes_auto_and_servers_but_not_direct() {
        let out = use_origami_routes(config(), &[]);
        let members: Vec<&str> = own_group(&out)["proxies"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(members, ["🎲 Авто-выбор (Лучший пинг)", "🇫🇮 Финляндия", "🇸🇪 Швеция"]);
    }

    #[test]
    fn routes_go_first_and_override_ours() {
        let out = use_origami_routes(
            config(),
            &[
                route("app", "steam.exe", "vpn"),
                route("site", "https://www.Example.com/a?b", "direct"),
            ],
        );
        assert_eq!(
            rules(&out),
            [
                "PROCESS-NAME,steam.exe,⭐ Свои правила",
                "DOMAIN-SUFFIX,example.com,DIRECT",
                "PROCESS-NAME,steam.exe,DIRECT",
                "MATCH,🚫 Заблокированные сервисы",
            ]
        );
    }

    #[test]
    fn a_full_path_becomes_the_process_name() {
        assert_eq!(
            clean_process(r"C:\Games\Tarkov\EscapeFromTarkov.exe").as_deref(),
            Some("EscapeFromTarkov.exe")
        );
        assert_eq!(clean_process("/usr/bin/firefox").as_deref(), Some("firefox"));
        assert_eq!(
            clean_process(" League of Legends.exe ").as_deref(),
            Some("League of Legends.exe")
        );
    }

    #[test]
    fn values_that_would_break_the_rule_line_are_dropped() {
        let out = use_origami_routes(
            config(),
            &[
                route("app", "evil.exe,DIRECT", "vpn"),
                route("site", "not a domain", "direct"),
                route("site", "localhost", "direct"),
                route("app", "  ", "direct"),
                route("site", "*.example.org", "boom"),
            ],
        );
        assert_eq!(rules(&out), rules(&config()));
    }

    #[test]
    fn wildcard_and_port_are_trimmed() {
        assert_eq!(clean_domain("*.example.org").as_deref(), Some("example.org"));
        assert_eq!(clean_domain("example.org:8443").as_deref(), Some("example.org"));
    }

    #[test]
    fn app_routes_turn_process_lookup_on() {
        let mut base = config();
        base.insert("find-process-mode".into(), "off".into());
        let out = use_origami_routes(base, &[route("app", "game.exe", "direct")]);
        assert_eq!(out["find-process-mode"].as_str(), Some("strict"));
    }

    #[test]
    fn without_servers_vpn_routes_are_skipped_and_direct_ones_kept() {
        let base: Mapping = serde_yaml_ng::from_str("rules: [\"MATCH,DIRECT\"]").unwrap();
        let out = use_origami_routes(base, &[route("app", "a.exe", "vpn"), route("app", "b.exe", "direct")]);
        assert_eq!(rules(&out), ["PROCESS-NAME,b.exe,DIRECT", "MATCH,DIRECT"]);
        assert!(out.get("proxy-groups").is_none());
    }

    #[test]
    fn a_program_through_the_vpn_still_reaches_the_local_network_directly() {
        // The subscription keeps its private networks direct further down; our lines come first.
        let out = use_origami_routes(config(), &[route("app", "game.exe", "vpn")]);
        let lines = raw_rules(&out);
        let ours = lines
            .iter()
            .position(|line| line.starts_with("PROCESS-NAME,game.exe,"))
            .unwrap();
        for lan in [
            "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
            "IP-CIDR6,fe80::/10,DIRECT,no-resolve",
        ] {
            let at = lines.iter().position(|line| *line == lan).expect(lan);
            assert!(at < ours, "{lan} after the program rule");
        }
    }

    #[test]
    fn direct_routes_alone_add_no_local_network_lines() {
        let out = use_origami_routes(config(), &[route("app", "game.exe", "direct")]);
        assert!(!raw_rules(&out).iter().any(|line| line.starts_with("IP-CIDR")));
    }

    #[test]
    fn a_subscription_with_providers_only_still_gets_vpn_routes() {
        // Servers listed only through proxy-providers: the rule used to be dropped while the app
        // said it was added.
        let base: Mapping = serde_yaml_ng::from_str(
            "proxy-providers: {main: {type: http, url: \"https://example.com/list\"}}\nrules: [\"MATCH,DIRECT\"]",
        )
        .unwrap();
        let out = use_origami_routes(base, &[route("app", "a.exe", "vpn")]);
        assert_eq!(
            rules(&out),
            [format!("PROCESS-NAME,a.exe,{OWN_GROUP}"), "MATCH,DIRECT".to_owned()]
        );
        let group = own_group(&out);
        assert_eq!(group.get("use").and_then(Value::as_sequence).map(Vec::len), Some(1));
    }

    #[test]
    fn a_program_of_a_family_brings_the_whole_family() {
        let out = use_origami_routes(config(), &[route("app", "Wow.exe", "direct")]);
        let lines = rules(&out);
        assert_eq!(lines[0], "PROCESS-NAME,Wow.exe,DIRECT");
        assert!(lines[1].starts_with("PROCESS-NAME-REGEX,(?i)^(battle"));
        assert!(lines[1].ends_with(",DIRECT"));
        assert!(lines[2].starts_with("PROCESS-PATH-REGEX,(?i).*"));
        assert_eq!(lines[3], "PROCESS-NAME,steam.exe,DIRECT");
    }

    #[test]
    fn the_family_patterns_have_one_field_each() {
        let sources: Vec<serde_json::Value> = serde_json::from_str(FAMILIES_JSON).unwrap();
        // None may be lost to a pattern the core could not read.
        assert_eq!(FAMILIES.len(), sources.len());
        for (family, source) in FAMILIES.iter().zip(&sources) {
            assert!(!family.source.names.contains(','));
            assert!(!family.source.paths.contains(','));
            // A route on a program known by its path alone is stored under this name.
            assert!(family.name_test.is_match(source["main"].as_str().unwrap()));
            assert!(!family.name_test.is_match("steam.exe"));
            let paths = Regex::new(&format!("(?i){}", family.source.paths)).unwrap();
            assert!(!paths.is_match(r"C:\Program Files\Other\Agent.exe"));
        }
    }

    #[test]
    fn a_launcher_brings_the_game_of_its_family() {
        let out = use_origami_routes(config(), &[route("app", "BsgLauncher.exe", "direct")]);
        let lines = rules(&out);
        assert!(lines[1].contains("escapefromtarkov"), "{}", lines[1]);
        assert!(lines[2].contains("battlestate games"), "{}", lines[2]);
        assert!(!lines[1].contains("battle\\.net"), "{}", lines[1]);
    }

    #[test]
    fn a_folder_covers_its_programs_after_the_own_rules() {
        let mut game = route("app", "mygame.exe", "direct");
        game.folder = Some(r"D:\Games\My Game (x64)".into());
        let out = use_origami_routes(config(), &[game, route("app", "helper.exe", "vpn")]);
        assert_eq!(
            &rules(&out)[..3],
            [
                "PROCESS-NAME,mygame.exe,DIRECT",
                "PROCESS-NAME,helper.exe,⭐ Свои правила",
                r"PROCESS-PATH-REGEX,(?i)^D:\\Games\\My Game \(x64\)\\.*,DIRECT",
            ]
        );
    }

    #[test]
    fn programs_of_one_publisher_go_together_with_their_folders() {
        let mut game = route("app", "mygame.exe", "direct");
        game.folder = Some(r"D:\Game".into());
        game.publisher = Some("Some Studio".into());
        game.also_names = Some(vec!["launcher.exe".into(), "bad,DIRECT".into()]);
        game.also_folders = Some(vec![r"C:\Launcher".into(), "/usr/bin".into()]);
        let out = use_origami_routes(config(), &[game]);
        assert_eq!(
            &rules(&out)[..4],
            [
                "PROCESS-NAME,mygame.exe,DIRECT",
                "PROCESS-NAME,launcher.exe,DIRECT",
                r"PROCESS-PATH-REGEX,(?i)^D:\\Game\\.*,DIRECT",
                r"PROCESS-PATH-REGEX,(?i)^C:\\Launcher\\.*,DIRECT",
            ]
        );
    }

    #[test]
    fn a_common_name_goes_by_its_folder_alone() {
        let mut launcher = route("app", "Launcher.exe", "direct");
        launcher.folder = Some(r"D:\Warframe\Tools".into());
        let out = use_origami_routes(config(), &[launcher]);
        assert_eq!(
            &rules(&out)[..2],
            [
                r"PROCESS-PATH-REGEX,(?i)^D:\\Warframe\\Tools\\.*,DIRECT",
                "PROCESS-NAME,steam.exe,DIRECT",
            ]
        );
    }

    #[test]
    fn a_common_name_without_a_folder_stays_by_name() {
        let out = use_origami_routes(config(), &[route("app", "game.exe", "direct")]);
        assert_eq!(rules(&out)[0], "PROCESS-NAME,game.exe,DIRECT");
        assert!(is_generic_name("LAUNCHER.EXE"));
        assert!(!is_generic_name("dota2.exe"));
    }

    #[test]
    fn a_folder_that_is_not_a_windows_one_is_dropped() {
        for folder in ["/usr/bin", "C:", r"C:\", "D:\\a,DIRECT"] {
            assert_eq!(folder_pattern(folder), None, "{folder}");
        }
    }

    #[test]
    fn another_subscription_uses_all_its_servers() {
        let base: Mapping = serde_yaml_ng::from_str(
            "proxies: [{ name: a, type: ss }, { name: d, type: direct }]\nproxy-groups: [{ name: P, type: select, proxies: [a] }]",
        )
        .unwrap();
        let out = use_origami_routes(base, &[]);
        assert_eq!(
            own_group(&out)["proxies"].as_sequence().unwrap(),
            &vec![Value::from("a")]
        );
    }
}
