// Turns the project into the engine's plans (modules/vidsurge-engine):
// the PREVIEW plan (what the native preview plays) and the EXPORT plan. Both
// come from the same timeline builder below, and the native side builds
// both with the same code (TimelineBuilder.kt) — so the export shows what
// the preview showed.
//
// The export plan has everything the exported video shows:
//   - the main video track (clips, gaps, speed, rotation, flip, crop,
//     opacity) on the canvas colour,
//   - the PIP clips (video or photo) with their place, size, turn and
//     opacity, in pixels of the exported frame,
//   - the texts and stickers — drawn by the app itself (OverlayRenderer)
//     as one transparent picture per stretch of time (see
//     overlaySegments); their files are added to the plan after that,
//   - every audio clip at its place, with speed and volume.

import type {
  ExportPlan,
  PlanAudioItem,
  PlanPipItem,
  PlanVideoItem,
  PreviewPlan,
} from "../../modules/vidsurge-engine";
import type { OverlayItem } from "../components/editor/TextOverlay";
import {
  canvasOf,
  clipEnd,
  exportFrameSize,
  exportVideoBitrate,
  frameAspect,
  pipDataOf,
  pipSize,
  projectEnd,
  stickerDataOf,
  textDataOf,
  type CanvasSettings,
  type Clip,
  type ExportSettings,
  type Project,
} from "./clipModel";
import { MAX_VOLUME } from "./projectReducer";

const EPS = 0.01;

// ---- Same fitting rules as the preview (TextOverlay) ----------------------

/** Half the width / height of a w × h box turned by `deg`. */
function halfExtents(w: number, h: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const sn = Math.abs(Math.sin(rad));
  return { hw: (w * c + h * sn) / 2, hh: (w * sn + h * c) / 2 };
}

/** A centre that keeps a box of half-size `half` inside 0…size. */
function clampCenter(center: number, half: number, size: number) {
  if (half * 2 >= size) return size / 2;
  return Math.max(half, Math.min(center, size - half));
}

/**
 * Where a PIP is drawn in a W × H px frame, exactly like the preview: its
 * size from the clip, shrunk if (turned) it's bigger than the frame, and
 * its centre pulled in so it stays whole inside the frame.
 */
function pipLayout(clip: Clip, W: number, H: number) {
  const d = pipDataOf(clip);
  const size = pipSize(d, W);
  const { hw, hh } = halfExtents(size.w, size.h, d.rotation);
  const fit = hw > 0 && hh > 0 ? Math.min(1, W / (2 * hw), H / (2 * hh)) : 1;
  return {
    cx: clampCenter(d.x * W, hw * fit, W),
    cy: clampCenter(d.y * H, hh * fit, H),
    w: size.w * fit,
    h: size.h * fit,
    rotation: d.rotation,
    kind: d.kind,
  };
}

/**
 * Live values the preview shows before they're saved (a sheet is open):
 * the Opacity sheet's draft, the Rotate sheet's draft, and "flat" while
 * cropping (the whole picture, unturned, so the crop box fits it).
 */
export type PreviewDrafts = {
  opacity?: { clipId: string; value: number } | null;
  rotate?: { clipId: string; angle: number; flip: boolean } | null;
  flat?: boolean;
};

/** The main video track: clips in order, gaps (and the tail) in the canvas colour. */
function mainVideoItems(
  project: Project,
  duration: number,
  drafts?: PreviewDrafts,
): PlanVideoItem[] {
  const video: PlanVideoItem[] = [];
  let cursor = 0;
  const clips = [...project.tracks.video].sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    if (clip.start > cursor + EPS) {
      video.push({ type: "gap", duration: clip.start - cursor });
    }
    const rotDraft =
      drafts?.rotate && drafts.rotate.clipId === clip.id ? drafts.rotate : null;
    const opacity =
      drafts?.opacity && drafts.opacity.clipId === clip.id
        ? drafts.opacity.value
        : (clip.opacity ?? 1);
    video.push({
      type: "clip",
      id: clip.id,
      uri: clip.sourceUri,
      sourceDuration: clip.sourceDuration,
      trimIn: clip.trimIn,
      trimOut: clip.trimOut,
      speed: clip.speed,
      rotate: drafts?.flat ? 0 : rotDraft ? rotDraft.angle : (clip.rotate ?? 0),
      flipX: drafts?.flat ? false : rotDraft ? rotDraft.flip : !!clip.flipX,
      opacity: Math.max(0, Math.min(1, opacity)),
    });
    cursor = Math.max(cursor, clipEnd(clip));
  }
  if (duration > cursor + EPS) {
    video.push({ type: "gap", duration: duration - cursor });
  }
  return video;
}

/** Every audio clip (volume 0 too: its volume can change live in the preview). */
function audioItems(project: Project): PlanAudioItem[] {
  return project.tracks.audio.map((c) => ({
    id: c.id,
    uri: c.sourceUri,
    sourceDuration: c.sourceDuration,
    start: c.start,
    trimIn: c.trimIn,
    trimOut: c.trimOut,
    speed: c.speed,
    // Up to 200% (the Volume tool's maximum).
    volume: Math.max(0, Math.min(MAX_VOLUME, c.volume)),
  }));
}

// The preview's picture: a 720P frame (the preview view scales it to the
// screen). Fixed, so entering / leaving fullscreen doesn't reload anything.
const PREVIEW_SETTINGS: ExportSettings = { resolution: 720, fps: 30 };

