//! OrigamiVPN: game mode in the core config. A Hysteria2 proxy whose server is the local
//! multiplexer (core/game_link.rs), the game's programs sent to it ahead of every other rule, and the
//! multiplexer's own paths kept past the TUN and the rules.
use crate::core::game_link::GameLinkConfig;
use serde_yaml_ng::{Mapping, Sequence, Value};

pub const PROXY_NAME: &str = "🎮 Игровой режим";

pub fn use_game_link(mut config: Mapping, game: &GameLinkConfig) -> Mapping {
    let mut proxy = Mapping::new();
    for (key, value) in [
        ("name", Value::from(PROXY_NAME)),
        ("type", Value::from("hysteria2")),
        ("server", Value::from("127.0.0.1")),
        ("port", Value::from(game.port)),
        ("password", Value::from(game.password.as_str())),
        ("sni", Value::from(game.sni.as_str())),
        ("fingerprint", Value::from(game.fingerprint.as_str())),
        ("udp", Value::from(true)),
    ] {
        proxy.insert(Value::from(key), value);
    }
    proxy.insert(Value::from("alpn"), Value::Sequence(vec![Value::from("h3")]));

    let proxies = config
        .entry(Value::from("proxies"))
        .or_insert_with(|| Value::Sequence(Sequence::new()));
    if let Value::Sequence(list) = proxies {
        list.retain(|item| item.get("name").and_then(Value::as_str) != Some(PROXY_NAME));
        list.push(Value::Mapping(proxy));
    }

    // The paths go direct (outside the TUN they never reach the core, inside a proxy-mode run they
    // might); then the game's programs to game mode. All of it ahead of the subscription's rules.
    let mut ours: Vec<Value> = game
        .path_ips()
        .iter()
        .map(|ip| {
            let rule = if ip.is_ipv4() { "IP-CIDR" } else { "IP-CIDR6" };
            let bits = if ip.is_ipv4() { 32 } else { 128 };
            Value::from(format!("{rule},{ip}/{bits},DIRECT,no-resolve"))
        })
        .collect();
    ours.extend(
        game.apps
            .iter()
            .filter(|app| !app.trim().is_empty() && !app.contains(','))
            .map(|app| Value::from(format!("PROCESS-NAME,{},{PROXY_NAME}", app.trim()))),
    );
    let rules = config
        .entry(Value::from("rules"))
        .or_insert_with(|| Value::Sequence(Sequence::new()));
    if let Value::Sequence(list) = rules {
        let rest = std::mem::take(list);
        list.extend(ours);
        list.extend(rest);
    }

    // The multiplexer runs inside the app: its packets to the bridges must not loop into the TUN.
    if let Some(Value::Mapping(tun)) = config.get_mut(Value::from("tun")) {
        let excluded = tun
            .entry(Value::from("route-exclude-address"))
            .or_insert_with(|| Value::Sequence(Sequence::new()));
        if let Value::Sequence(list) = excluded {
            for ip in game.path_ips() {
                let bits = if ip.is_ipv4() { 32 } else { 128 };
                let cidr = Value::from(format!("{ip}/{bits}"));
                if !list.contains(&cidr) {
                    list.push(cidr);
                }
            }
        }
    }
    config
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn game() -> GameLinkConfig {
        GameLinkConfig::parse(
            r#"{"password":"secret","fingerprint":"aa11","paths":[{"name":"msk2","addr":"192.0.2.1:24443"},{"name":"spb","addr":"192.0.2.2:24443"},{"name":"direct","addr":"192.0.2.1:24443"}],"apps":["Wow.exe"]}"#,
        )
        .unwrap()
    }

    fn config() -> Mapping {
        serde_yaml_ng::from_str(
            "proxies:\n  - {name: A, type: vless}\nrules:\n  - PROCESS-NAME,Wow.exe,🎮 Игры\n  - MATCH,DIRECT\ntun:\n  enable: true\n  route-exclude-address: [10.0.0.0/8]\n",
        )
        .unwrap()
    }

    fn rules(config: &Mapping) -> Vec<String> {
        config["rules"]
            .as_sequence()
            .unwrap()
            .iter()
            .map(|rule| rule.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn the_game_goes_to_game_mode_ahead_of_the_subscription_rules() {
        let out = use_game_link(config(), &game());
        let rules = rules(&out);
        assert_eq!(
            rules[..3],
            [
                "IP-CIDR,192.0.2.1/32,DIRECT,no-resolve",
                "IP-CIDR,192.0.2.2/32,DIRECT,no-resolve",
                "PROCESS-NAME,Wow.exe,🎮 Игровой режим",
            ]
        );
        assert_eq!(rules.last().map(String::as_str), Some("MATCH,DIRECT"));
        let proxy = out["proxies"].as_sequence().unwrap().last().unwrap();
        assert_eq!(proxy["type"].as_str(), Some("hysteria2"));
        assert_eq!(proxy["server"].as_str(), Some("127.0.0.1"));
        assert_eq!(proxy["fingerprint"].as_str(), Some("aa11"));
    }

    #[test]
    fn the_paths_stay_out_of_the_tun() {
        let out = use_game_link(config(), &game());
        let excluded: Vec<&str> = out["tun"]["route-exclude-address"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(excluded, ["10.0.0.0/8", "192.0.2.1/32", "192.0.2.2/32"]);
    }

    #[test]
    fn building_twice_keeps_one_proxy() {
        let once = use_game_link(config(), &game());
        let twice = use_game_link(once, &game());
        let count = twice["proxies"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|item| item["name"].as_str() == Some(PROXY_NAME))
            .count();
        assert_eq!(count, 1);
    }
}
