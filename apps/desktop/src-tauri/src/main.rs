#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Sample native command: proves the UI can reach `cgv-native` through Tauri IPC.
#[tauri::command]
fn native_info() -> cgv_native::NativeInfo {
    cgv_native::info()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_info])
        .run(tauri::generate_context!())
        .expect("failed to run CashGear Video");
}
