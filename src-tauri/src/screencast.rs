//! Screen recording on Wayland, where nothing may grab the screen by itself:
//! the ScreenCast portal (xdg-desktop-portal) lets the user pick a monitor
//! and hands out a PipeWire stream of it, which `gst-launch-1.0` encodes
//! into an H.264 (+ AAC) MP4. `-e` makes SIGINT end the pipeline cleanly, so
//! the file gets its index like ffmpeg's does.
//!
//! The portal session lives on a thread of its own for as long as the
//! recording runs (closing it ends the stream). The portal's restore token
//! is kept in the settings, so Record Full Screen only asks the first time;
//! Record always asks, and what it is told holds for that recording only.

use std::{
    os::fd::{AsRawFd, OwnedFd},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};
use tauri::{AppHandle, Runtime};

use crate::{audio, debug, settings};

/// Dropping the sender closes the portal session.
type Release = tauri::async_runtime::Sender<()>;

pub(crate) struct Recorder {
    child: Child,
    _session: Release,
}

/// What the portal granted: the PipeWire remote and the stream on it.
struct Grant {
    fd: OwnedFd,
    node: u32,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    restore_token: Option<String>,
}

impl Recorder {
    /// Asks the portal for a monitor and starts encoding it into `path`.
    /// With `ask` the system dialog always comes up and its answer is for
    /// this recording only; otherwise the remembered monitor is taken (the
    /// dialog shows the first time, or once the restore token is no longer
    /// good). Blocks until the user has answered.
    pub(crate) fn start<R: Runtime>(app: &AppHandle<R>, ask: bool, path: &Path, audio: &mut audio::Choice) -> Result<Self, String> {
        let gst = gst_launch()?;
        let token = settings::current(app).screencast_token;
        let remembered = (!ask && !token.is_empty()).then_some(token);
        let (grant, session) = open_stream(!ask, remembered)?;
        debug::log(format!("screencast: node {} at {:?} size {:?}", grant.node, grant.position, grant.size));
        if let Some(token) = &grant.restore_token {
            let mut settings = settings::current(app);
            settings.screencast_token = token.clone();
            if let Err(e) = settings::store(app, settings) {
                eprintln!("[record] cannot keep the screencast token: {e}");
            }
        }

        let mut child = spawn_gst(&gst, &grant, path, audio)?;
        if audio.input.is_some() && exits_early(&mut child) {
            // Most likely the microphone could not be opened: record without it.
            audio.mute("The microphone could not be opened; recording without sound.".into());
            child = spawn_gst(&gst, &grant, path, audio)?;
        }
        if exits_early(&mut child) {
            return Err(format!("{} could not record the screen. {MISSING}", gst.display()));
        }
        Ok(Self { child, _session: session })
    }

    pub(crate) fn finish(self, timeout: Duration) -> Result<(), String> {
        crate::record::finish_child(self.child, timeout)
    }

