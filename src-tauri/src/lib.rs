#[cfg(target_os = "macos")]
mod macos_menu;

// 百工·纸：注册官方插件，macOS 使用系统菜单栏。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            macos_menu::install(_app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running zhi");
}
