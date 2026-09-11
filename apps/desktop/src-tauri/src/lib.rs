/// Точка входа десктопной оболочки.
///
/// Почти весь редактор — тот же самый веб-код, который собирается `vite build`.
/// Единственное исключение — узкий порт нативной печати: он принимает уже
/// собранный лист и не знает ни о документах, ни о слоях, ни об инструментах.
/// Так в десктопе можно выбрать принтер и отправить задание без второго диалога,
/// не создавая второй реализации редактора.
///
/// Настоящая разница между вебом и десктопом живёт в портах платформы ядра
/// (файлы, шрифты, буфер обмена). Когда десктопные их варианты понадобятся,
/// они появятся там, а не здесь.
mod native_print;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Supplies the desktop implementation of the home browser's read-only
        // file port; document state remains entirely in the shared web kernel.
        .plugin(tauri_plugin_fs::init())
        // `webPlatform.ts`'s `DesktopFileSystem.saveFile` and the image converter's folder
        // pickers both call into `@tauri-apps/plugin-dialog` (`save`/`open`) — the crate was
        // already a Cargo dependency but never registered here, so those calls would fail at
        // runtime with the plugin uninitialized. `tauri-plugin-fs` alone only covers file I/O
        // once a path is already known, not the native picker that supplies one.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            native_print::list_printers,
            native_print::print_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
