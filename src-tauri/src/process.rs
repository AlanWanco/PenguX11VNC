use std::io;
use std::process::{Child, Command};

pub(crate) trait CommandSpawnExt {
    fn spawn_managed(&mut self) -> io::Result<Child>;
}

impl CommandSpawnExt for Command {
    fn spawn_managed(&mut self) -> io::Result<Child> {
        let child = self.spawn()?;
        #[cfg(windows)]
        {
            let mut child = child;
            if let Err(error) = assign_to_process_job(&child) {
                // Very short-lived commands may exit before Windows can add
                // them to the job. Their completed status is still valid.
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return Ok(child);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(child)
        }
        #[cfg(not(windows))]
        {
            Ok(child)
        }
    }
}

#[cfg(windows)]
fn assign_to_process_job(child: &Child) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    let job = process_job()?;
    let process = child.as_raw_handle();
    // SAFETY: both handles are valid for the duration of this call. The job
    // handle is kept open for the app lifetime; Child owns the process handle.
    if unsafe { AssignProcessToJobObject(job, process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn process_job() -> io::Result<windows_sys::Win32::Foundation::HANDLE> {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<Result<usize, i32>> = OnceLock::new();
    match JOB.get_or_init(|| {
        // SAFETY: a null security descriptor and name request an unnamed,
        // non-inheritable job object owned by this process.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error().raw_os_error().unwrap_or(1));
        }

        // SAFETY: this C-compatible structure contains only integer fields;
        // zero initialization is the documented default for unused limits.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is initialized and remains valid for the call.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error().raw_os_error().unwrap_or(1);
            // SAFETY: `handle` was created successfully above and is not stored.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(handle as usize)
    }) {
        Ok(handle) => Ok(*handle as HANDLE),
        Err(code) => Err(io::Error::from_raw_os_error(*code)),
    }
}
