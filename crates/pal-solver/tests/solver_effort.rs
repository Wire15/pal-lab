//! Effort combination math, wildcard gender resolution, and the min-steps
//! initial-content budget filter. None of these call the probability model — a
//! bred ref takes its probabilities as constructor inputs — so they run without
//! the sibling-owned `probabilities` bodies.

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::SolverConfig;
use pal_solver::solver::engine::build_initial_content;
use pal_solver::solver::refs::{
    incubation_secs, BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, RefGender,
    SolverIv, SolverIvSet, WildPalRef, AVG_BREEDING_TIME_SECS,
};
use pal_solver::solver::spec::{TargetPal, TargetSpec};

fn owned_instance(gender: Gender) -> OwnedInstance {
    OwnedInstance {
        instance_id: [0u8; 16],
        gender,
        container: ContainerKind::Palbox,
        real_passives: vec![],
        ivs: SolverIvSet::RANDOM,
    }
}

fn owned_ref(species: u16, gender: Gender) -> PalRef {
    PalRef::Owned(OwnedPalRef {
        species,
        gender: gender.into(),
        effective_passives: vec![],
        ivs: SolverIvSet::RANDOM,
        primary: owned_instance(gender),
        alt: None,
    })
}

fn make_owned(gd: &GameData, species: u16, gender: Gender) -> OwnedPal {
    let name = gd.species_at(species).unwrap().internal_name.clone();
    OwnedPal {
        instance_id: [0u8; 16],
        character_id: name,
        is_boss: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives: vec![],
        active_skills: vec![],
        is_human: false,
        ivs: IvSet::default(),
        nickname: None,
        owner_player_uid: None,
        container_id: None,
        slot_index: None,
        container_kind: ContainerKind::Palbox,
    }
}

#[test]
fn bred_self_effort_matches_model() {
    let gd = GameData::get();
    let child = 0u16;
    // p=0.5, ivp=1.0 -> avg_required = ceil(1/0.5) = 2.
    let bred = BredPalRef::new(
        gd,
        child,
        owned_ref(1, Gender::Male),
        owned_ref(2, Gender::Female),
        vec![],
        0.5,
        SolverIvSet::RANDOM,
        1.0,
    );
    assert_eq!(bred.avg_required_breedings, 2);
    let expected_incubation = incubation_secs(gd.species_at(child).unwrap().rarity);
    let expected_self = 2.0 * AVG_BREEDING_TIME_SECS + expected_incubation;
    assert!((bred.self_effort - expected_self).abs() < 1e-6);
    // parents are owned (zero effort) -> total == self.
    assert!((bred.total_effort - expected_self).abs() < 1e-6);
    assert_eq!(bred.num_breeding_steps, 1);
}

#[test]
fn bred_effort_is_self_plus_parents() {
    let gd = GameData::get();
    // Two BRED parents: with MultipleBreedingFarms the parent effort is the MAX,
    // not the sum.
    let mk = |prob: f64| {
        PalRef::Bred(Box::new(BredPalRef::new(
            gd,
            0,
            owned_ref(1, Gender::Male),
            owned_ref(2, Gender::Female),
            vec![],
            prob,
            SolverIvSet::RANDOM,
            1.0,
        )))
    };
    let pa = mk(0.5); // avg 2
    let pb = mk(1.0 / 3.0); // avg 3 -> larger effort
    assert!(pb.total_effort() > pa.total_effort());

    let child = BredPalRef::new(
        gd,
        0,
        pa.clone(),
        pb.clone(),
        vec![],
        0.5,
        SolverIvSet::RANDOM,
        1.0,
    );
    let expected_parent = pa.total_effort().max(pb.total_effort());
    assert!((child.total_effort - (child.self_effort + expected_parent)).abs() < 1e-6);
    // 1 (this) + 1 (pa) + 1 (pb) = 3 breeding steps.
    assert_eq!(child.num_breeding_steps, 3);
}

