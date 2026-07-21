//! Solver pal references — the "working set" element model.
//!
//! Ported from palcalc's `PalCalc.Solver.PalReference.*` (MIT). A [`PalRef`] is
//! any pal the solver can reason about: an owned instance (zero effort), a wild
//! catch (catch-time effort), or a bred child (parents' effort + self effort).
//!
//! Effort is an estimate of real-world seconds to acquire the pal, mirroring
//! palcalc's `BreedingEffort`/`SelfBreedingEffort` (see `README-BREED-ESTIMATE.md`).
//! Probability inputs to bred refs are supplied by the caller (the engine, via
//! [`crate::probabilities`]) — this module never calls the probability model, so
//! its effort math is unit-testable without the (sibling-owned) `todo!()` bodies.

use pal_data::types::{ContainerKind, Gender, Guid, PassiveId};
use pal_data::GameData;
use serde::{Deserialize, Serialize};

// ---- Effort constants (palcalc GameConstants / GameSettings.Defaults) -------

/// Base breeding time (palcalc `GameSettings.BreedingTime` = 5 min).
pub const BREEDING_TIME_SECS: f64 = 5.0 * 60.0;
/// Effective per-attempt breeding time. palcalc doubles the raw time
/// (`AvgBreedingTime`) to account for parents idling at night.
pub const AVG_BREEDING_TIME_SECS: f64 = BREEDING_TIME_SECS * 2.0;
/// Incubation time for a "massive"/huge egg (palcalc `MassiveEggIncubationTime`
/// = 2 h). Smaller eggs divide this down (see [`incubation_secs`]).
pub const MASSIVE_EGG_INCUBATION_SECS: f64 = 2.0 * 3600.0;
/// Minimum wild-catch time (palcalc `GameConstants.TimeToCatch` base = 3 min).
pub const CATCH_MIN_SECS: f64 = 3.0 * 60.0;

/// palcalc `GameSettings.MultipleBreedingFarms` default. When both parents are
/// bred, their efforts overlap (take the max) rather than summing.
pub const MULTIPLE_BREEDING_FARMS: bool = true;
/// palcalc `GameSettings.MultipleIncubators` default. Eggs incubate in parallel
/// with breeding, so self-effort is breeding-time + one incubation.
pub const MULTIPLE_INCUBATORS: bool = true;

/// Egg incubation time (seconds) for a species, keyed off its rarity.
///
/// palcalc `EggSize.IncubationTime` divides `MassiveEggIncubationTime` by a
/// size modifier; egg size is derived from rarity via `GameConstants.EggSizeMinRarity`
/// (`Huge >= 8`, `Large >= 5`, else `Normal`).
pub fn incubation_secs(rarity: u8) -> f64 {
    let modifier = if rarity >= 8 {
        1.0 // Huge  -> 2 h
    } else if rarity >= 5 {
        2.0 // Large -> 1 h
    } else {
        12.0 // Normal -> 10 min
    };
    MASSIVE_EGG_INCUBATION_SECS / modifier
}

/// palcalc `GameConstants.PassivesWildAtMostN`: probability a wild pal has at
/// most `n` random passives (uniform 20% per count, cumulative).
fn wild_passive_prob(num_random: u8) -> f64 {
    0.2 * (num_random.min(4) as f64 + 1.0)
}

/// Rough wild-catch time (seconds). palcalc uses the pal's sell price; our data
/// pack carries no price, so we approximate from `rarity` + variant flag.
/// (Documented deviation — see module map in the slice report.)
pub fn catch_secs(rarity: u8, is_variant: bool) -> f64 {
    CATCH_MIN_SECS + rarity as f64 * 30.0 + if is_variant { 300.0 } else { 0.0 }
}

// ---- Gender ------------------------------------------------------------------

/// Gender of a solver reference. `Wildcard` is palcalc's unresolved gender
/// (a composite owned pair, or a freshly bred/wild pal). We do not model
/// palcalc's `OPPOSITE_WILDCARD` optimization — wildcard parents are resolved to
/// a concrete gender with the equivalent probability penalty applied directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RefGender {
    Male,
    Female,
    Wildcard,
}

