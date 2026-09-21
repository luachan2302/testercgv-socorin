import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, type VideoCrop } from "../lib/ipc";
import { COLORS } from "../editor/types";
import {
  boundsOf,
  fontSizeFor,
  hit,
  paint,
  renderLayer,
  strokeFor,
  visibleAt,
  type Annotation,
  type AnnotationKind,
} from "../video/annotations";

interface Point { x: number; y: number }
type Grip = "start" | "end" | "seek";
type Tool = "select" | "crop" | AnnotationKind;
/** What the mouse is doing on the picture (positions in video pixels). */
type Gesture =
  | { kind: "crop"; from: Point }
  | { kind: "draw"; id: number }
  | { kind: "move"; id: number; from: Point; origin: Annotation };

const MIN_CLIP = 0.2; // seconds
const MIN_SHAPE = 12; // video pixels
const TOOLS: [Tool, string, string][] = [
  ["select", "Select", "Select, move (Delete removes)"],
  ["rect", "Box", "Draw a box"],
  ["arrow", "Arrow", "Draw an arrow"],
  ["text", "Text", "Click where the text goes"],
  ["crop", "Crop", "Draw the part of the picture to keep"],
];

function clock(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * Review of a finished recording: play it, drag the ends of the timeline to
 * trim, crop the picture, put boxes / arrows / text on it for a span of
 * time, then save the cut as a new MP4 or a GIF (ffmpeg, in Rust). The
 * recording itself is never changed.
 */
export function VideoEditor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string | null>(null);
  const gripRef = useRef<Grip | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const nextIdRef = useRef(1);
  const savedKeyRef = useRef(""); // the edits the last saved copy has in it
  const [name, setName] = useState("");
  const [src, setSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mute, setMute] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [crop, setCrop] = useState<VideoCrop | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [typing, setTyping] = useState<(Point & { value: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNote(null);
    setCrop(null);
    setAnnotations([]);
    setSelected(null);
    setTyping(null);
    setTool("select");
    setDuration(0);
    savedKeyRef.current = "";
    try {
      const [info, buffer] = await Promise.all([ipc.videoInfo(), ipc.videoSource()]);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
      setName(info.name);
      setSrc(urlRef.current);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const unlisten = listen("video:reload", () => void load());
    return () => {
      unlisten.then((f) => f());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [load]);

  const onMetadata = () => {
    const v = videoRef.current!;
    // A freshly muxed file may report Infinity until it has been seeked.
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (d === duration) return; // a repeated event must not reset the trim
    setDuration(d);
    setStart(0);
    setEnd(d);
    setTime(0);
  };

  const onTimeUpdate = () => {
    const v = videoRef.current!;
    setTime(v.currentTime);
    if (!v.paused && v.currentTime >= end) {
      v.pause();
      v.currentTime = start;
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
      void v.play();
    } else {
      v.pause();
    }
  };

  // ---- timeline: the two trim grips and the playhead ----
  const timeAt = (clientX: number) => {
    const box = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration;
  };

  const moveGrip = useCallback(
    (clientX: number) => {
      const v = videoRef.current;
      if (!v || !gripRef.current || !duration) return;
      const t = timeAt(clientX);
      if (gripRef.current === "start") {
        const s = Math.min(t, end - MIN_CLIP);
        setStart(s);
        v.currentTime = s;
      } else if (gripRef.current === "end") {
        const e = Math.max(t, start + MIN_CLIP);
        setEnd(e);
        v.currentTime = e;
      } else {
        v.currentTime = Math.max(start, Math.min(end, t));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [duration, start, end],
  );

  const grab = (grip: Grip) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    videoRef.current?.pause();
    gripRef.current = grip;
    moveGrip(e.clientX);
  };

  // ---- the picture: crop and annotations, all in video pixels ----
  /** Video pixels per CSS pixel of the player. */
  const scale = () => {
    const v = videoRef.current;
    const width = v?.getBoundingClientRect().width ?? 0;
    return v && v.videoWidth && width ? v.videoWidth / width : 1;
  };

  const pointIn = (e: { clientX: number; clientY: number }): Point => {
    const v = videoRef.current!;
    const box = v.getBoundingClientRect();
    const k = scale();
    return {
      x: Math.round(Math.max(0, Math.min(box.width, e.clientX - box.left)) * k),
      y: Math.round(Math.max(0, Math.min(box.height, e.clientY - box.top)) * k),
    };
  };

  const sizes = () => {
    const v = videoRef.current;
    return { stroke: strokeFor(v?.videoWidth || 1920), font: fontSizeFor(v?.videoHeight || 1080) };
  };

  const update = (id: number, change: Partial<Annotation>) =>
    setAnnotations((list) => list.map((a) => (a.id === id ? { ...a, ...change } : a)));

  const remove = (id: number) => {
    setAnnotations((list) => list.filter((a) => a.id !== id));
    setSelected((s) => (s === id ? null : s));
  };

  const add = (kind: AnnotationKind, p: Point, text = ""): number => {
    const id = nextIdRef.current++;
    // On screen from the playhead on; "Starts here" / "Ends here" narrow it.
    const from = Math.max(start, Math.min(time, end - MIN_CLIP));
    setAnnotations((list) => [...list, { id, kind, x1: p.x, y1: p.y, x2: p.x, y2: p.y, text, color, from, to: end }]);
    setSelected(id);
    return id;
  };

  const commitText = () => {
    const t = typing;
    setTyping(null);
    if (t && t.value.trim()) add("text", { x: t.x, y: t.y }, t.value.trim());
  };

  const onPictureDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !duration || (e.target as Element).closest(".video-typing")) return;
    e.preventDefault();
    if (typing) commitText();
    const p = pointIn(e);
    if (tool === "crop") {
      gestureRef.current = { kind: "crop", from: p };
      setCrop(null);
    } else if (tool === "rect" || tool === "arrow") {
      videoRef.current?.pause();
      gestureRef.current = { kind: "draw", id: add(tool, p) };
    } else if (tool === "text") {
      videoRef.current?.pause();
      setTyping({ ...p, value: "" });
    } else {
      const { font, stroke } = sizes();
      const ctx = canvasRef.current?.getContext("2d") ?? null;
      const target = [...annotations].reverse().find((a) => visibleAt(a, time) && hit(ctx, a, p.x, p.y, font, stroke * 2));
      setSelected(target ? target.id : null);
      if (target) gestureRef.current = { kind: "move", id: target.id, from: p, origin: target };
      else togglePlay();
    }
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      moveGrip(e.clientX);
      const g = gestureRef.current;
      if (!g) return;
      const p = pointIn(e);
      if (g.kind === "crop") {
        setCrop({ x: Math.min(g.from.x, p.x), y: Math.min(g.from.y, p.y), width: Math.abs(p.x - g.from.x), height: Math.abs(p.y - g.from.y) });
      } else if (g.kind === "draw") {
        update(g.id, { x2: p.x, y2: p.y });
      } else {
        const dx = p.x - g.from.x;
        const dy = p.y - g.from.y;
        update(g.id, { x1: g.origin.x1 + dx, y1: g.origin.y1 + dy, x2: g.origin.x2 + dx, y2: g.origin.y2 + dy });
      }
    };
    const onUp = () => {
      gripRef.current = null;
      const g = gestureRef.current;
      gestureRef.current = null;
      if (g?.kind === "crop") {
        setCrop((c) => (c && c.width >= MIN_SHAPE && c.height >= MIN_SHAPE ? c : null));
      } else if (g?.kind === "draw") {
        // A click without a drag leaves nothing behind.
        setAnnotations((list) => list.filter((a) => a.id !== g.id || Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= MIN_SHAPE));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) remove(selected);
      else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveGrip, selected, start, end]);

  // The preview: what is on screen at the playhead, plus the selected one.
  useEffect(() => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v || !v.videoWidth) return;
    const box = v.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const k = (box.width * dpr) / v.videoWidth;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, v.videoWidth, v.videoHeight);
    const { stroke, font } = sizes();
    for (const a of annotations) {
      if (!visibleAt(a, time) && a.id !== selected) continue;
      paint(ctx, a, stroke, font);
      if (a.id === selected) {
        const b = boundsOf(ctx, a, font);
        ctx.setLineDash([stroke * 1.5, stroke * 1.5]);
        ctx.lineWidth = Math.max(1, stroke / 3);
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(b.x - stroke * 1.5, b.y - stroke * 1.5, b.w + stroke * 3, b.h + stroke * 3);
        ctx.setLineDash([]);
      }
    }
  });

  /** Everything an export depends on: tells whether the last copy is still current. */
  const editKey = () => JSON.stringify({ start, end, crop, mute, annotations });

  const exportAs = async (format: "mp4" | "gif"): Promise<boolean> => {
    const v = videoRef.current;
    if (!v) return false;
    v.pause();
    if (typing) commitText();
    setError(null);
    setNote(null);
    setBusy(format === "gif" ? "Exporting GIF…" : "Saving…");
    try {
      // Only what is on screen during the cut takes part.
      const shown = annotations.filter((a) => a.to > start && a.from < end);
      await ipc.videoLayersClear();
      for (const a of shown) {
        await ipc.videoLayerAdd(await renderLayer(a, v.videoWidth, v.videoHeight));
      }
      const saved = await ipc.videoExport({
        start,
        end,
        crop,
        mute,
        format,
        layers: shown.map((a) => ({ from: a.from, to: a.to })),
      });
      setNote(`Saved ${saved}`);
      savedKeyRef.current = editKey();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Rust uploads what was saved last (else the recording itself), so edits
  // that are in no saved copy yet are saved as an MP4 first.
  const upload = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (edited && savedKeyRef.current !== editKey() && !(await exportAs("mp4"))) return;
    setError(null);
    setNote(null);
    setBusy("Uploading…");
    try {
      await ipc.videoUpload({ x: box.left, y: box.top, width: box.width, height: box.height });
      setNote("Link copied");
    } catch (err) {
      setError(typeof err === "object" && err && "message" in err ? String(err.message) : String(err));
    } finally {
      setBusy(null);
    }
  };

  const act = (what: () => Promise<void>, done?: string) => () => {
    setError(null);
    what()
      .then(() => done && setNote(done))
      .catch((e) => setError(String(e)));
  };

  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");
  const current = annotations.find((a) => a.id === selected) ?? null;
  const edited = start > 0.01 || end < duration - 0.01 || !!crop || mute || annotations.length > 0;
  const k = scale();

  return (
    <div className="editor video-editor">
      <div className="toolbar">
        <button className="tool-btn wide" onClick={togglePlay} disabled={!duration}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="video-clock">
          {clock(time)} / {clock(duration)}
        </span>
        <span className="sep" />
        {TOOLS.map(([id, label, title]) => (
          <button
            key={id}
            className={`tool-btn wide${tool === id ? " active" : ""}`}
            onClick={() => setTool(id)}
            disabled={!duration}
            title={title}
          >
            {label}
          </button>
        ))}
        {crop && (
          <button className="tool-btn wide" onClick={() => setCrop(null)}>
            Clear crop
          </button>
        )}
        <span className="sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`video-swatch${c === color ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`Color ${c}`}
            onClick={() => {
              setColor(c);
              if (current) update(current.id, { color: c });
            }}
          />
        ))}
        <label className="video-check">
          <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} /> No sound
        </label>
        <span className="spacer" />
        <button className="tool-btn wide" onClick={act(ipc.videoReveal)}>
          Show in folder
        </button>
        <button className="tool-btn wide" onClick={act(ipc.videoCopy, "Copied the file")}>
          Copy file
        </button>
        <button
          className="tool-btn wide"
          onClick={(e) => void upload(e)}
          disabled={!duration || !!busy}
          title="Upload the video with its edits and copy the link"
        >
          Upload
        </button>
        <span className="sep" />
        <button className="tool-btn wide" onClick={() => void exportAs("gif")} disabled={!duration || !!busy}>
          Export GIF
        </button>
        <button className="tool-btn wide primary" onClick={() => void exportAs("mp4")} disabled={!duration || !!busy || !edited}>
          Save copy
        </button>
      </div>

      <div className="video-stage">
        {src && (
          <div className={`video-frame${tool === "select" ? "" : " drawing"}`} onMouseDown={onPictureDown}>
            <video
              ref={videoRef}
              src={src}
              muted={mute}
              onLoadedMetadata={onMetadata}
              onDurationChange={onMetadata}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <canvas ref={canvasRef} className="video-annotations" />
            {crop && (
              <div
                className="video-crop"
                style={{ left: crop.x / k, top: crop.y / k, width: crop.width / k, height: crop.height / k }}
              />
            )}
            {typing && (
              <input
                className="video-typing"
                autoFocus
                value={typing.value}
                placeholder="Text, then Enter"
                style={{ left: typing.x / k, top: typing.y / k, color, fontSize: sizes().font / k }}
                onChange={(e) => setTyping({ ...typing, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitText();
                  else if (e.key === "Escape") setTyping(null);
                }}
                onBlur={commitText}
              />
            )}
          </div>
        )}
      </div>

      <div className="video-timeline">
        <div className="video-track" ref={trackRef} onMouseDown={grab("seek")}>
          <div className="video-keep" style={{ left: pct(start), right: `calc(100% - ${pct(end)})` }} />
          <div className="video-grip" style={{ left: pct(start) }} onMouseDown={grab("start")} title="Start" />
          <div className="video-grip end" style={{ left: pct(end) }} onMouseDown={grab("end")} title="End" />
          <div className="video-head" style={{ left: pct(time) }} />
        </div>
        {annotations.length > 0 && (
          <div className="video-spans">
            {annotations.map((a) => (
              <div
                key={a.id}
                className={`video-span${a.id === selected ? " active" : ""}`}
                style={{ left: pct(a.from), width: `calc(${pct(a.to)} - ${pct(a.from)})`, background: a.color }}
                title={a.kind === "text" ? a.text : a.kind}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setSelected(a.id);
                  setTool("select");
                }}
              />
            ))}
          </div>
        )}
        {current && (
          <div className="video-selected">
            <span>
              {current.kind === "text" ? `“${current.text}”` : current.kind === "rect" ? "Box" : "Arrow"}: {clock(current.from)} – {clock(current.to)}
            </span>
            <button className="tool-btn wide" onClick={() => update(current.id, { from: Math.min(time, current.to - MIN_CLIP) })}>
              Starts here
            </button>
            <button className="tool-btn wide" onClick={() => update(current.id, { to: Math.max(time, current.from + MIN_CLIP) })}>
              Ends here
            </button>
            <button className="tool-btn wide" onClick={() => update(current.id, { from: start, to: end })}>
              Whole clip
            </button>
            <button className="tool-btn wide" onClick={() => remove(current.id)}>
              Delete
            </button>
          </div>
        )}
        <div className="video-status">
          <span>{name}</span>
          <span>
            {clock(start)} – {clock(end)} ({clock(end - start)})
          </span>
          <span className={error ? "video-error" : ""}>{error ?? busy ?? note ?? ""}</span>
        </div>
      </div>
    </div>
  );
}
