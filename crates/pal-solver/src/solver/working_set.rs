//! The working set: the accumulated pool of optimal pal references, keyed so
//! that only the cheapest instance of each distinct (species, gender, passives,
//! IV-relevance) combination is kept. Ported from palcalc `WorkingSet` +
//! `PalPropertyGrouping` (its `DefaultGroupFn`) and its `IsOptimal` dominance.

use std::collections::HashMap;

use pal_data::types::PassiveId;

use crate::solver::refs::{passive_key, PalRef, RefGender};

/// Grouping key: palcalc `DefaultGroupFn = Pal + Gender + EffectivePassives + IvRelevance`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RefKey {
    pub species: u16,
    pub gender: RefGender,
    pub desired_passives: Vec<PassiveId>,
    pub random_passives: u8,
    pub iv_relevance: (bool, bool, bool),
}

pub fn key_of(r: &PalRef) -> RefKey {
    let (desired, random) = passive_key(r.effective_passives());
    RefKey {
        species: r.species(),
        gender: r.gender(),
        desired_passives: desired,
        random_passives: random,
        iv_relevance: r.ivs().relevance(),
    }
}

/// palcalc `WorkingSet.IsOptimal`: `candidate` beats `incumbent` on lower effort,
/// then lower cost (0 here — surgery not modeled), then higher max IVs, then
/// higher min IVs. Ties (equal on all axes) keep the incumbent.
pub fn dominates(candidate: &PalRef, incumbent: &PalRef) -> bool {
    let (ce, ie) = (candidate.total_effort(), incumbent.total_effort());
    if ce < ie {
        return true;
    }
    if ce > ie {
        return false;
    }
    // equal effort (cost tier omitted — always 0) -> compare IVs
    let sum_max = |r: &PalRef| {
        let iv = r.ivs();
        iv.hp.max as u32 + iv.attack.max as u32 + iv.defense.max as u32
    };
    let sum_min = |r: &PalRef| {
        let iv = r.ivs();
        iv.hp.min as u32 + iv.attack.min as u32 + iv.defense.min as u32
    };
    match sum_max(candidate).cmp(&sum_max(incumbent)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => sum_min(candidate) > sum_min(incumbent),
    }
}

/// One optimal reference per [`RefKey`].
#[derive(Debug, Default)]
pub struct WorkingSet {
    content: HashMap<RefKey, PalRef>,
}

impl WorkingSet {
    pub fn new() -> WorkingSet {
        WorkingSet { content: HashMap::new() }
    }

    /// Insert `r`, keeping it only if no equal-key ref exists or it dominates the
    /// existing one. Returns whether the working set changed.
    pub fn insert(&mut self, r: PalRef) -> bool {
        let key = key_of(&r);
        match self.content.get(&key) {
            Some(existing) if !dominates(&r, existing) => false,
            _ => {
                self.content.insert(key, r);
                true
            }
        }
    }

    /// The current best ref for a key, if any.
    pub fn get(&self, r: &PalRef) -> Option<&PalRef> {
        self.content.get(&key_of(r))
    }

    /// Whether `r` would be accepted (dominant or novel) — palcalc `IsOptimal`.
    pub fn is_optimal(&self, r: &PalRef) -> bool {
        match self.content.get(&key_of(r)) {
            Some(existing) => dominates(r, existing),
            None => true,
        }
    }

    pub fn len(&self) -> usize {
        self.content.len()
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &PalRef> {
        self.content.values()
    }

    pub fn to_vec(&self) -> Vec<PalRef> {
        self.content.values().cloned().collect()
    }
}