impl RefGender {
    #[inline]
    pub fn opposite(self) -> RefGender {
        match self {
            RefGender::Male => RefGender::Female,
            RefGender::Female => RefGender::Male,
            RefGender::Wildcard => RefGender::Wildcard,
        }
    }

    #[inline]
    pub fn concrete(self) -> Option<Gender> {
        match self {
            RefGender::Male => Some(Gender::Male),
            RefGender::Female => Some(Gender::Female),
            RefGender::Wildcard => None,
        }
    }

    /// Two parents can breed if they are not the same concrete gender.
    #[inline]
    pub fn compatible_with(self, other: RefGender) -> bool {
        match (self, other) {
            (RefGender::Wildcard, _) | (_, RefGender::Wildcard) => true,
            (a, b) => a != b,
        }
    }
}

impl From<Gender> for RefGender {
    fn from(g: Gender) -> Self {
        match g {
            Gender::Male => RefGender::Male,
            Gender::Female => RefGender::Female,
        }
    }
}

// ---- Passives ----------------------------------------------------------------

/// A passive slot on a solver reference. `Desired` slots carry a specific target
/// passive; `Random` slots are palcalc's `RandomPassiveSkill` (any irrelevant
/// passive) — indistinguishable from each other, but counted.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EffPassive {
    Desired(PassiveId),
    Random,
}

impl EffPassive {
    #[inline]
    pub fn desired(&self) -> Option<&PassiveId> {
        match self {
            EffPassive::Desired(id) => Some(id),
            EffPassive::Random => None,
        }
    }
}

/// Canonical, hashable key for a passive set: sorted desired ids + random count.
/// Random passives are distinct for pool math but interchangeable for keying,
/// matching palcalc's `EffectivePassivesHash` semantics.
pub fn passive_key(passives: &[EffPassive]) -> (Vec<PassiveId>, u8) {
    let mut desired: Vec<PassiveId> = passives.iter().filter_map(|p| p.desired().cloned()).collect();
    desired.sort();
    let random = passives.iter().filter(|p| matches!(p, EffPassive::Random)).count() as u8;
    (desired, random)
}

// ---- IVs ---------------------------------------------------------------------

/// One IV ("talent") stat on a reference. Mirrors palcalc `IV_Value` plus a
/// `random` flag (its `IV_Value.Random` sentinel), where a random IV yields to
/// the other parent's value on merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SolverIv {
    /// Target cares about this stat AND this ref meets the threshold.
    pub relevant: bool,
    /// Unknown value (wild pals) — the other parent decides on merge.
    pub random: bool,
    pub min: u8,
    pub max: u8,
}

impl SolverIv {
    pub const RANDOM: SolverIv = SolverIv { relevant: false, random: true, min: 0, max: 0 };

    #[inline]
    pub fn fixed(relevant: bool, value: u8) -> SolverIv {
        SolverIv { relevant, random: false, min: value, max: value }
    }

    /// palcalc `IV_Value.Satisfies`: the guaranteed floor meets the threshold.
    #[inline]
    pub fn satisfies(&self, min_value: u8) -> bool {
        !self.random && self.min >= min_value
    }
}

/// palcalc `IV_Value.Merge` / composite `PropagateIVs`, folded together for
/// child-inheritance: a random on either side is resolved by the other.
pub fn merge_iv(a: SolverIv, b: SolverIv) -> SolverIv {
    if a.random {
        return b;
    }
    if b.random {
        return a;
    }
    if a.relevant == b.relevant {
        SolverIv {
            relevant: a.relevant,
            random: false,
            min: a.min.min(b.min),
            max: a.max.max(b.max),
        }
    } else if a.relevant {
        a
    } else {
        b
    }
}

