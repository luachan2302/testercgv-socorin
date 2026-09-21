//! The review window a finished recording opens in: play it, trim the ends,
//! crop the picture, drop the sound, put text / arrows / boxes on it, export
//! a GIF. The annotations arrive as transparent PNGs the size of the picture
//! (the page draws them, so the export looks like the preview) and are laid
//! over it for their time span. The edits are made by
//! ffmpeg into a new file next to the recording, which itself is never
//! touched.
//!
//! The page never names a file: the recording under review is kept here
//! (`VideoState`), the page gets its bytes (`source`) and says what to cut.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::{capture, clipboard, debug, record, settings, share, windows};

#[derive(Default)]
pub struct VideoState {
    /// The recording under review.
    source: Mutex<Option<PathBuf>>,
    /// What the last export wrote: "Show in folder" / "Copy" mean that one.
    exported: Mutex<Option<PathBuf>>,
    /// The annotation PNGs of the export being prepared, in `Edit::layers` order.
    layers: Mutex<Vec<Vec<u8>>>,
}

const MAX_LAYERS: usize = 40;
const MAX_LAYER_BYTES: usize = 16 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// When an annotation layer is on screen, in seconds of the recording.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Layer {
    pub from: f64,
    pub to: f64,
}

/// A rectangle of the picture, in video pixels.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Mp4,
    Gif,
}

/// What to keep of the recording. `start` / `end` are seconds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub start: f64,
    pub end: f64,
    pub crop: Option<Crop>,
    pub mute: bool,
    pub format: Format,
    /// One per PNG handed over with `add_layer`, in the same order.
    #[serde(default)]
    pub layers: Vec<Layer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub name: String,
    pub bytes: u64,
}

/// Open `path` in the review window (a plain reveal when that fails).
pub fn open<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    let state = app.state::<VideoState>();
    *state.source.lock().unwrap() = Some(path.to_path_buf());
    *state.exported.lock().unwrap() = None;
    state.layers.lock().unwrap().clear();
    if let Err(e) = windows::open_video(app) {
        eprintln!("[video] {e}");
        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
    }
}

/// The review window is gone.
pub fn forget<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<VideoState>();
    *state.source.lock().unwrap() = None;
    *state.exported.lock().unwrap() = None;
    state.layers.lock().unwrap().clear();
}

/// Start collecting the annotation layers of an export.
pub fn clear_layers<R: Runtime>(app: &AppHandle<R>) {
    app.state::<VideoState>().layers.lock().unwrap().clear();
}

/// One annotation layer: a PNG as large as the picture.
pub fn add_layer<R: Runtime>(app: &AppHandle<R>, png: Vec<u8>) -> Result<(), String> {
    if !png.starts_with(PNG_MAGIC) || png.len() > MAX_LAYER_BYTES {
        return Err("an annotation layer must be a PNG".into());
    }
    let state = app.state::<VideoState>();
    let mut layers = state.layers.lock().unwrap();
    if layers.len() >= MAX_LAYERS {
        return Err(format!("at most {MAX_LAYERS} annotations can be exported"));
    }
    layers.push(png);
    Ok(())
}

fn source<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let path = app.state::<VideoState>().source.lock().unwrap().clone().ok_or("no recording")?;
    // Like `record::stop_with`: only a regular file at that name counts.
    let is_file = std::fs::symlink_metadata(&path).map(|m| m.is_file()).unwrap_or(false);
    if is_file {
        Ok(path)
    } else {
        Err(format!("{} is gone", path.display()))
    }
}

pub fn info<R: Runtime>(app: &AppHandle<R>) -> Result<Info, String> {
    let path = source(app)?;
    Ok(Info {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
    })
}

/// The recording's bytes, for the page's `<video>` (as a blob).
pub fn bytes<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<u8>, String> {
    let path = source(app)?;
    std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// The file "Show in folder" / "Copy" act on: the last export, else the recording.
fn current<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let exported = app.state::<VideoState>().exported.lock().unwrap().clone();
    match exported.filter(|p| p.is_file()) {
        Some(path) => Ok(path),
        None => source(app),
    }
}

pub fn reveal<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(current(app)?).map_err(|e| e.to_string())
}

pub fn copy<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    clipboard::copy_file(app, &current(app)?)
}

