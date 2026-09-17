use std::ffi::c_void;
use std::process::ExitCode;
use std::ptr;

const CF_BITMAP: u32 = 2;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

#[link(name = "user32")]
unsafe extern "system" {
    fn OpenClipboard(owner: *mut c_void) -> i32;
    fn CloseClipboard() -> i32;
    fn IsClipboardFormatAvailable(format: u32) -> i32;
}

fn main() -> ExitCode {
    unsafe {
        if OpenClipboard(ptr::null_mut()) == 0 {
            eprintln!("Could not open the Windows clipboard.");
            return ExitCode::from(2);
        }

        let has_image = IsClipboardFormatAvailable(CF_BITMAP) != 0
            || IsClipboardFormatAvailable(CF_DIB) != 0
            || IsClipboardFormatAvailable(CF_DIBV5) != 0;
        CloseClipboard();

        if has_image {
            println!("image");
        } else {
            println!("text");
        }
    }

    ExitCode::SUCCESS
}