/// Composite IV propagation (palcalc `CompositeOwnedPalReference.PropagateIVs`):
/// only merge when both concrete, otherwise stay random.
fn propagate_iv(a: SolverIv, b: SolverIv) -> SolverIv {
    if !a.random && !b.random {
        merge_iv(a, b)
    } else {
        SolverIv::RANDOM
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SolverIvSet {
    pub hp: SolverIv,
    pub attack: SolverIv,
    pub defense: SolverIv,
}

impl SolverIvSet {
    pub const RANDOM: SolverIvSet =
        SolverIvSet { hp: SolverIv::RANDOM, attack: SolverIv::RANDOM, defense: SolverIv::RANDOM };

    /// `(relevant_hp, relevant_attack, relevant_defense)` — the grouping key
    /// component palcalc calls `IvRelevance`.
    #[inline]
    pub fn relevance(&self) -> (bool, bool, bool) {
        (self.hp.relevant, self.attack.relevant, self.defense.relevant)
    }

    pub fn merge(a: &SolverIvSet, b: &SolverIvSet) -> SolverIvSet {
        SolverIvSet {
            hp: merge_iv(a.hp, b.hp),
            attack: merge_iv(a.attack, b.attack),
            defense: merge_iv(a.defense, b.defense),
        }
    }

    fn propagate(a: &SolverIvSet, b: &SolverIvSet) -> SolverIvSet {
        SolverIvSet {
            hp: propagate_iv(a.hp, b.hp),
            attack: propagate_iv(a.attack, b.attack),
            defense: propagate_iv(a.defense, b.defense),
        }
    }
}

// ---- References --------------------------------------------------------------

/// A concrete owned pal instance (identity + storage + real passives/IVs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedInstance {
    pub instance_id: Guid,
    pub gender: Gender,
    pub container: ContainerKind,
    /// Real passive ids on the instance (used for the deduplicated parent pool).
    pub real_passives: Vec<PassiveId>,
    pub ivs: SolverIvSet,
}

/// An owned reference. May be a single instance, or a `Wildcard` composite of a
/// male+female pair (palcalc `CompositeOwnedPalReference`) held in `alt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedPalRef {
    pub species: u16,
    pub gender: RefGender,
    /// Desired-passive view (irrelevant real passives become `Random`).
    pub effective_passives: Vec<EffPassive>,
    pub ivs: SolverIvSet,
    pub primary: OwnedInstance,
    /// The opposite-gender member when this is a composite (wildcard) ref.
    pub alt: Option<OwnedInstance>,
}

/// A wild (to-be-caught) reference. Effort = catch time / random-passive prob,
/// scaled by the captures needed to hit a required gender.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WildPalRef {
    pub species: u16,
    pub gender: RefGender,
    pub effective_passives: Vec<EffPassive>,
    pub ivs: SolverIvSet,
    pub self_effort: f64,
    pub captures_required: u32,
}

/// A bred reference: a child of two parents inheriting a target passive set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BredPalRef {
    pub species: u16,
    pub gender: RefGender,
    pub effective_passives: Vec<EffPassive>,
    pub ivs: SolverIvSet,
    pub parent1: PalRef,
    pub parent2: PalRef,
    /// P(inherit all desired passives with the chosen total count).
    pub passives_prob: f64,
    /// P(inherit all required IVs).
    pub ivs_prob: f64,
    /// `ceil(1 / (passives_prob * ivs_prob))`, gender-penalty applied.
    pub avg_required_breedings: u32,
    pub self_effort: f64,
    pub total_effort: f64,
    pub num_breeding_steps: u32,
    pub num_wild_pals: u32,
    pub num_eggs: u32,
    /// Eggs produced per breeding cycle (cake `BreedCount`; 1.0 = no cake). The
    /// per-attempt breeding time divides by this in [`BredPalRef::recompute_effort`].
    pub egg_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PalRef {
    Owned(OwnedPalRef),
    Wild(WildPalRef),
    Bred(Box<BredPalRef>),
}

impl PalRef {
    #[inline]
    pub fn species(&self) -> u16 {
        match self {
            PalRef::Owned(o) => o.species,
            PalRef::Wild(w) => w.species,
            PalRef::Bred(b) => b.species,
        }
    }

