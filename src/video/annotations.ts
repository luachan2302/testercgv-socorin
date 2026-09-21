/**
 * Text, arrows and boxes on a recording. Everything is in video pixels, so
 * the preview (a canvas scaled over the player) and the export (a PNG as
 * large as the picture, laid over it by ffmpeg) are drawn by the same code.
 */

export type AnnotationKind = "rect" | "arrow" | "text";

export interface Annotation {
  id: number;
  kind: AnnotationKind;
  /** rect: two corners; arrow: tail, then head; text: the top-left corner (x2 / y2 unused). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
  color: string;
  /** On screen from / to, in seconds of the recording. */
  from: number;
  to: number;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Line width for a picture that wide: 6 px on a 1080p recording. */
export function strokeFor(videoWidth: number): number {
  return Math.max(3, Math.round(videoWidth / 320));
}

/** Text height for a picture that high: 48 px on a 1080p recording. */
export function fontSizeFor(videoHeight: number): number {
  return Math.max(16, Math.round(videoHeight / 22.5));
}

export function visibleAt(a: Annotation, t: number): boolean {
  return t >= a.from - 0.001 && t <= a.to + 0.001;
}

interface Box { x: number; y: number; w: number; h: number }

/** The rectangle an annotation covers (what a click selects, what a move drags). */
export function boundsOf(ctx: CanvasRenderingContext2D | null, a: Annotation, fontSize: number): Box {
  if (a.kind === "text") {
    let width = a.text.length * fontSize * 0.6;
    if (ctx) {
      ctx.font = `bold ${fontSize}px ${FONT}`;
      width = ctx.measureText(a.text).width || width;
    }
    return { x: a.x1, y: a.y1, w: width, h: fontSize * 1.25 };
  }
  return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
}

export function hit(ctx: CanvasRenderingContext2D | null, a: Annotation, x: number, y: number, fontSize: number, slack: number): boolean {
  const b = boundsOf(ctx, a, fontSize);
  return x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;
}

/** Draw `a` in video pixels; the caller has scaled the context for a preview. */
export function paint(ctx: CanvasRenderingContext2D, a: Annotation, stroke: number, fontSize: number) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = stroke;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (a.kind === "rect") {
    const b = boundsOf(ctx, a, fontSize);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  } else if (a.kind === "arrow") {
    // The head the image editor draws (see Shapes.tsx).
    const length = stroke * 3.5 + 4;
    const width = stroke * 3 + 4;
    const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const bx = a.x2 - Math.cos(angle) * length;
    const by = a.y2 - Math.sin(angle) * length;
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.x2, a.y2);
    ctx.lineTo(bx + Math.sin(angle) * (width / 2), by - Math.cos(angle) * (width / 2));
    ctx.lineTo(bx - Math.sin(angle) * (width / 2), by + Math.cos(angle) * (width / 2));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.font = `bold ${fontSize}px ${FONT}`;
    ctx.textBaseline = "top";
    // A dark rim keeps the text readable on any picture.
    ctx.lineWidth = Math.max(2, fontSize / 8);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(a.text, a.x1, a.y1);
    ctx.fillText(a.text, a.x1, a.y1);
  }
  ctx.restore();
}

/** One annotation as a transparent PNG as large as the picture. */
export function renderLayer(a: Annotation, videoWidth: number, videoHeight: number): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("cannot draw the annotations"));
  paint(ctx, a, strokeFor(videoWidth), fontSizeFor(videoHeight));
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) blob.arrayBuffer().then(resolve, reject);
      else reject(new Error("cannot encode the annotations"));
    }, "image/png");
  });
}