/// Upload the last export (else the recording) to the share server, put the
/// link on the clipboard and show the popover at `anchor`, like Stop &
/// upload does. Blocks while it uploads: call it from a worker thread.
pub fn upload<R: Runtime>(app: &AppHandle<R>, anchor: Option<share::Anchor>) -> Result<share::PublicLink, share::ShareError> {
    let path = current(app).map_err(|e| share::ShareError::new("io", e))?;
    let is_gif = path.extension().map_or(false, |e| e.eq_ignore_ascii_case("gif"));
    let (kind, mime) = match share::video_mime(&path) {
        Some(mime) => (share::Kind::Video, mime),
        None if is_gif => (share::Kind::Image, "image/gif"),
        None => return Err(share::ShareError::new("unsupported_type", "Only MP4, WebM and GIF files can be uploaded.")),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
    let outcome = tauri::async_runtime::block_on(async {
        let limits = share::limits(app).await?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // Held against the limit before the file is read (see `record::upload_recording`).
        let host = share::host_of(&settings::current(app).upload_server);
        share::check(&limits, mime, size, &host)?;
        let bytes = std::fs::read(&path).map_err(|e| share::ShareError::new("io", format!("cannot read {}: {e}", path.display())))?;
        share::upload(app, bytes, kind, mime, name).await
    });
    share::announce(app, outcome, anchor)
}

/// Write the edited copy (blocks while ffmpeg runs). Returns its file name.
pub fn export<R: Runtime>(app: &AppHandle<R>, edit: &Edit) -> Result<String, String> {
    let input = source(app)?;
    let ffmpeg = record::ffmpeg_binary(app)?;
    let settings = settings::current(app);
    let ext = if edit.format == Format::Gif { "gif" } else { "mp4" };
    let pngs = std::mem::take(&mut *app.state::<VideoState>().layers.lock().unwrap());
    if pngs.len() != edit.layers.len() {
        return Err("the annotations did not arrive completely; try again".into());
    }
    let output = capture::reserve_path(&settings::save_dir(app), &settings.file_prefix, ext)?;
    // The layers go to a folder of our own next to the output while ffmpeg reads them.
    let scratch = if pngs.is_empty() { None } else { Some(record::scratch_dir(&output)?) };
    let layer_files: Result<Vec<PathBuf>, String> = pngs
        .iter()
        .enumerate()
        .map(|(n, png)| {
            let file = scratch.as_ref().ok_or("no scratch folder")?.join(format!("layer-{n}.png"));
            std::fs::write(&file, png).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
            Ok(file)
        })
        .collect();
    let result = layer_files.and_then(|files| ffmpeg_args(edit, &input, &files, &output)).and_then(|args| {
        debug::log(format!("video export: {}", args.join(" ")));
        Command::new(&ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("cannot start {}: {e}", ffmpeg.display()))
    });
    if let Some(dir) = &scratch {
        let _ = std::fs::remove_dir_all(dir);
    }
    let failure = match result {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("").trim())),
        Err(e) => Some(e),
    };
    if let Some(e) = failure {
        let _ = std::fs::remove_file(&output);
        return Err(e);
    }
    let name = output.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    *app.state::<VideoState>().exported.lock().unwrap() = Some(output);
    Ok(name)
}

