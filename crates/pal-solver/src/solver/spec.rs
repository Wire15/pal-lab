//! Target specification — what the solver is asked to breed. Ported from
//! palcalc `PalSpecifier`.

use std::collections::HashSet;

use pal_data::types::{Gender, PassiveId};
use serde::{Deserialize, Serialize};

use crate::solver::refs::{EffPassive, PalRef, RefGender};

/// The pal to breed for: a specific species (interned index) or any species.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetPal {
    Species(u16),
    Any,
}

/// What the caller wants. `required_passives` MUST all be present; `optional_passives`
/// are inherited when free. IV thresholds of `0` mean "don't care"; a non-zero
/// threshold means the stat matters and the result's floor must meet it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetSpec {
    pub pal: TargetPal,
    pub required_passives: Vec<PassiveId>,
    pub optional_passives: Vec<PassiveId>,
    pub iv_hp: u8,
    pub iv_attack: u8,
    pub iv_defense: u8,
    pub required_gender: Option<Gender>,
    /// Max irrelevant passives tolerated on bred children (palcalc
    /// `MaxBredIrrelevantPassives`). Default 1.
    pub max_irrelevant: u8,
}

impl TargetSpec {
    pub fn new(pal: TargetPal) -> TargetSpec {
        TargetSpec {
            pal,
            required_passives: Vec::new(),
            optional_passives: Vec::new(),
            iv_hp: 0,
            iv_attack: 0,
            iv_defense: 0,
            required_gender: None,
            max_irrelevant: 1,
        }
    }

    /// Dedup required, and drop optionals already required (palcalc `Normalize`).
    pub fn normalize(&mut self) {
        let mut seen = HashSet::new();
        self.required_passives.retain(|p| seen.insert(p.clone()));
        let req: HashSet<&PassiveId> = self.required_passives.iter().collect();
        let mut seen_opt = HashSet::new();
        self.optional_passives
            .retain(|p| !req.contains(p) && seen_opt.insert(p.clone()));
    }

    /// All desired passives (required + optional).
    pub fn desired_passives(&self) -> Vec<PassiveId> {
        self.required_passives
            .iter()
            .chain(self.optional_passives.iter())
            .cloned()
            .collect()
    }

    pub fn desired_set(&self) -> HashSet<PassiveId> {
        self.desired_passives().into_iter().collect()
    }

    #[inline]
    fn iv_targets(&self) -> [u8; 3] {
        [self.iv_hp, self.iv_attack, self.iv_defense]
    }

    /// palcalc `PalSpecifier.IsSatisfiedBy`: right species, all required passives
    /// present, gender compatible, IV floors met.
    pub fn is_satisfied_by(&self, r: &PalRef) -> bool {
        if let TargetPal::Species(idx) = self.pal {
            if r.species() != idx {
                return false;
            }
        }

        let held: HashSet<&PassiveId> =
            r.effective_passives().iter().filter_map(EffPassive::desired).collect();
        if !self.required_passives.iter().all(|p| held.contains(p)) {
            return false;
        }

        if let Some(g) = self.required_gender {
            match r.gender() {
                RefGender::Wildcard => {}
                RefGender::Male if g == Gender::Male => {}
                RefGender::Female if g == Gender::Female => {}
                _ => return false,
            }
        }

        let ivs = r.ivs();
        let stats = [ivs.hp, ivs.attack, ivs.defense];
        for (target, iv) in self.iv_targets().into_iter().zip(stats) {
            if target > 0 && !iv.satisfies(target) {
                return false;
            }
        }
        true
    }
}
