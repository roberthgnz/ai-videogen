#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
compile_error!("This release packages Windows only. Add a platform implementation before targeting another OS.");
