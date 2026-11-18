use std::{
    io,
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::{Child, Command},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Globalization::GetUserDefaultUILanguage,
    System::{JobObjects::*, Registry::*},
};

pub fn system_language() -> &'static str {
    // The low 10 bits of a LANGID identify the primary language. Spanish is 0x0a.
    if (unsafe { GetUserDefaultUILanguage() } & 0x03ff) == 0x0a { "es" } else { "en" }
}

pub struct ProcessGroup(HANDLE);
unsafe impl Send for ProcessGroup {}
unsafe impl Sync for ProcessGroup {}

impl ProcessGroup {
    pub fn attach(child: &Child) -> io::Result<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(job))
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn hide_process(command: &mut Command) {
    command.creation_flags(0x08000000);
}
#[cfg(not(debug_assertions))]
pub fn node_filename() -> &'static str {
    "videogen-node.exe"
}
pub fn browser_relative_path() -> &'static str {
    "chrome-headless-shell-win64/chrome-headless-shell.exe"
}
pub fn whisper_filename() -> &'static str {
    "whisper-cli.exe"
}

pub fn credential(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.videogen.desktop", key)
        .map_err(|_| "No se puede acceder al Administrador de credenciales.".into())
}
pub fn read_secret(key: &str) -> Result<Option<String>, String> {
    match credential(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("No se puede leer el Administrador de credenciales.".into()),
    }
}
pub fn write_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = credential(key)?;
    if value.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("No se pudo borrar la credencial.".into()),
        }
    } else {
        entry
            .set_password(value)
            .map_err(|_| "No se pudo guardar la credencial.".into())
    }
}

fn registry_dword(subkey: &str, name: &str) -> Option<u32> {
    let key: Vec<u16> = subkey.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut value = 0u32;
    let mut size = 4;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut value as *mut _ as _,
            &mut size,
        )
    };
    (result == 0).then_some(value)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub transparent: bool,
    pub accent: String,
}

pub fn appearance(window: &tauri::WebviewWindow) -> Appearance {
    let mut contrast = HighContrast {
        size: std::mem::size_of::<HighContrast>() as u32,
        flags: 0,
        scheme: std::ptr::null_mut(),
    };
    unsafe {
        SystemParametersInfoW(0x0042, contrast.size, &mut contrast as *mut _ as _, 0);
    }
    let enabled = contrast.flags & 1 == 0
        && registry_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "EnableTransparency",
        )
        .unwrap_or(1)
            != 0;
    let transparent = enabled && window_vibrancy::apply_mica(window, None).is_ok();
    if !transparent {
        let _ = window_vibrancy::clear_mica(window);
    }
    let color =
        registry_dword(r"Software\Microsoft\Windows\DWM", "AccentColor").unwrap_or(0xffd77800);
    Appearance {
        transparent,
        accent: format!(
            "#{:02x}{:02x}{:02x}",
            color & 255,
            (color >> 8) & 255,
            (color >> 16) & 255
        ),
    }
}

// Keep Win32 hit-testing here: HTML buttons alone do not participate in Snap Layouts.
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::Emitter;
type Hwnd = *mut std::ffi::c_void;
type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct HighContrast {
    size: u32,
    flags: u32,
    scheme: *mut u16,
}
#[link(name = "comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(hwnd: Hwnd, callback: Option<SubclassProc>, id: usize, data: usize)
        -> i32;
    fn RemoveWindowSubclass(hwnd: Hwnd, callback: Option<SubclassProc>, id: usize) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
}
#[link(name = "user32")]
unsafe extern "system" {
    fn ScreenToClient(hwnd: Hwnd, point: *mut Point) -> i32;
    fn IsZoomed(hwnd: Hwnd) -> i32;
    fn SendMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn SystemParametersInfoW(
        action: u32,
        parameter: u32,
        value: *mut std::ffi::c_void,
        flags: u32,
    ) -> i32;
}
type Chrome = ([f64; 4], tauri::WebviewWindow);
static CHROME: OnceLock<Mutex<HashMap<isize, Chrome>>> = OnceLock::new();
fn chrome() -> &'static Mutex<HashMap<isize, Chrome>> {
    CHROME.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn install_window_chrome(window: &tauri::WebviewWindow) -> Result<(), String> {
    let native = window.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = sender.send(install_chrome_on_main_thread(&native));
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())?
}
fn install_chrome_on_main_thread(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
    chrome()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(hwnd as isize, ([0.0; 4], window.clone()));
    if unsafe { SetWindowSubclass(hwnd, Some(chrome_proc), 1, 0) } == 0 {
        return Err("No se pudo instalar la barra nativa de Windows.".into());
    }
    Ok(())
}
pub fn set_maximize_bounds(window: &tauri::WebviewWindow, x: f64, y: f64, width: f64, height: f64) {
    if ![x, y, width, height]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0 && *v < 100000.0)
    {
        return;
    }
    if let Ok(hwnd) = window.hwnd() {
        if let Ok(mut entries) = chrome().lock() {
            if let Some(entry) = entries.get_mut(&(hwnd.0 as isize)) {
                entry.0 = [x, y, width, height];
            }
        }
    }
}
unsafe extern "system" fn chrome_proc(
    hwnd: Hwnd,
    msg: u32,
    wparam: usize,
    lparam: isize,
    _: usize,
    _: usize,
) -> isize {
    match msg {
        0x0084 => {
            // WM_NCHITTEST
            if let Some((bounds, window)) = chrome()
                .lock()
                .ok()
                .and_then(|m| m.get(&(hwnd as isize)).cloned())
            {
                let mut point = Point {
                    x: (lparam as u16 as i16) as i32,
                    y: ((lparam >> 16) as u16 as i16) as i32,
                };
                ScreenToClient(hwnd, &mut point);
                let scale = window.scale_factor().unwrap_or(1.0);
                let x = f64::from(point.x) / scale;
                let y = f64::from(point.y) / scale;
                if x >= bounds[0]
                    && x < bounds[0] + bounds[2]
                    && y >= bounds[1]
                    && y < bounds[1] + bounds[3]
                {
                    return 9;
                } // HTMAXBUTTON
            }
        }
        0x00a1 if wparam == 9 => return 0, // WM_NCLBUTTONDOWN
        0x00a2 if wparam == 9 => {
            // WM_NCLBUTTONUP
            SendMessageW(
                hwnd,
                0x0112,
                if IsZoomed(hwnd) != 0 { 0xf120 } else { 0xf030 },
                0,
            );
            return 0;
        }
        0x001a | 0x031a => {
            // System appearance/transparency changed
            if let Some((_, window)) = chrome()
                .lock()
                .ok()
                .and_then(|m| m.get(&(hwnd as isize)).cloned())
            {
                let _ = window.emit("desktop-appearance", appearance(&window));
            }
        }
        0x0082 => {
            // WM_NCDESTROY
            if let Ok(mut entries) = chrome().lock() {
                entries.remove(&(hwnd as isize));
            }
            RemoveWindowSubclass(hwnd, Some(chrome_proc), 1);
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
