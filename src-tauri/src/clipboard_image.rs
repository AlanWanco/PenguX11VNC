use arboard::{Clipboard, ImageData};
use std::borrow::Cow;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{self, Cursor, Read};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::manager::{self, Profile};

pub(crate) const CLIPBOARD_IMAGE_LIMIT: usize = 50 * 1024 * 1024;
const CLIPBOARD_IMAGE_POLL_INTERVAL: Duration = Duration::from_millis(1200);
pub(crate) const REMOTE_FRAME_PYTHON: &str = "import sys; d=sys.stdin.buffer.read(52428801);\nif 0 < len(d) <= 52428800:\n sys.stdout.buffer.write(len(d).to_bytes(4,'big')); sys.stdout.buffer.write(d); sys.stdout.buffer.flush()";

pub(crate) type StatusCallback = Arc<dyn Fn(&'static str) + Send + Sync + 'static>;

pub(crate) struct ClipboardImageSync {
    stop: Arc<AtomicBool>,
    allow_send: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
    reader: Option<JoinHandle<()>>,
    worker: Option<JoinHandle<()>>,
}

impl ClipboardImageSync {
    pub(crate) fn start(
        profile: Profile,
        allow_send: bool,
        on_status: StatusCallback,
    ) -> io::Result<Self> {
        Clipboard::new().map_err(|_| io::Error::other("本机图片剪贴板不可用"))?;

        let mut child = manager::spawn_remote_clipboard_image_watch(&profile)?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("远端图片剪贴板通道不可用"));
        };
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(100));
            match child.try_wait() {
                Ok(Some(_)) => {
                    return Err(io::Error::other("远端 Wayland 图片剪贴板监控未能启动"));
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        }

        let stop = Arc::new(AtomicBool::new(false));
        let allow_send = Arc::new(AtomicBool::new(allow_send));
        let child = Arc::new(Mutex::new(child));
        let (sender, receiver) = mpsc::sync_channel(1);

        let reader_stop = Arc::clone(&stop);
        let reader_status = Arc::clone(&on_status);
        let reader = thread::spawn(move || {
            let _ = read_remote_frames(stdout, sender, &reader_stop);
            if !reader_stop.load(Ordering::Acquire) {
                reader_status("remote-disconnected");
            }
        });

        let worker_stop = Arc::clone(&stop);
        let worker_allow_send = Arc::clone(&allow_send);
        let worker_status = Arc::clone(&on_status);
        let worker = thread::spawn(move || {
            if run_sync_loop(
                profile,
                receiver,
                worker_stop.clone(),
                worker_allow_send,
                worker_status.clone(),
            )
            .is_err()
                && !worker_stop.load(Ordering::Acquire)
            {
                worker_status("failed");
            }
        });

        on_status("started");
        Ok(Self {
            stop,
            allow_send,
            child,
            reader: Some(reader),
            worker: Some(worker),
        })
    }

    pub(crate) fn set_allow_send(&self, allow: bool) {
        self.allow_send.store(allow, Ordering::Release);
    }

    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for ClipboardImageSync {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_remote_frames<R: Read>(
    mut stdout: R,
    sender: SyncSender<Vec<u8>>,
    stop: &AtomicBool,
) -> io::Result<()> {
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut length_bytes = [0_u8; 4];
        match stdout.read_exact(&mut length_bytes) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u32::from_be_bytes(length_bytes) as usize;
        if length == 0 || length > CLIPBOARD_IMAGE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "远端图片长度无效",
            ));
        }
        let mut png = vec![0_u8; length];
        stdout.read_exact(&mut png)?;
        if sender.send(png).is_err() {
            return Ok(());
        }
    }
}

fn run_sync_loop(
    profile: Profile,
    receiver: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    allow_send: Arc<AtomicBool>,
    on_status: StatusCallback,
) -> io::Result<()> {
    let mut clipboard = Clipboard::new().map_err(|_| io::Error::other("本机剪贴板不可用"))?;
    let mut last_image = clipboard
        .get_image()
        .ok()
        .map(|image| image_fingerprint(&image));
    let mut next_poll = Instant::now() + CLIPBOARD_IMAGE_POLL_INTERVAL;

    while !stop.load(Ordering::Acquire) {
        let timeout = next_poll
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(150));
        match receiver.recv_timeout(timeout) {
            Ok(png) => {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                match decode_png(&png) {
                    Ok(image) => {
                        let fingerprint = image_fingerprint(&image);
                        if last_image != Some(fingerprint) {
                            if clipboard.set_image(image).is_ok() {
                                last_image = Some(fingerprint);
                                on_status("received");
                            } else {
                                on_status("failed");
                            }
                        }
                    }
                    Err(_) => on_status("invalid-image"),
                }
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
            Err(RecvTimeoutError::Timeout) => {}
        }

        if stop.load(Ordering::Acquire) || Instant::now() < next_poll {
            continue;
        }
        next_poll = Instant::now() + CLIPBOARD_IMAGE_POLL_INTERVAL;
        let Ok(image) = clipboard.get_image() else {
            last_image = None;
            continue;
        };
        let fingerprint = image_fingerprint(&image);
        if last_image == Some(fingerprint) {
            continue;
        }
        if !allow_send.load(Ordering::Acquire) {
            continue;
        }
        last_image = Some(fingerprint);
        match encode_png(&image).and_then(|png| {
            manager::send_remote_clipboard_image(&profile, &png, &stop)
                .map_err(|_| "远端图片剪贴板写入失败".to_string())
        }) {
            Ok(()) => on_status("sent"),
            Err(_) => on_status("failed"),
        }
    }
    Ok(())
}