    #[inline]
    pub fn gender(&self) -> RefGender {
        match self {
            PalRef::Owned(o) => o.gender,
            PalRef::Wild(w) => w.gender,
            PalRef::Bred(b) => b.gender,
        }
    }

    #[inline]
    pub fn effective_passives(&self) -> &[EffPassive] {
        match self {
            PalRef::Owned(o) => &o.effective_passives,
            PalRef::Wild(w) => &w.effective_passives,
            PalRef::Bred(b) => &b.effective_passives,
        }
    }

    #[inline]
    pub fn ivs(&self) -> &SolverIvSet {
        match self {
            PalRef::Owned(o) => &o.ivs,
            PalRef::Wild(w) => &w.ivs,
            PalRef::Bred(b) => &b.ivs,
        }
    }

    /// Total estimated effort (seconds) to acquire this pal.
    #[inline]
    pub fn total_effort(&self) -> f64 {
        match self {
            PalRef::Owned(_) => 0.0,
            PalRef::Wild(w) => w.self_effort * w.captures_required as f64,
            PalRef::Bred(b) => b.total_effort,
        }
    }

    /// Self effort (this acquisition step alone, excluding parents).
    #[inline]
    pub fn self_effort(&self) -> f64 {
        match self {
            PalRef::Owned(_) => 0.0,
            PalRef::Wild(w) => w.self_effort * w.captures_required as f64,
            PalRef::Bred(b) => b.self_effort,
        }
    }

    #[inline]
    pub fn num_breeding_steps(&self) -> u32 {
        match self {
            PalRef::Owned(_) | PalRef::Wild(_) => 0,
            PalRef::Bred(b) => b.num_breeding_steps,
        }
    }

    #[inline]
    pub fn num_wild_pals(&self) -> u32 {
        match self {
            PalRef::Owned(_) => 0,
            PalRef::Wild(_) => 1,
            PalRef::Bred(b) => b.num_wild_pals,
        }
    }

    #[inline]
    pub fn num_eggs(&self) -> u32 {
        match self {
            PalRef::Owned(_) | PalRef::Wild(_) => 0,
            PalRef::Bred(b) => b.num_eggs,
        }
    }

    #[inline]
    pub fn is_bred(&self) -> bool {
        matches!(self, PalRef::Bred(_))
    }

    /// The deduplicated parent-pool contribution: named passive ids + random
    /// count. Uses ACTUAL passives (palcalc note): owned pals expose their real
    /// passive names so shared irrelevants dedupe, whereas bred/wild pals expose
    /// their desired names plus anonymous randoms.
    pub fn pool_contribution(&self) -> (Vec<PassiveId>, u32) {
        match self {
            PalRef::Owned(o) => (o.primary.real_passives.clone(), 0),
            PalRef::Wild(w) => split_effective(&w.effective_passives),
            PalRef::Bred(b) => split_effective(&b.effective_passives),
        }
    }

    /// Return a copy of this reference resolved to `gender`, adjusting effort for
    /// the gender probability. `None` if the resolution is impossible (an owned
    /// concrete pal cannot change gender without a reverser, which we don't model).
    pub fn with_gender(&self, gd: &GameData, gender: RefGender) -> Option<PalRef> {
        if gender == RefGender::Wildcard || gender == self.gender() {
            return Some(self.clone());
        }
        match self {
            PalRef::Owned(o) => o.with_gender(gender).map(PalRef::Owned),
            PalRef::Wild(w) => Some(PalRef::Wild(w.with_gender(gd, gender))),
            PalRef::Bred(b) => Some(PalRef::Bred(Box::new(b.with_gender(gd, gender)))),
        }
    }
}

fn split_effective(passives: &[EffPassive]) -> (Vec<PassiveId>, u32) {
    let named = passives.iter().filter_map(|p| p.desired().cloned()).collect();
    let random = passives.iter().filter(|p| matches!(p, EffPassive::Random)).count() as u32;
    (named, random)
}

