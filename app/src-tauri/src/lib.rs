mod paldex;
mod save;
mod solver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(save::WatcherState::default())
        .manage(solver::SolveGate::default())
        .invoke_handler(tauri::generate_handler![
            save::load_save,
            save::watch_save,
            save::unwatch_save,
            solver::solve,
            solver::solve_queue,
            solver::cancel_solve,
            solver::list_species,
            solver::list_passives,
            solver::list_active_skills,
            solver::get_world_options,
            solver::list_breeding_boosts,
            solver::list_lab_research,
            paldex::paldex_species,
            paldex::paldex_species_detail,
            paldex::breeding_child,
            paldex::breeding_parents,
            paldex::roster_counts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