#[test]
fn wildcard_gender_resolution_picks_cheaper() {
    let gd = GameData::get();
    // Find a species biased enough that the two genders round to a DIFFERENT
    // number of captures (rounding otherwise collapses mild biases).
    let round_captures = |p: f32| (1.0f64 / p as f64).round() as u32;
    let species = (0..gd.species_count() as u16).find(|&i| {
        gd.gender_probability(i)
            .map(|(m, f)| m > 0.0 && f > 0.0 && round_captures(m) != round_captures(f))
            .unwrap_or(false)
    });
    let Some(species) = species else {
        return; // no species with a resolvable capture difference; nothing to assert
    };
    let (male_p, female_p) = gd.gender_probability(species).unwrap();

    let wild = PalRef::Wild(WildPalRef::new(gd, species, vec![], 0));
    let as_male = wild.with_gender(gd, RefGender::Male).unwrap();
    let as_female = wild.with_gender(gd, RefGender::Female).unwrap();

    // The more-likely gender needs fewer captures -> less effort.
    if male_p > female_p {
        assert!(as_male.total_effort() < as_female.total_effort());
    } else {
        assert!(as_female.total_effort() < as_male.total_effort());
    }
}

#[test]
fn composite_gender_resolution_is_free_and_selects_member() {
    // A male+female composite resolves to a concrete owned member at zero effort.
    let male = owned_instance(Gender::Male);
    let mut female = owned_instance(Gender::Female);
    female.instance_id = [7u8; 16];
    let composite = PalRef::Owned(OwnedPalRef::composite(5, male, vec![], female, vec![]));
    assert_eq!(composite.gender(), RefGender::Wildcard);

    let gd = GameData::get();
    let resolved_f = composite.with_gender(gd, RefGender::Female).unwrap();
    assert_eq!(resolved_f.gender(), RefGender::Female);
    assert_eq!(resolved_f.total_effort(), 0.0);
    match resolved_f {
        PalRef::Owned(o) => assert_eq!(o.primary.instance_id, [7u8; 16]),
        _ => panic!("expected owned"),
    }
}

#[test]
fn owned_concrete_gender_cannot_be_reversed() {
    let gd = GameData::get();
    let male = owned_ref(3, Gender::Male);
    assert!(male.with_gender(gd, RefGender::Female).is_none());
    // Same gender is a no-op clone.
    assert!(male.with_gender(gd, RefGender::Male).is_some());
}

#[test]
fn min_steps_budget_gates_initial_content() {
    let gd = GameData::get();
    // Find a (source, target) pair with a finite min-steps distance >= 2.
    let mut fixture = None;
    'outer: for t in 0..gd.species_count() as u16 {
        for s in 0..gd.species_count() as u16 {
            if s == t {
                continue;
            }
            let d = gd.min_steps(s, t);
            if (2..pal_data::gamedata::UNREACHABLE).contains(&d) {
                fixture = Some((s, t, d as u32));
                break 'outer;
            }
        }
    }
    let (source, target, dist) = fixture.expect("pack has a reachable pair at distance >= 2");

    let owned = vec![make_owned(gd, source, Gender::Male)];
    let spec = TargetSpec::new(TargetPal::Species(target));

    let cfg_ok = SolverConfig {
        include_wild: false,
        max_breeding_steps: dist,
        ..Default::default()
    };
    let content_ok = build_initial_content(gd, &spec, &owned, &cfg_ok);
    assert!(
        content_ok.iter().any(|r| r.species() == source),
        "source within budget should be kept"
    );

    let cfg_no = SolverConfig {
        include_wild: false,
        max_breeding_steps: dist - 1,
        ..Default::default()
    };
    let content_no = build_initial_content(gd, &spec, &owned, &cfg_no);
    assert!(
        !content_no.iter().any(|r| r.species() == source),
        "source beyond budget should be filtered out"
    );
}

#[test]
fn iv_satisfies_threshold() {
    let iv = SolverIv::fixed(true, 80);
    assert!(iv.satisfies(70));
    assert!(iv.satisfies(80));
    assert!(!iv.satisfies(90));
    assert!(!SolverIv::RANDOM.satisfies(1));
    // Random IV yields to the other parent on merge.
    let merged = pal_solver::solver::refs::merge_iv(SolverIv::RANDOM, SolverIv::fixed(true, 50));
    assert_eq!(merged.min, 50);
    let _ = EffPassive::Random;
}