    #[cfg(test)]
    pub(crate) fn abandon(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

const MISSING: &str = "Recording on Wayland needs GStreamer: install gstreamer1.0-tools, gstreamer1.0-pipewire, gstreamer1.0-plugins-good, gstreamer1.0-plugins-ugly and gstreamer1.0-libav.";

/// Absolute, like `record::ffmpeg_binary`: a bare name would let a relative
/// PATH entry supply an impostor.
fn gst_launch() -> Result<PathBuf, String> {
    ["/usr/bin", "/usr/local/bin"]
        .iter()
        .map(|dir| Path::new(dir).join("gst-launch-1.0"))
        .find(|p| p.is_file())
        .ok_or_else(|| MISSING.to_string())
}

/// Whether the pipeline gave up right away (a missing element, a device
/// that cannot be opened).
fn exits_early(child: &mut Child) -> bool {
    std::thread::sleep(Duration::from_millis(600));
    !matches!(child.try_wait(), Ok(None))
}

/// The portal handshake, on a thread that then keeps the session open until
/// the returned sender is dropped.
fn open_stream(remember: bool, restore_token: Option<String>) -> Result<(Grant, Release), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Grant, String>>();
    let (release_tx, mut release_rx) = tauri::async_runtime::channel::<()>(1);
    std::thread::spawn(move || {
        tauri::async_runtime::block_on(async move {
            let opened = async {
                let proxy = Screencast::new().await?;
                let session = proxy.create_session(Default::default()).await?;
                proxy
                    .select_sources(
                        &session,
                        SelectSourcesOptions::default()
                            .set_cursor_mode(CursorMode::Embedded)
                            .set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Monitor))
                            .set_multiple(false)
                            .set_persist_mode(if remember { PersistMode::ExplicitlyRevoked } else { PersistMode::DoNot })
                            .set_restore_token(restore_token.as_deref()),
                    )
                    .await?;
                let streams = proxy.start(&session, None, Default::default()).await?.response()?;
                let stream = streams.streams().first().ok_or(ashpd::Error::NoResponse)?;
                let grant = Grant {
                    fd: proxy.open_pipe_wire_remote(&session, Default::default()).await?,
                    node: stream.pipe_wire_node_id(),
                    position: stream.position(),
                    size: stream.size(),
                    restore_token: streams.restore_token().map(str::to_owned),
                };
                Ok::<_, ashpd::Error>((proxy, session, grant))
            }
            .await;
            match opened {
                Ok((_proxy, session, grant)) => {
                    if ready_tx.send(Ok(grant)).is_ok() {
                        release_rx.recv().await; // until the recorder is dropped
                    }
                    let _ = session.close().await;
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(match e {
                        ashpd::Error::Response(_) => "Screen sharing was not allowed.".to_string(),
                        e => format!("the screen-cast portal failed: {e}"),
                    }));
                }
            }
        });
    });
    let grant = ready_rx.recv().map_err(|_| "the screen-cast portal did not answer".to_string())??;
    Ok((grant, release_tx))
}

/// `pipewiresrc` only delivers a frame when the screen changes;
/// `keepalive-time` repeats the last one so a still screen is recorded too,
/// and `videorate` makes it the constant 30 fps the other recorders write.
fn spawn_gst(gst: &Path, grant: &Grant, path: &Path, audio: &audio::Choice) -> Result<Child, String> {
    let fd = grant.fd.as_raw_fd();
    let mut cmd = Command::new(gst);
    cmd.args(["-e", "-q", "pipewiresrc"])
        .arg(format!("fd={fd}"))
        .arg(format!("path={}", grant.node))
        .args(["do-timestamp=true", "keepalive-time=1000", "resend-last=true"])
        .args(["!", "videoconvert", "!", "videorate", "!", "video/x-raw,format=I420,framerate=30/1"])
        .args(["!", "x264enc", "speed-preset=veryfast", "pass=qual", "quantizer=23", "key-int-max=60"])
        .args(["!", "h264parse", "!", "queue", "!", "mux."]);
    if let Some(input) = &audio.input {
        cmd.arg("pulsesrc");
        if !audio.default {
            cmd.arg(format!("device={}", input.id));
        }
        cmd.args(["!", "audioconvert", "!", "audioresample", "!", "avenc_aac", "bitrate=128000"])
            .args(["!", "aacparse", "!", "queue", "!", "mux."]);
    }
    cmd.args(["mp4mux", "name=mux", "faststart=true", "!", "filesink"])
        // gst-launch parses its arguments as one line: quote the file name.
        .arg(format!("location=\"{}\"", path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")))
        .stdin(Stdio::null())
        .stdout(crate::record::quiet())
        .stderr(crate::record::quiet());
    // The PipeWire remote is close-on-exec: let this one child inherit it.
    unsafe {
        cmd.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| format!("cannot start {}: {e}", gst.display()))
}
