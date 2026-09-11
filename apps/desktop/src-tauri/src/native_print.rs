//! Windows-native printer bridge for the desktop Print Center.
//!
//! The browser does not expose installed printers. On Windows we use the
//! WebView2 Print API behind Tauri's existing WebView runtime: a temporary
//! off-screen page contains only the already-rendered print sheet, and WebView2
//! sends that page to the printer selected in VRAVIO. This is intentionally not
//! a second visible print dialog.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    name: String,
    driver_name: String,
    status: String,
    is_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintRequest {
    printer_name: String,
    title: String,
    page_data_url: String,
    page_width_in: f64,
    page_height_in: f64,
    orientation: String,
    copies: u32,
    grayscale: bool,
}

#[cfg(windows)]
mod windows {
    use super::{PrintRequest, PrinterInfo};
    use std::{fs, sync::mpsc, time::{Duration, SystemTime, UNIX_EPOCH}};
    use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};
    use webview2_com::{NavigationCompletedEventHandler, PrintCompletedHandler};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, ICoreWebView2Environment6, ICoreWebView2PrintSettings2,
        COREWEBVIEW2_PRINT_COLOR_MODE_COLOR, COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE,
        COREWEBVIEW2_PRINT_MEDIA_SIZE_CUSTOM, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
    };
    use windows::core::{HSTRING, Interface, PCWSTR};
    use windows::Win32::Graphics::Printing::{EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL};

    #[repr(C)]
    struct PrinterInfo2 {
        server: *mut u16, name: *mut u16, share: *mut u16, port: *mut u16,
        driver: *mut u16, comment: *mut u16, location: *mut u16, devmode: *mut u8,
        separator: *mut u16, processor: *mut u16, datatype: *mut u16, parameters: *mut u16,
        security: *mut u8, attributes: u32, priority: u32, default_priority: u32,
        start_time: u32, until_time: u32, status: u32, jobs: u32, ppm: u32,
    }

    unsafe fn string_at(pointer: *const u16) -> String {
        if pointer.is_null() { return String::new(); }
        let length = (0..).take_while(|index| *pointer.add(*index) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
    }
    fn status_label(status: u32) -> String {
        if status & 0x0000_0080 != 0 { "offline".into() }
        else if status & 0x0000_0002 != 0 { "error".into() }
        else if status & 0x0000_0200 != 0 { "busy".into() }
        else { "ready".into() }
    }
    fn default_printer() -> String {
        unsafe {
            let mut characters = 0u32;
            let _ = GetDefaultPrinterW(None, &mut characters);
            if characters == 0 { return String::new(); }
            let mut buffer = vec![0u16; characters as usize];
            if GetDefaultPrinterW(Some(windows::core::PWSTR(buffer.as_mut_ptr())), &mut characters).as_bool() {
                String::from_utf16_lossy(&buffer[..characters.saturating_sub(1) as usize])
            } else { String::new() }
        }
    }

    pub fn printers() -> Result<Vec<PrinterInfo>, String> {
        unsafe {
            let mut needed = 0u32; let mut returned = 0u32;
            let _ = EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, PCWSTR::null(), 2, None, &mut needed, &mut returned);
            if needed == 0 { return Ok(Vec::new()); }
            let mut bytes = vec![0u8; needed as usize];
            EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, PCWSTR::null(), 2, Some(&mut bytes), &mut needed, &mut returned)
                .map_err(|error| format!("Could not enumerate Windows printers: {error}"))?;
            let default = default_printer();
            let entries = bytes.as_ptr() as *const PrinterInfo2;
            let mut result = Vec::with_capacity(returned as usize);
            for index in 0..returned as usize {
                let entry = &*entries.add(index);
                let name = string_at(entry.name);
                result.push(PrinterInfo { is_default: name == default, name, driver_name: string_at(entry.driver), status: status_label(entry.status) });
            }
            result.sort_by_key(|printer| (!printer.is_default, printer.name.to_lowercase()));
            Ok(result)
        }
    }

    fn temporary_page(request: &PrintRequest) -> Result<(std::path::PathBuf, tauri::Url), String> {
        if !request.page_data_url.starts_with("data:image/png;base64,") { return Err("The print page must be a PNG data URL.".into()); }
        let id = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
        let path = std::env::temp_dir().join(format!("vravio-print-{}_{}.html", std::process::id(), id));
        let title = request.title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let html = format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>@page{{size:{}in {}in;margin:0}}html,body{{margin:0;padding:0;background:#fff}}img{{display:block;width:{}in;height:{}in}}</style></head><body><img src=\"{}\"></body></html>", request.page_width_in, request.page_height_in, request.page_width_in, request.page_height_in, request.page_data_url);
        fs::write(&path, html).map_err(|error| format!("Could not prepare print page: {error}"))?;
        let url = tauri::Url::from_file_path(&path).map_err(|_| "Could not create a file URL for the print page.".to_string())?;
        Ok((path, url))
    }

    fn render_and_print<R: Runtime>(app: &AppHandle<R>, request: PrintRequest) -> Result<(), String> {
        if request.printer_name.trim().is_empty() { return Err("Choose a printer before printing.".into()); }
        let (page_path, page_url) = temporary_page(&request)?;
        let label = format!("__vravio_print_{}_{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos());
        // Register NavigationCompleted before loading the temporary page.  Creating a
        // window directly at `page_url` can finish navigation before WebView2 has our
        // handler, which leaves the print job waiting until its timeout.
        let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("about:blank".into())).visible(false).skip_taskbar(true).decorations(false).inner_size(1.0, 1.0).build().map_err(|error| format!("Could not prepare native print renderer: {error}"))?;
        let (navigation_tx, navigation_rx) = mpsc::channel::<Result<(), String>>();
        window.with_webview(move |webview| unsafe {
            let core = match webview.controller().CoreWebView2() { Ok(core) => core, Err(error) => { let _ = navigation_tx.send(Err(error.to_string())); return; } };
            let completion_tx = navigation_tx.clone();
            let handler = NavigationCompletedEventHandler::create(Box::new(move |_, _| { let _ = completion_tx.send(Ok(())); Ok(()) }));
            let mut token = 0i64;
            if let Err(error) = core.add_NavigationCompleted(&handler, &mut token) { let _ = navigation_tx.send(Err(error.to_string())); }
        }).map_err(|error| error.to_string())?;
        window.navigate(page_url).map_err(|error| format!("Could not load native print page: {error}"))?;
        let ready = navigation_rx.recv_timeout(Duration::from_secs(12)).map_err(|_| "Timed out while preparing native print page.".to_string())?;
        ready?;
        let (print_tx, print_rx) = mpsc::channel::<Result<(), String>>();
        let printer = request.printer_name.clone(); let orientation = request.orientation.clone(); let copies = request.copies.clamp(1, 999); let grayscale = request.grayscale;
        let page_width = request.page_width_in; let page_height = request.page_height_in;
        window.with_webview(move |webview| unsafe {
            let env6: ICoreWebView2Environment6 = match webview.environment().cast() { Ok(value) => value, Err(error) => { let _ = print_tx.send(Err(format!("WebView2 Environment6 is unavailable: {error}"))); return; } };
            let core16: ICoreWebView2_16 = match webview.controller().CoreWebView2().and_then(|core| core.cast()) { Ok(value) => value, Err(error) => { let _ = print_tx.send(Err(format!("WebView2 print API is unavailable: {error}"))); return; } };
            let settings = match env6.CreatePrintSettings() { Ok(value) => value, Err(error) => { let _ = print_tx.send(Err(error.to_string())); return; } };
            let settings2: ICoreWebView2PrintSettings2 = match settings.cast() { Ok(value) => value, Err(error) => { let _ = print_tx.send(Err(error.to_string())); return; } };
            let configured = settings2.SetPrinterName(&HSTRING::from(printer))
                .and_then(|_| settings2.SetMediaSize(COREWEBVIEW2_PRINT_MEDIA_SIZE_CUSTOM))
                .and_then(|_| settings.SetPageWidth(page_width))
                .and_then(|_| settings.SetPageHeight(page_height))
                .and_then(|_| settings.SetOrientation(if orientation == "landscape" { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT }))
                .and_then(|_| settings2.SetCopies(copies as i32))
                .and_then(|_| settings2.SetColorMode(if grayscale { COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE } else { COREWEBVIEW2_PRINT_COLOR_MODE_COLOR }))
                .and_then(|_| settings.SetShouldPrintBackgrounds(true));
            if let Err(error) = configured { let _ = print_tx.send(Err(format!("Could not configure native print job: {error}"))); return; }
            let completion_tx = print_tx.clone();
            let handler = PrintCompletedHandler::create(Box::new(move |result, status| { let outcome = match result { Ok(()) if status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED => Ok(()), Ok(()) => Err(format!("Printer did not accept the job (status {}).", status.0)), Err(error) => Err(format!("Native print failed: {error}")) }; let _ = completion_tx.send(outcome); Ok(()) }));
            if let Err(error) = core16.Print(&settings, &handler) { let _ = print_tx.send(Err(format!("Could not send job to printer: {error}"))); }
        }).map_err(|error| error.to_string())?;
        let outcome = print_rx.recv_timeout(Duration::from_secs(45)).map_err(|_| "Timed out while sending the print job.".to_string())?;
        let _ = window.close(); let _ = fs::remove_file(page_path);
        outcome
    }

    pub fn list_printers() -> Result<Vec<PrinterInfo>, String> { printers() }

    pub async fn print_page(app: AppHandle, request: PrintRequest) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || render_and_print(&app, request)).await.map_err(|error| error.to_string())??;
        Ok("queued".into())
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> { windows::list_printers() }

#[cfg(not(windows))]
#[tauri::command]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    Err("Native printer selection is currently available on Windows desktop.".into())
}

#[cfg(windows)]
#[tauri::command]
pub async fn print_page(app: tauri::AppHandle, request: PrintRequest) -> Result<String, String> { windows::print_page(app, request).await }

#[cfg(not(windows))]
#[tauri::command]
pub async fn print_page(_app: tauri::AppHandle, _request: PrintRequest) -> Result<String, String> {
    Err("Native direct printing is currently available on Windows desktop.".into())
}