fn image_fingerprint(image: &ImageData<'_>) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.width.hash(&mut hasher);
    image.height.hash(&mut hasher);
    image.bytes.as_ref().hash(&mut hasher);
    hasher.finish()
}

fn validate_dimensions(width: usize, height: usize) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err("图片尺寸无效".to_string());
    }
    let rgba_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "图片尺寸超出限制".to_string())?;
    if rgba_len > CLIPBOARD_IMAGE_LIMIT {
        return Err("图片解码尺寸超过 50 MiB".to_string());
    }
    Ok(rgba_len)
}

fn encode_png(image: &ImageData<'_>) -> Result<Vec<u8>, String> {
    let expected = validate_dimensions(image.width, image.height)?;
    if image.bytes.len() != expected {
        return Err("图片像素数据不完整".to_string());
    }
    let width = u32::try_from(image.width).map_err(|_| "图片宽度超出限制".to_string())?;
    let height = u32::try_from(image.height).map_err(|_| "图片高度超出限制".to_string())?;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| "PNG 编码失败".to_string())?;
        writer
            .write_image_data(image.bytes.as_ref())
            .map_err(|_| "PNG 编码失败".to_string())?;
    }
    if png.len() > CLIPBOARD_IMAGE_LIMIT {
        return Err("PNG 图片超过 50 MiB".to_string());
    }
    Ok(png)
}

fn decode_png(bytes: &[u8]) -> Result<ImageData<'static>, String> {
    if bytes.is_empty() || bytes.len() > CLIPBOARD_IMAGE_LIMIT {
        return Err("PNG 图片超过 50 MiB 或为空".to_string());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "PNG 图片格式无效".to_string())?;
    let width = reader.info().width as usize;
    let height = reader.info().height as usize;
    let rgba_len = validate_dimensions(width, height)?;
    let output_len = reader.output_buffer_size();
    if output_len > rgba_len {
        return Err("PNG 解码尺寸超过 50 MiB".to_string());
    }
    let mut output = vec![0_u8; output_len];
    let info = reader
        .next_frame(&mut output)
        .map_err(|_| "PNG 解码失败".to_string())?;
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| "PNG 尺寸无效".to_string())?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => {
            output.truncate(info.buffer_size());
            output
        }
        color_type => {
            let source = &output[..info.buffer_size()];
            let mut rgba = Vec::with_capacity(rgba_len);
            match color_type {
                png::ColorType::Rgb => {
                    for pixel in source.chunks_exact(3) {
                        rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                    }
                }
                png::ColorType::Grayscale => {
                    for gray in source {
                        rgba.extend_from_slice(&[*gray, *gray, *gray, 255]);
                    }
                }
                png::ColorType::GrayscaleAlpha => {
                    for pixel in source.chunks_exact(2) {
                        rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
                    }
                }
                png::ColorType::Indexed => return Err("PNG 调色板展开失败".to_string()),
                png::ColorType::Rgba => unreachable!(),
            }
            rgba
        }
    };
    if rgba.len() != rgba_len || pixels == 0 {
        return Err("PNG 像素数据不完整".to_string());
    }
    Ok(ImageData {
        width,
        height,
        bytes: Cow::Owned(rgba),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image() -> ImageData<'static> {
        ImageData {
            width: 2,
            height: 1,
            bytes: Cow::Owned(vec![255, 0, 0, 255, 0, 128, 255, 64]),
        }
    }

    #[test]
    fn png_round_trip_preserves_rgba_pixels() {
        let original = sample_image();
        let encoded = encode_png(&original).unwrap();
        let decoded = decode_png(&encoded).unwrap();
        assert_eq!(decoded.width, original.width);
        assert_eq!(decoded.height, original.height);
        assert_eq!(decoded.bytes.as_ref(), original.bytes.as_ref());
    }

    #[test]
    fn png_rejects_oversized_and_malformed_payloads() {
        assert!(decode_png(&vec![0; CLIPBOARD_IMAGE_LIMIT + 1]).is_err());
        assert!(decode_png(b"not a png").is_err());
        let malformed = ImageData {
            width: 2,
            height: 1,
            bytes: Cow::Owned(vec![0; 4]),
        };
        assert!(encode_png(&malformed).is_err());
    }

    #[test]
    fn framed_reader_accepts_only_bounded_complete_frames() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut frame = Vec::from((3_u32).to_be_bytes());
        frame.extend_from_slice(b"PNG");
        assert!(read_remote_frames(Cursor::new(frame), sender, &AtomicBool::new(false)).is_ok());
        assert_eq!(receiver.recv().unwrap(), b"PNG");

        let (sender, _receiver) = mpsc::sync_channel(1);
        let oversized = ((CLIPBOARD_IMAGE_LIMIT as u32) + 1).to_be_bytes();
        let error = read_remote_frames(Cursor::new(oversized), sender, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let (sender, _receiver) = mpsc::sync_channel(1);
        let truncated = Vec::from((4_u32).to_be_bytes());
        let error = read_remote_frames(Cursor::new(truncated), sender, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
