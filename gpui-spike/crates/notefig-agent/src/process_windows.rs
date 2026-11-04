//! Windows side of the process host (port of `agent_proc.rs`'s `win_env`,
//! `resolve_windows_program` and `job_object`).
//!
//! - PATH: a GUI app's inherited PATH is a stale snapshot from Explorer
//!   startup, so the live system + user PATH is read from the registry on
//!   every spawn (`REG_EXPAND_SZ` values expanded).
//! - Program resolution: a bare name (`npx`, `opencode`) usually exists only
//!   as a `.cmd` shim; it is resolved against that PATH × PATHEXT to a
//!   concrete path. A path ending in `.cmd`/`.bat` is what makes std route
//!   the spawn through its strict cmd.exe argument quoting (the
//!   CVE-2024-24576 fix, Rust ≥ 1.77.2), which refuses arguments it can't
//!   quote safely instead of letting cmd.exe re-parse them.
//! - Kill tree: each child is assigned to a Job Object with
//!   `KILL_ON_JOB_CLOSE`; terminating (or closing) the job kills the whole
//!   tree (node → claude.exe, npx.cmd → node, …).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ, RegCloseKey,
    RegOpenKeyExW, RegQueryValueExW,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// CREATE_NO_WINDOW: no console flashes for console children (node, the
/// cmd.exe std interposes for `.cmd` shims).
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide_nul_terminated(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..len]).to_string_lossy().into_owned()
}

fn expand(input: &str) -> String {
    unsafe {
        let input_w = utf16(input);
        let needed = ExpandEnvironmentStringsW(input_w.as_ptr(), std::ptr::null_mut(), 0);
        if needed == 0 {
            return input.to_string();
        }
        let mut buf = vec![0u16; needed as usize];
        let written = ExpandEnvironmentStringsW(input_w.as_ptr(), buf.as_mut_ptr(), needed);
        if written == 0 {
            return input.to_string();
        }
        from_wide_nul_terminated(&buf)
    }
}

fn read_string_value(root: HKEY, subkey: &str, value_name: &str) -> Option<String> {
    unsafe {
        let subkey_w = utf16(subkey);
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(root, subkey_w.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }
        let value_w = utf16(value_name);
        let mut value_type = 0u32;
        let mut byte_len = 0u32;
        let sized = RegQueryValueExW(
            hkey,
            value_w.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut byte_len,
        );
        if sized != 0 || (value_type != REG_SZ && value_type != REG_EXPAND_SZ) || byte_len == 0 {
            RegCloseKey(hkey);
            return None;
        }
        let mut buf: Vec<u16> = vec![0u16; byte_len as usize / 2 + 1];
        let read = RegQueryValueExW(
            hkey,
            value_w.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut byte_len,
        );
        RegCloseKey(hkey);
        if read != 0 {
            return None;
        }
        let raw = from_wide_nul_terminated(&buf);
        Some(if value_type == REG_EXPAND_SZ { expand(&raw) } else { raw })
    }
}

/// The live system + user PATH from the registry (system first, as the
/// shell composes it). None when neither can be read.
pub fn fresh_path() -> Option<String> {
    let system = read_string_value(
        HKEY_LOCAL_MACHINE,
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "Path",
    );
    let user = read_string_value(HKEY_CURRENT_USER, "Environment", "Path");
    match (system, user) {
        (Some(sys), Some(usr)) if !usr.is_empty() => Some(format!("{sys};{usr}")),
        (Some(sys), _) => Some(sys),
        (None, Some(usr)) => Some(usr),
        (None, None) => None,
    }
}

/// A bare program name resolved against PATH × PATHEXT (`npx` →
/// `C:\…\npx.cmd`); names with a separator or an extension are returned
/// unchanged. PATH: the fresh registry one, else the spawn env's, else ours.
pub fn resolve_program(program: &str, env: &BTreeMap<String, String>, fresh_path: Option<&str>) -> String {
    if program.contains(['\\', '/']) || std::path::Path::new(program).extension().is_some() {
        return program.to_string();
    }
    let path_var = fresh_path
        .map(str::to_string)
        .or_else(|| env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()))
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for dir in std::env::split_paths(&path_var) {
        for ext in pathext.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    program.to_string()
}

/// A Job Object holding one agent's process tree.
pub struct JobObject(HANDLE);

// The handle is only used through thread-safe Win32 calls.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// Create a kill-on-close job and put the process `pid` in it. None if
    /// any step fails (the caller falls back to `taskkill /T`).
    pub fn for_pid(pid: u32) -> Option<JobObject> {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return None;
            }
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                CloseHandle(process);
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
                && AssignProcessToJobObject(job, process) != 0;
            CloseHandle(process);
            if !ok {
                CloseHandle(job);
                return None;
            }
            Some(JobObject(job))
        }
    }

    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Fallback kill tree when no job could be made.
pub fn taskkill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_name_resolves_with_pathext() {
        let env = BTreeMap::new();
        let resolved = resolve_program("cmd", &env, None);
        assert!(resolved.to_lowercase().ends_with("cmd.exe"), "got {resolved}");
        assert_eq!(resolve_program("cmd.exe", &env, None), "cmd.exe");
    }

    #[test]
    fn cmd_shim_receives_spaced_argument_intact() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("echoarg.cmd");
        std::fs::write(&shim, "@echo %~1\r\n").unwrap();
        let out = std::process::Command::new(&shim).arg("a b").output().expect("strict-quoting path");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "a b");
    }

    #[test]
    fn registry_path_reads() {
        assert!(fresh_path().is_some_and(|p| !p.is_empty()));
    }
}
