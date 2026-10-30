//! The machine id licences are activated for (`cgv_native::machine`). A system
//! without one gets a random id, kept in the app's data folder.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn licence_machine(app: AppHandle) -> Result<String, String> {
    if let Some(id) = cgv_native::machine::machine_id() {
        return Ok(id);
    }
    let folder = std::env::var_os("CGV_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .ok_or("The app has no data folder.")?;
    let path = folder.join("machine-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        if !id.trim().is_empty() {
            return Ok(id.trim().to_owned());
        }
    }
    let id = cgv_native::machine::hashed(&uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    std::fs::write(&path, &id).map_err(|error| error.to_string())?;
    Ok(id)
}
