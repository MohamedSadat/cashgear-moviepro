#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod export;
mod fonts;
mod media;
mod project;

use tauri::Manager;

/// Sample native command: proves the UI can reach `cgv-native` through Tauri IPC.
#[tauri::command]
fn native_info() -> cgv_native::NativeInfo {
    cgv_native::info()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let media = media::MediaState::new(app.handle());
            export::clear_leftovers(&media);
            app.manage(media);
            app.manage(project::ProjectState::new(app.handle()));
            app.manage(export::ExportState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                export::confirm_close(window, api);
            }
        })
        .register_asynchronous_uri_scheme_protocol("cgv-media", |context, request, responder| {
            let app = context.app_handle().clone();
            // File reads must not block the webview's protocol thread.
            std::thread::spawn(move || {
                let state = app.state::<media::MediaState>();
                responder.respond(media::serve(&state, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            native_info,
            export::export_open,
            export::export_write,
            export::export_finish,
            export::export_cancel,
            fonts::fonts_installed,
            media::media_pick,
            media::media_register,
            media::media_forget,
            media::media_make_proxy,
            media::media_drop_proxy,
            media::cache_read,
            media::cache_write,
            media::cache_remove,
            media::recording_save,
            project::project_save,
            project::project_open,
            project::project_read,
            project::autosave_read,
            project::autosave_write,
            project::autosave_remove,
            project::media_locate,
            project::media_search,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CashGear Video");
}