impl OwnedPalRef {
    /// Build the desired-passive view of a real passive list.
    pub fn effective_of(real: &[PassiveId], desired: &std::collections::HashSet<PassiveId>) -> Vec<EffPassive> {
        real.iter()
            .map(|p| {
                if desired.contains(p) {
                    EffPassive::Desired(p.clone())
                } else {
                    EffPassive::Random
                }
            })
            .collect()
    }

    /// Consolidate a male + female instance into a wildcard composite. Effective
    /// passives follow the member with more passives; IVs propagate (palcalc
    /// `CompositeOwnedPalReference`).
    pub fn composite(
        species: u16,
        male: OwnedInstance,
        male_effective: Vec<EffPassive>,
        female: OwnedInstance,
        female_effective: Vec<EffPassive>,
    ) -> OwnedPalRef {
        let effective_passives = if male_effective.len() >= female_effective.len() {
            male_effective
        } else {
            female_effective
        };
        let ivs = SolverIvSet::propagate(&male.ivs, &female.ivs);
        OwnedPalRef { species, gender: RefGender::Wildcard, effective_passives, ivs, primary: male, alt: Some(female) }
    }

    fn with_gender(&self, gender: RefGender) -> Option<OwnedPalRef> {
        // Composite: pick the member matching the requested gender.
        if self.gender == RefGender::Wildcard {
            let want = gender.concrete()?;
            for inst in [Some(&self.primary), self.alt.as_ref()].into_iter().flatten() {
                if inst.gender == want {
                    return Some(OwnedPalRef {
                        species: self.species,
                        gender,
                        effective_passives: self.effective_passives.clone(),
                        ivs: inst.ivs,
                        primary: inst.clone(),
                        alt: None,
                    });
                }
            }
            return None;
        }
        // Concrete owned pal cannot be re-gendered without a reverser.
        None
    }
}

impl WildPalRef {
    /// A wild pal with `num_random` irrelevant passives plus `guaranteed`
    /// desired passives. Effort = catch-time / P(at most `num_random` random).
    pub fn new(
        gd: &GameData,
        species: u16,
        guaranteed_desired: Vec<PassiveId>,
        num_random: u8,
    ) -> WildPalRef {
        let sp = gd.species_at(species).expect("valid species index");
        let self_effort = catch_secs(sp.rarity, sp.is_variant) / wild_passive_prob(num_random);
        let mut effective_passives: Vec<EffPassive> =
            guaranteed_desired.into_iter().map(EffPassive::Desired).collect();
        effective_passives.extend(std::iter::repeat(EffPassive::Random).take(num_random as usize));
        WildPalRef {
            species,
            gender: RefGender::Wildcard,
            effective_passives,
            ivs: SolverIvSet::RANDOM,
            self_effort,
            captures_required: 1,
        }
    }

    fn with_gender(&self, gd: &GameData, gender: RefGender) -> WildPalRef {
        let (male, female) = gd.gender_probability(self.species).unwrap_or((0.5, 0.5));
        let prob = match gender {
            RefGender::Male => male as f64,
            RefGender::Female => female as f64,
            RefGender::Wildcard => 1.0,
        };
        let captures = if prob <= 0.0 { u32::MAX } else { (1.0 / prob).round() as u32 };
        WildPalRef { gender, captures_required: captures.max(1), ..self.clone() }
    }
}

