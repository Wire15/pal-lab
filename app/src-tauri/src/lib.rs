mod paldex;
mod save;
mod solver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save::load_save,
            solver::solve,
            solver::list_species,
            solver::list_passives,
            solver::list_active_names,
            paldex::paldex_species,
            paldex::paldex_species_detail,
            paldex::breeding_child,
            paldex::breeding_parents,
            paldex::roster_counts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
