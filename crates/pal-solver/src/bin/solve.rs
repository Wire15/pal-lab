//! `solve` CLI: read a save directory, solve for a target pal + passives, and
//! print the best breeding plans as an indented tree.
//!
//! Usage:
//!   solve <save-dir> <target-species> [passive]... [--max-steps N] [--wild] [--cake <kind>]
//!
//! `--cake` accepts normal (default), mushroom, vegetable, deluxe, special.
//!
//! `target-species` and `passive` accept either an internal id (`Anubis`,
//! `Legend`) or an English display name.

use std::process::ExitCode;

use pal_data::types::PassiveId;
use pal_data::GameData;
use pal_solver::solver::{
    resolve_passive, resolve_species, solve, CakeKind, PlanNode, PlanSource, SolverConfig,
    TargetPal, TargetSpec,
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            eprintln!(
                "\nusage: solve <save-dir> <target-species> [passive]... [--max-steps N] [--wild]"
            );
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let mut positional: Vec<&str> = Vec::new();
    let mut max_steps: Option<u32> = None;
    let mut wild = false;
    let mut cake = CakeKind::Normal;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--wild" => wild = true,
            "--max-steps" => {
                i += 1;
                let v = args.get(i).ok_or("--max-steps needs a value")?;
                max_steps = Some(v.parse().map_err(|_| format!("invalid --max-steps: {v}"))?);
            }
            "--cake" => {
                i += 1;
                let v = args.get(i).ok_or("--cake needs a value")?;
                cake = v.parse()?;
            }
            other => positional.push(other),
        }
        i += 1;
    }

    if positional.len() < 2 {
        return Err("need a save dir and a target species".into());
    }
    let save_dir = positional[0];
    let target_name = positional[1];
    let passive_names = &positional[2..];

    let gd = GameData::get();

    let target_species = resolve_species(gd, target_name)
        .ok_or_else(|| format!("unknown pal: {target_name}"))?;
    let required_passives: Vec<PassiveId> = passive_names
        .iter()
        .map(|n| resolve_passive(gd, n).ok_or_else(|| format!("unknown passive: {n}")))
        .collect::<Result<_, _>>()?;

    let mut cfg = SolverConfig { allow_wild: wild, cake, ..SolverConfig::default() };
    if let Some(n) = max_steps {
        cfg.max_breeding_steps = n;
        cfg.max_solver_iterations = n;
    }

    let mut spec = TargetSpec::new(TargetPal::Species(target_species));
    spec.required_passives = required_passives;

    let save = pal_save::read_save_dir(save_dir).map_err(|e| format!("reading save: {e}"))?;
    println!(
        "Loaded {} pals from {}{}",
        save.pals.len(),
        save_dir,
        save.world_name.as_deref().map(|w| format!(" ({w})")).unwrap_or_default()
    );
    for w in &save.warnings {
        eprintln!("warning: {w}");
    }

    let target_display = gd.species_at(target_species).map(|s| s.name.as_str()).unwrap_or(target_name);
    println!(
        "Solving for {target_display} with [{}]  (max_steps={}, wild={}, cake={:?})\n",
        passive_names.join(", "),
        cfg.max_breeding_steps,
        wild,
        cake
    );

    let plans = solve(gd, &spec, &save.pals, &cfg);
    if plans.is_empty() {
        println!("No breeding path found.");
        return Ok(());
    }

    for (idx, plan) in plans.iter().enumerate() {
        println!(
            "=== Plan {} — {} ({} steps, {} wild) ===",
            idx + 1,
            fmt_duration(plan.total_time_secs),
            plan.total_steps,
            plan.total_wild_pals
        );
        if plan.cake_count > 0 {
            println!("    needs ~{} {:?} Cake(s)", plan.cake_count, plan.cake);
        }
        print_node(&plan.root, 0);
        println!();
    }
    Ok(())
}

fn print_node(node: &PlanNode, depth: usize) {
    let indent = "  ".repeat(depth);
    let gender = match node.gender {
        Some(pal_data::types::Gender::Male) => " ♂",
        Some(pal_data::types::Gender::Female) => " ♀",
        None => "",
    };
    let source = match &node.source {
        PlanSource::Owned { location } => format!("owned @ {location}"),
        PlanSource::Wild { captures } => format!("wild (~{captures} catches)"),
        PlanSource::Bred => format!(
            "bred p={:.4}, self {}",
            node.probability,
            fmt_duration(node.est_time_secs)
        ),
    };
    let passives = if node.passives.is_empty() {
        "no passives".to_string()
    } else {
        node.passives.join(", ")
    };
    println!("{indent}- {}{gender} [{passives}] — {source}", node.species_name);
    for child in &node.children {
        print_node(child, depth + 1);
    }
}

fn fmt_duration(secs: f64) -> String {
    if !secs.is_finite() {
        return "∞".to_string();
    }
    let total = secs.round() as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h}h{m:02}m")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}
