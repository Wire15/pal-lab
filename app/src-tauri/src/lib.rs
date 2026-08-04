mod mapstate;
mod paldex;
mod save;
mod sftp;
mod sftp_vault;
mod solver;
mod updater;
mod xbox;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(save::WatcherState::default())
        .manage(solver::SolveGate::default())
        .manage(sftp::manager())
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
            paldex::reverse_breeding,
            paldex::roster_counts,
            paldex::dex_reachability,
            updater::check_update,
            updater::data_pack_info,
            mapstate::get_map_state,
            xbox::detect_xbox_stores,
            xbox::list_xbox_worlds,
            xbox::load_xbox_save,
            sftp::sftp_connect,
            sftp::sftp_load_save,
            sftp::sftp_watch,
            sftp::sftp_unwatch,
            sftp::sftp_disconnect,
            sftp_vault::sftp_secret_store,
            sftp_vault::sftp_secret_load,
            sftp_vault::sftp_secret_forget
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // On exit, send a graceful SSH goodbye so a host that caps concurrent
            // SFTP sessions reaps ours immediately — otherwise a quick relaunch
            // collides with the lingering session ("opening ssh channel:
            // disconnected"). Bounded so exit never hangs.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                sftp::disconnect_on_exit();
            }
        });
}