impl BredPalRef {
    /// Construct a bred child. `passives_prob`/`ivs_prob` are supplied by the
    /// caller (the probability model) — never computed here. Effort mirrors
    /// palcalc `BredPalReference` with `MultipleBreedingFarms`/`MultipleIncubators`
    /// defaults.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        gd: &GameData,
        species: u16,
        parent1: PalRef,
        parent2: PalRef,
        effective_passives: Vec<EffPassive>,
        passives_prob: f64,
        ivs: SolverIvSet,
        ivs_prob: f64,
    ) -> BredPalRef {
        let avg = if passives_prob <= 0.0 || ivs_prob <= 0.0 {
            u32::MAX
        } else {
            (1.0 / (passives_prob * ivs_prob)).ceil() as u32
        };
        let mut r = BredPalRef {
            species,
            gender: RefGender::Wildcard,
            effective_passives,
            ivs,
            parent1,
            parent2,
            passives_prob,
            ivs_prob,
            avg_required_breedings: avg,
            self_effort: 0.0,
            total_effort: 0.0,
            num_breeding_steps: 0,
            num_wild_pals: 0,
            num_eggs: 0,
            egg_multiplier: 1.0,
        };
        r.recompute_effort(gd);
        r
    }

    fn parent_effort(&self) -> f64 {
        if MULTIPLE_BREEDING_FARMS && self.parent1.is_bred() && self.parent2.is_bred() {
            self.parent1.total_effort().max(self.parent2.total_effort())
        } else {
            self.parent1.total_effort() + self.parent2.total_effort()
        }
    }

    fn recompute_effort(&mut self, gd: &GameData) {
        let rarity = gd.species_at(self.species).map(|s| s.rarity).unwrap_or(0);
        let incubation = incubation_secs(rarity);
        let (self_effort, total_time) = if self.avg_required_breedings == u32::MAX {
            (f64::INFINITY, f64::INFINITY)
        } else {
            let time_per_breed = AVG_BREEDING_TIME_SECS; // TimeFactor = 1.0 (Philanthropist not modeled)
            // BreedCount>1 (Vegetable cake) yields several eggs per cycle, so the
            // cycles needed to hit `avg_required_breedings` target eggs — and thus
            // the breeding time — divide by the egg multiplier.
            let total_breeding_time =
                self.avg_required_breedings as f64 * time_per_breed / self.egg_multiplier;
            let self_effort = if MULTIPLE_INCUBATORS {
                total_breeding_time + incubation
            } else {
                let total_incubation = self.avg_required_breedings as f64 * incubation;
                (total_incubation + time_per_breed).max(total_breeding_time + incubation)
            };
            (self_effort, self_effort)
        };
        let _ = total_time;
        self.self_effort = self_effort;
        self.total_effort = self_effort + self.parent_effort();
        self.num_breeding_steps = 1 + self.parent1.num_breeding_steps() + self.parent2.num_breeding_steps();
        self.num_wild_pals = self.parent1.num_wild_pals() + self.parent2.num_wild_pals();
        let parent_eggs = self.parent1.num_eggs() + self.parent2.num_eggs();
        self.num_eggs = self.avg_required_breedings.saturating_add(parent_eggs);
    }

    fn with_gender(&self, gd: &GameData, gender: RefGender) -> BredPalRef {
        let (male, female) = gd.gender_probability(self.species).unwrap_or((0.5, 0.5));
        let prob = match gender {
            RefGender::Male => male as f64,
            RefGender::Female => female as f64,
            RefGender::Wildcard => 1.0,
        };
        let avg = if prob <= 0.0 {
            u32::MAX
        } else {
            (self.avg_required_breedings as f64 / prob).ceil() as u32
        };
        let mut r = BredPalRef { gender, avg_required_breedings: avg, ..self.clone() };
        r.recompute_effort(gd);
        r
    }

    /// Return a copy with a cake egg-multiplier applied (Vegetable/DeluxeVegetable
    /// `BreedCount=2`), recomputing effort. `1.0` is the no-cake default.
    pub fn with_egg_multiplier(&self, gd: &GameData, egg_multiplier: f64) -> BredPalRef {
        let mut r = BredPalRef { egg_multiplier, ..self.clone() };
        r.recompute_effort(gd);
        r
    }

    /// Estimated breeding *attempts* (cycles) for this step: eggs-to-success
    /// divided by eggs-per-cycle, rounded up. Each attempt consumes one cake.
    /// Capped so an infeasible ref (`avg == u32::MAX`) does not overflow display.
    pub fn attempts_estimate(&self) -> u32 {
        if self.avg_required_breedings == u32::MAX {
            return 0;
        }
        let cycles = (self.avg_required_breedings as f64 / self.egg_multiplier).ceil();
        cycles.min(1_000_000.0) as u32
    }
}
