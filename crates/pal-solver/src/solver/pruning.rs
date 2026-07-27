//! Result pruning: pick the best-first, top-N plans from all discovered
//! target-satisfying references.
//!
//! palcalc runs a chain of `IResultPruning` rules per equal-effort group
//! (`PruningRulesBuilder.Default`). We keep the load-bearing subset and collapse
//! the rest into a single lexicographic best-first ordering plus a duplicate
//! collapse:
//!
//! KEPT:
//!   * MinimumEffortPruning       -> primary sort by total effort
//!   * MinimumBreedingStepsPruning-> secondary sort by total breeding steps
//!   * MinimumWildPalsPruning     -> tertiary sort by wild pals used
//!   * VariedResultsPruning       -> simplified: drop plans with an identical
//!                                   species multiset to one already kept
//!   * ResultLimitPruning         -> take `limit`
//!
//! DROPPED (rationale):
//!   * OptimalIVsPruning          -> IV quality already decides working-set
//!                                   dominance (`working_set::dominates`); a
//!                                   second IV pass here is redundant for top-N.
//!   * MinimumCostPruning         -> surgery/gold cost is a later slice; cost is
//!                                   uniformly 0, so the rule is a no-op.
//!   * PreferredLocationPruning   -> needs full storage-location modeling; not
//!                                   yet wired into refs beyond a debug label.
//!   * MinimumReusePruning        -> pal-reuse accounting; marginal for top-N.
//!   * MinimumReferencedPlayers   -> multi-player save ownership; single-player
//!                                   focus for now.

use std::collections::HashMap;

use crate::solver::refs::PalRef;
use crate::solver::results::SolvedRef;

/// Accumulate species-occurrence counts across a reference's whole tree
/// (palcalc `AllReferences()` grouped by pal).
fn species_occurrences(r: &PalRef, out: &mut HashMap<u16, u32>) {
    *out.entry(r.species()).or_insert(0) += 1;
    if let PalRef::Bred(b) = r {
        species_occurrences(&b.parent1, out);
        species_occurrences(&b.parent2, out);
    }
}

/// Best-first order + duplicate collapse + limit. See module docs. Ranks on the
/// surgery-aware [`SolvedRef::effort`] (reference effort plus implant cost), so a
/// cheaper exact plan keeps priority over a surgery plan; equal-effort ties break
/// toward fewer implants (exact wins), then fewer steps / wild pals / species.
pub fn prune_results(mut results: Vec<SolvedRef>, limit: usize) -> Vec<SolvedRef> {
    results.sort_by(|a, b| {
        a.effort()
            .partial_cmp(&b.effort())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.implants.len().cmp(&b.implants.len()))
            .then(a.reference.num_breeding_steps().cmp(&b.reference.num_breeding_steps()))
            .then(a.reference.num_wild_pals().cmp(&b.reference.num_wild_pals()))
            .then(a.reference.species().cmp(&b.reference.species()))
    });

    let mut kept: Vec<SolvedRef> = Vec::new();
    let mut kept_sigs: Vec<HashMap<u16, u32>> = Vec::new();
    for r in results {
        if kept.len() >= limit {
            break;
        }
        let mut sig = HashMap::new();
        species_occurrences(&r.reference, &mut sig);
        if kept_sigs.iter().any(|s| *s == sig) {
            continue; // identical species multiset to a kept (better-or-equal) plan
        }
        kept_sigs.push(sig);
        kept.push(r);
    }
    kept
}
