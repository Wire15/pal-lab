//! Target specification — what the solver is asked to breed. Ported from
//! palcalc `PalSpecifier`.

use std::collections::HashSet;

use pal_data::types::{Gender, Guid, PassiveId};
use serde::{Deserialize, Serialize};

use crate::solver::refs::{EffPassive, PalRef, RefGender};

/// The pal to breed for: a specific species (interned index) or any species.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetPal {
    Species(u16),
    Any,
}

/// serde default for [`TargetSpec::max_irrelevant`] (palcalc default `1`).
fn default_max_irrelevant() -> u8 {
    1
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
    /// `MaxBredIrrelevantPassives`). `0..=4` (4 = effectively "any"). Default 1;
    /// `#[serde(default)]` so payloads omitting it deserialize to that default.
    #[serde(default = "default_max_irrelevant")]
    pub max_irrelevant: u8,
    /// Owned instance ids that MUST appear as leaves in every returned plan
    /// tree (Wave A pinning). Empty = no constraint. Pinned instances are
    /// exempt from the initial working-set reduction (see
    /// `engine::build_initial_content`) so they stay individually addressable,
    /// and results are post-filtered to trees containing every pin.
    #[serde(default)]
    pub pinned_parents: Vec<Guid>,
    /// Required active-skill (waza) moves the delivered pal MUST have, as
    /// enum-prefix-stripped save-side ids (e.g. `"AirCanon"`). Resolved at
    /// solve time: moves in the target species' own learnset are auto-satisfied
    /// by leveling (surfaced as `levelup_moves`, no breeding needed); AT MOST
    /// ONE remaining move threads through breeding (per-egg pass rate
    /// [`crate::solver::config::ACTIVE_INHERIT_RATE`], COMMUNITY-MEASURED);
    /// others need Skill Fruit ([`crate::solver::config::SkillFruitConfig`]).
    /// Empty = no move constraint. `#[serde(default)]` keeps older payloads
    /// deserializing.
    #[serde(default)]
    pub required_moves: Vec<String>,
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
            pinned_parents: Vec::new(),
            required_moves: Vec::new(),
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
        let mut seen_mv = HashSet::new();
        self.required_moves.retain(|m| seen_mv.insert(m.clone()));
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

    /// Surgery-aware satisfaction. Surgery only implants PASSIVES, so species,
    /// gender, and IV floors must all match exactly (same as [`is_satisfied_by`]);
    /// the only relaxation is that up to `max_implants` REQUIRED passives may be
    /// missing and covered by table implants. `unimplantable` holds required
    /// passive ids the surgery table refuses (special lottery tiers:
    /// Rainbow/WorldTree) — a missing passive in that set can never be covered.
    /// Returns:
    /// - `Some(vec![])` — exact satisfaction (no implants needed),
    /// - `Some(missing)` — satisfiable with the listed implants (`0 < len <= max_implants`),
    /// - `None` — cannot satisfy even with `max_implants` implants (or a
    ///   non-passive constraint fails).
    ///
    /// The returned ids are ordered as in [`Self::required_passives`] for stable
    /// plan output. With `max_implants == 0` this is exactly [`is_satisfied_by`].
    pub fn satisfied_with_surgery(
        &self,
        r: &PalRef,
        max_implants: u8,
        unimplantable: &HashSet<PassiveId>,
    ) -> Option<Vec<PassiveId>> {
        if let TargetPal::Species(idx) = self.pal {
            if r.species() != idx {
                return None;
            }
        }

        if let Some(g) = self.required_gender {
            match r.gender() {
                RefGender::Wildcard => {}
                RefGender::Male if g == Gender::Male => {}
                RefGender::Female if g == Gender::Female => {}
                _ => return None,
            }
        }

        let ivs = r.ivs();
        let stats = [ivs.hp, ivs.attack, ivs.defense];
        for (target, iv) in self.iv_targets().into_iter().zip(stats) {
            if target > 0 && !iv.satisfies(target) {
                return None;
            }
        }

        let held: HashSet<&PassiveId> =
            r.effective_passives().iter().filter_map(EffPassive::desired).collect();
        let missing: Vec<PassiveId> =
            self.required_passives.iter().filter(|p| !held.contains(p)).cloned().collect();
        if missing.len() as u32 > max_implants as u32
            || missing.iter().any(|p| unimplantable.contains(p))
        {
            return None;
        }
        Some(missing)
    }
}
