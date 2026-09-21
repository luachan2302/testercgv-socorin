import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { flush, installTauri, type TauriMock } from "../test/tauri";
import { VideoEditor } from "./VideoEditor";

let tauri: TauriMock;

beforeEach(() => {
  tauri = installTauri("video", {
    video_info: () => ({ name: "Socorin_clip.mp4", bytes: 1234 }),
    video_source: () => new ArrayBuffer(8),
    video_export: () => "Socorin_cut.mp4",
    video_layers_clear: () => undefined,
    video_layer_add: () => undefined,
    video_reveal: () => undefined,
    video_copy: () => undefined,
  });
  URL.createObjectURL = () => "blob:clip";
  URL.revokeObjectURL = () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
});

async function open(duration = 10) {
  const view = render(<VideoEditor />);
  await screen.findByText("Socorin_clip.mp4");
  const video = view.container.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "duration", { configurable: true, value: duration });
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
  fireEvent.loadedMetadata(video);
  const track = view.container.querySelector(".video-track") as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 26 }) as DOMRect;
  return { ...view, video, track };
}

describe("VideoEditor", () => {
  it("loads the recording and only offers a copy once something is edited", async () => {
    await open();
    expect(screen.getByText("0:00.0 – 0:10.0 (0:10.0)")).toBeTruthy();
    expect((screen.getByText("Save copy") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("No sound"));
    expect((screen.getByText("Save copy") as HTMLButtonElement).disabled).toBe(false);
  });

  it("trims with the grips, crops in video pixels and exports what is left", async () => {
    const { container } = await open();
    fireEvent.mouseDown(container.querySelector(".video-grip") as HTMLElement, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 200 }); // 2 s
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(container.querySelector(".video-grip.end") as HTMLElement, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 750 }); // 7.5 s
    fireEvent.mouseUp(window);
    expect(screen.getByText("0:02.0 – 0:07.5 (0:05.5)")).toBeTruthy();

    fireEvent.click(screen.getByText("Crop"));
    fireEvent.mouseDown(container.querySelector(".video-frame") as HTMLElement, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 300 });
    fireEvent.mouseUp(window);
    expect(container.querySelector(".video-crop")).not.toBeNull();

    fireEvent.click(screen.getByText("Save copy"));
    await waitFor(() => expect(tauri.calls("video_export")).toHaveLength(1));
    expect(tauri.calls("video_export")[0]).toEqual({
      edit: { start: 2, end: 7.5, crop: { x: 200, y: 100, width: 800, height: 500 }, mute: false, format: "mp4", layers: [] },
    });
    await screen.findByText("Saved Socorin_cut.mp4");

    fireEvent.click(screen.getByText("Export GIF"));
    await waitFor(() => expect(tauri.calls("video_export")).toHaveLength(2));
    expect((tauri.calls("video_export")[1] as { edit: { format: string } }).edit.format).toBe("gif");
  });

  it("draws boxes, arrows and text for a span of time and sends them as layers", async () => {
    const { container, video } = await open();
    const frame = container.querySelector(".video-frame") as HTMLElement;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 3 });
    fireEvent.timeUpdate(video);

    fireEvent.click(screen.getByText("Box"));
    fireEvent.mouseDown(frame, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 200 });
    fireEvent.mouseUp(window);
    expect(screen.getByText(/Box: 0:03.0 – 0:10.0/)).toBeTruthy();

    // A click without a drag leaves no arrow behind.
    fireEvent.click(screen.getByText("Arrow"));
    fireEvent.mouseDown(frame, { clientX: 400, clientY: 100, button: 0 });
    fireEvent.mouseUp(window);
    expect(container.querySelectorAll(".video-span")).toHaveLength(1);

    fireEvent.click(screen.getByText("Text"));
    fireEvent.mouseDown(frame, { clientX: 50, clientY: 300, button: 0 });
    const input = container.querySelector(".video-typing") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Click here" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelectorAll(".video-span")).toHaveLength(2);
    expect(screen.getByText(/“Click here”: 0:03.0 – 0:10.0/)).toBeTruthy();

    // The text ends at 6 s; the box is removed again.
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 6 });
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByText("Ends here"));
    fireEvent.mouseDown(container.querySelector(".video-span") as HTMLElement);
    fireEvent.click(screen.getByText("Delete"));
    expect(container.querySelectorAll(".video-span")).toHaveLength(1);

    // Upload saves the unsaved edits as an MP4 first, and only once.
    tauri.handlers.video_upload = () => ({ shareUrl: "https://socorin.com/v/abc" });
    fireEvent.click(screen.getByText("Upload"));
    await screen.findByText("Link copied");
    expect(tauri.calls("video_export")).toHaveLength(1);
    fireEvent.click(screen.getByText("Upload"));
    await waitFor(() => expect(tauri.calls("video_upload")).toHaveLength(2));
    expect(tauri.calls("video_export")).toHaveLength(1);
    expect(tauri.calls("video_layers_clear")).toHaveLength(1);
    expect(tauri.calls("video_layer_add")).toHaveLength(1);
    expect((tauri.calls("video_export")[0] as { edit: { layers: unknown } }).edit.layers).toEqual([{ from: 3, to: 6 }]);
  });

  it("reports a failed export and the file actions", async () => {
    tauri.handlers.video_export = () => Promise.reject("ffmpeg failed: boom");
    await open();
    fireEvent.click(screen.getByText("Export GIF"));
    await screen.findByText("ffmpeg failed: boom");
    fireEvent.click(screen.getByText("Copy file"));
    await screen.findByText("Copied the file");
    tauri.handlers.video_upload = () => ({ shareUrl: "https://socorin.com/v/abc" });
    fireEvent.click(screen.getByText("Upload"));
    await screen.findByText("Link copied");
    tauri.handlers.video_upload = () => Promise.reject({ code: "too_large", message: "The file is too large." });
    fireEvent.click(screen.getByText("Upload"));
    await screen.findByText("The file is too large.");
    fireEvent.click(screen.getByText("Show in folder"));
    await act(() => flush());
    expect(tauri.calls("video_reveal")).toHaveLength(1);
  });
});