/**
 * What the native preview plays (see PreviewPlan). `canvas` is the one on
 * screen (with the Canvas sheet's draft, or flat while cropping). The mute
 * button is NOT in the plan (the preview mutes live).
 */
export function buildPreviewPlan({
  project,
  canvas,
  videoAspect,
  drafts,
}: {
  project: Project;
  canvas: CanvasSettings;
  videoAspect: number | null;
  drafts?: PreviewDrafts;
}): PreviewPlan {
  const aspect = frameAspect(canvas, videoAspect);
  const { width, height } = exportFrameSize(PREVIEW_SETTINGS, aspect);
  const duration = projectEnd(project);
  return {
    width,
    height,
    fps: PREVIEW_SETTINGS.fps,
    background: canvas.background,
    crop: canvas.crop ?? null,
    video: mainVideoItems(project, duration, drafts),
    // For the PIP view's sync: which clip, when, which part of the file.
    // (Its place and size come from the app's PIP frame.)
    pip: [...project.tracks.pip]
      .sort((a, b) => a.start - b.start)
      .map((c) => ({
        id: c.id,
        kind: pipDataOf(c).kind,
        uri: c.sourceUri,
        start: c.start,
        trimIn: c.trimIn,
        trimOut: c.trimOut,
        speed: c.speed,
        opacity: c.opacity,
        cx: 0,
        cy: 0,
        w: 0,
        h: 0,
        rotation: 0,
      })),
    audio: audioItems(project),
    duration,
  };
}

export function buildExportPlan({
  project,
  settings,
  videoAspect,
  audioMuted,
  outputPath,
}: {
  project: Project;
  settings: ExportSettings;
  /** The main video's width ÷ height (null = unknown yet). */
  videoAspect: number | null;
  /** The timeline's mute button: no sound at all. */
  audioMuted: boolean;
  outputPath: string;
}): ExportPlan {
  const canvas = canvasOf(project);
  const aspect = frameAspect(canvas, videoAspect);
  const { width, height } = exportFrameSize(settings, aspect);
  const duration = projectEnd(project);

  // PIP clips (silent, like in the preview).
  const pip: PlanPipItem[] = [...project.tracks.pip]
    .sort((a, b) => a.start - b.start)
    .filter((c) => c.opacity > 0.001)
    .map((c) => {
      const l = pipLayout(c, width, height);
      return {
        id: c.id,
        kind: l.kind,
        uri: c.sourceUri,
        start: c.start,
        trimIn: c.trimIn,
        trimOut: c.trimOut,
        speed: c.speed,
        opacity: Math.max(0, Math.min(1, c.opacity)),
        cx: l.cx,
        cy: l.cy,
        w: l.w,
        h: l.h,
        rotation: l.rotation,
      };
    });

  return {
    outputPath,
    width,
    height,
    fps: settings.fps,
    videoBitrate: exportVideoBitrate(settings, aspect),
    background: canvas.background,
    crop: canvas.crop ?? null,
    video: mainVideoItems(project, duration),
    pip,
    // Filled in once the texts / stickers are drawn (OverlayRenderer).
    overlays: [],
    audio: audioMuted ? [] : audioItems(project).filter((a) => a.volume > 0),
    duration,
  };
}

/** A stretch of time with the same texts / stickers on screen. */
export type OverlaySegment = {
  start: number;
  end: number;
  /** Bottom to top, like the preview: texts, then stickers. */
  items: OverlayItem[];
};

/**
 * The export's texts and stickers, cut into stretches of time where the
 * same ones are on screen (a new stretch starts wherever one appears or
 * goes). Stretches with nothing on screen are left out.
 */
export function overlaySegments(
  project: Project,
  duration: number,
): OverlaySegment[] {
  const texts = project.tracks.text.filter(
    (c) => textDataOf(c).text.trim() !== "",
  );
  const stickers = project.tracks.sticker;
  const all = [...texts, ...stickers];
  if (all.length === 0 || duration <= 0) return [];

  const cuts = new Set<number>([0, duration]);
  for (const c of all) {
    const s = Math.max(0, Math.min(duration, c.start));
    const e = Math.max(0, Math.min(duration, clipEnd(c)));
    cuts.add(Math.round(s * 1000) / 1000);
    cuts.add(Math.round(e * 1000) / 1000);
  }
  const times = [...cuts].sort((a, b) => a - b);

  const segments: OverlaySegment[] = [];
  let prevKey = "";
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i];
    const end = times[i + 1];
    if (end - start < 0.001) continue;
    const mid = (start + end) / 2;
    const on = (c: Clip) => mid >= c.start && mid < clipEnd(c);
    const items: OverlayItem[] = [
      ...texts
        .filter(on)
        .map((c) => ({ id: c.id, kind: "text" as const, data: textDataOf(c) })),
      ...stickers.filter(on).map((c) => ({
        id: c.id,
        kind: "sticker" as const,
        data: stickerDataOf(c),
      })),
    ];
    if (items.length === 0) {
      prevKey = "";
      continue;
    }
    const key = items.map((it) => it.id).join("|");
    const last = segments[segments.length - 1];
    if (last && key === prevKey && Math.abs(last.end - start) < 0.0005) {
      last.end = end; // same texts / stickers go on: one picture
    } else {
      segments.push({ start, end, items });
    }
    prevKey = key;
  }
  return segments;
}
