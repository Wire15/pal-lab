//! `dump`: read a Palworld save directory and print a roster summary.
//!
//! Usage: `dump <save-dir>` where `<save-dir>` contains `Level.sav`.

use std::collections::HashMap;
use std::time::Instant;

use pal_data::types::OwnedPal;

fn main() {
    let dir = match std::env::args().nth(1) {
        Some(d) => d,
        None => {
            eprintln!("usage: dump <save-directory>");
            std::process::exit(2);
        }
    };

    let started = Instant::now();
    let save = match pal_save::read_save_dir(&dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fatal: {e}");
            std::process::exit(1);
        }
    };
    let elapsed = started.elapsed();

    println!(
        "World: {}",
        save.world_name.as_deref().unwrap_or("<unknown>")
    );

    println!("Players ({}):", save.players.len());
    for p in &save.players {
        let name = if p.name.is_empty() {
            "<unnamed>"
        } else {
            &p.name
        };
        println!("  {}  {name}", hex_guid(&p.uid));
    }

    println!("Total pals: {}", save.pals.len());

    println!("By container:");
    for (kind, count) in counts(&save.pals, |p| format!("{:?}", p.container_kind)) {
        println!("  {kind}: {count}");
    }

    println!("Top species:");
    for (species, count) in counts(&save.pals, |p| p.character_id.clone())
        .into_iter()
        .take(10)
    {
        println!("  {species}: {count}");
    }

    println!("Sample pals:");
    for pal in save.pals.iter().take(5) {
        let gender = pal
            .gender
            .map(|g| format!("{g:?}"))
            .unwrap_or_else(|| "?".into());
        let nick = pal
            .nickname
            .as_deref()
            .map(|n| format!(" \"{n}\""))
            .unwrap_or_default();
        println!(
            "  {boss}{id}{nick}  L{lvl} rank{rank} {gender}  IV(hp {hp}, atk {atk}, def {def})  passives[{np}]: {passives}",
            boss = if pal.is_boss { "BOSS " } else { "" },
            id = pal.character_id,
            lvl = pal.level,
            rank = pal.rank,
            hp = pal.ivs.hp,
            atk = pal.ivs.attack,
            def = pal.ivs.defense,
            np = pal.passives.len(),
            passives = pal.passives.join(", "),
        );
    }

    if !save.warnings.is_empty() {
        println!("Warnings ({}):", save.warnings.len());
        for w in save.warnings.iter().take(5) {
            println!("  {w}");
        }
    }

    println!("Elapsed: {} ms", elapsed.as_millis());
}

/// Frequency count keyed by `key`, sorted by descending count then key.
fn counts(pals: &[OwnedPal], key: impl Fn(&OwnedPal) -> String) -> Vec<(String, usize)> {
    let mut map: HashMap<String, usize> = HashMap::new();
    for pal in pals {
        *map.entry(key(pal)).or_default() += 1;
    }
    let mut out: Vec<_> = map.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

fn hex_guid(g: &[u8; 16]) -> String {
    let mut s = String::with_capacity(32);
    for b in g {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