/// ffmpeg's arguments for `edit`. Cutting only the end (or the sound) copies
/// the streams as they are; a later start, a crop or annotations re-encode
/// the picture, since a copy can only begin at a key frame (every 2 s in our
/// recordings). `layers` are the annotation PNGs, one per `edit.layers`.
pub(crate) fn ffmpeg_args(edit: &Edit, input: &Path, layers: &[PathBuf], output: &Path) -> Result<Vec<String>, String> {
    let start = edit.start.max(0.0);
    if !(edit.end.is_finite() && start.is_finite() && edit.end - start >= 0.1) {
        return Err("the selection is too short".into());
    }
    if layers.len() != edit.layers.len() {
        return Err("every annotation needs its picture".into());
    }
    // What happens to the picture once the annotations are on it.
    let mut picture: Vec<String> = Vec::new();
    if let Some(c) = edit.crop {
        // Even sizes, as yuv420p needs them.
        let (w, h) = (c.width / 2 * 2, c.height / 2 * 2);
        if w < 2 || h < 2 {
            return Err("the crop is too small".into());
        }
        picture.push(format!("crop={w}:{h}:{}:{}", c.x, c.y));
    }
    if edit.format == Format::Gif {
        picture.push("fps=12,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5".into());
    }
    let picture = picture.join(",");

    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y"].map(String::from).to_vec();
    args.extend(["-ss".into(), format!("{start:.3}"), "-to".into(), format!("{:.3}", edit.end), "-i".into()]);
    args.push(input.to_string_lossy().into_owned());
    for layer in layers {
        args.extend(["-i".into(), layer.to_string_lossy().into_owned()]);
    }
    let reencode = !layers.is_empty() || !picture.is_empty() || start > 0.0;
    if !layers.is_empty() {
        // `-ss` before `-i` makes the cut start at t = 0: shift the spans.
        let mut graph = String::new();
        let mut last = "0:v".to_string();
        for (n, span) in edit.layers.iter().enumerate() {
            let from = (span.from - start).max(0.0);
            let to = (span.to - start).max(from);
            graph.push_str(&format!("[{last}][{}:v]overlay=enable='between(t,{from:.3},{to:.3})'[v{}];", n + 1, n + 1));
            last = format!("v{}", n + 1);
        }
        let tail = if picture.is_empty() { "null" } else { picture.as_str() };
        graph.push_str(&format!("[{last}]{tail}[out]"));
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[out]".into()]);
        if edit.format == Format::Mp4 && !edit.mute {
            args.extend(["-map".into(), "0:a?".into()]);
        }
    } else if !picture.is_empty() {
        args.extend(["-vf".into(), picture]);
    }
    match edit.format {
        Format::Gif => args.extend(["-an".into(), "-loop".into(), "0".into()]),
        Format::Mp4 => {
            if reencode {
                args.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"].map(String::from));
            } else {
                args.extend(["-c:v".into(), "copy".into()]);
            }
            if edit.mute {
                args.push("-an".into());
            } else {
                args.extend(["-c:a".into(), "copy".into()]);
            }
            args.extend(["-movflags".into(), "+faststart".into()]);
        }
    }
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(start: f64, end: f64, crop: Option<Crop>, mute: bool, format: Format) -> Edit {
        Edit { start, end, crop, mute, format, layers: Vec::new() }
    }

    fn args(e: &Edit) -> String {
        let layers: Vec<PathBuf> = (0..e.layers.len()).map(|n| PathBuf::from(format!("/l{n}.png"))).collect();
        ffmpeg_args(e, Path::new("/in.mp4"), &layers, Path::new("/out")).unwrap().join(" ")
    }

    #[test]
    fn annotations_are_laid_over_the_cut_for_their_time_span() {
        let mut e = edit(1.0, 5.0, Some(Crop { x: 100, y: 100, width: 1000, height: 600 }), false, Format::Mp4);
        e.layers = vec![Layer { from: 2.0, to: 3.0 }, Layer { from: 0.0, to: 9.0 }];
        let a = args(&e);
        assert!(a.contains("-i /in.mp4 -i /l0.png -i /l1.png"), "{a}");
        assert!(
            a.contains("[0:v][1:v]overlay=enable='between(t,1.000,2.000)'[v1];[v1][2:v]overlay=enable='between(t,0.000,8.000)'[v2];[v2]crop=1000:600:100:100[out]"),
            "{a}"
        );
        assert!(a.contains("-map [out] -map 0:a?") && a.contains("-c:v libx264") && !a.contains("-vf"), "{a}");

        // Nothing else to do to the picture; a GIF takes no sound.
        let mut e = edit(0.0, 2.0, None, false, Format::Gif);
        e.layers = vec![Layer { from: 0.5, to: 1.0 }];
        let a = args(&e);
        assert!(a.contains("[v1]fps=12") && a.contains("paletteuse=dither=bayer:bayer_scale=5[out]") && !a.contains("0:a?"), "{a}");
        let mut e = edit(0.0, 2.0, None, true, Format::Mp4);
        e.layers = vec![Layer { from: 0.5, to: 1.0 }];
        let a = args(&e);
        assert!(a.contains("[v1]null[out]") && !a.contains("0:a?") && a.contains("-an"), "{a}");
        // A layer without its picture is refused.
        assert!(ffmpeg_args(&e, Path::new("/i"), &[], Path::new("/o")).is_err());
    }

    #[test]
    fn cutting_the_end_or_the_sound_copies_the_streams() {
        let a = args(&edit(0.0, 4.5, None, false, Format::Mp4));
        assert!(a.contains("-ss 0.000 -to 4.500 -i /in.mp4"), "{a}");
        assert!(a.contains("-c:v copy") && a.contains("-c:a copy"), "{a}");
        let a = args(&edit(0.0, 4.5, None, true, Format::Mp4));
        assert!(a.contains("-c:v copy") && a.contains("-an") && !a.contains("-c:a"), "{a}");
    }

    #[test]
    fn a_later_start_or_a_crop_re_encodes_the_picture() {
        let a = args(&edit(1.25, 4.0, None, false, Format::Mp4));
        assert!(a.contains("-c:v libx264") && !a.contains("-vf"), "{a}");
        let crop = Crop { x: 10, y: 21, width: 101, height: 51 };
        let a = args(&edit(0.0, 4.0, Some(crop), false, Format::Mp4));
        assert!(a.contains("-vf crop=100:50:10:21") && a.contains("-c:v libx264"), "{a}");
    }

    #[test]
    fn a_gif_has_no_sound_and_its_own_palette() {
        let crop = Crop { x: 0, y: 0, width: 64, height: 64 };
        let a = args(&edit(0.0, 2.0, Some(crop), false, Format::Gif));
        assert!(a.contains("-an") && a.contains("crop=64:64:0:0,fps=12") && a.contains("palettegen"), "{a}");
        assert!(!a.contains("libx264"), "{a}");
    }

    #[test]
    fn nonsense_selections_are_refused() {
        assert!(ffmpeg_args(&edit(2.0, 2.05, None, false, Format::Mp4), Path::new("/i"), &[], Path::new("/o")).is_err());
        assert!(ffmpeg_args(&edit(0.0, f64::NAN, None, false, Format::Mp4), Path::new("/i"), &[], Path::new("/o")).is_err());
        let tiny = Crop { x: 0, y: 0, width: 1, height: 40 };
        assert!(ffmpeg_args(&edit(0.0, 2.0, Some(tiny), false, Format::Mp4), Path::new("/i"), &[], Path::new("/o")).is_err());
    }
}
