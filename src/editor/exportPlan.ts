// Turns the project into the export engine's plan (modules/vidsurge-engine).
//
// Step A of the engine exports the main video track (clips, gaps, speed,
// rotation, flip, crop, canvas shape) and the audio track (every audio clip
// at its place, with speed and volume). Texts, stickers, PIP, opacity and a
// non-black canvas colour behind a picture that doesn't fill the frame come
// in step B.

import type {
    ExportPlan,
    PlanAudioItem,
    PlanVideoItem,
} from "../../modules/vidsurge-engine";
import {
    canvasOf,
    clipEnd,
    exportFrameSize,
    exportVideoBitrate,
    frameAspect,
    projectEnd,
    type ExportSettings,
    type Project,
} from "./clipModel";

const EPS = 0.01;

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

  // Main video: clips in order, gaps (and the tail after the last clip, if
  // the audio goes on longer) as stills in the canvas colour.
  const video: PlanVideoItem[] = [];
  let cursor = 0;
  const clips = [...project.tracks.video].sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    if (clip.start > cursor + EPS) {
      video.push({ type: "gap", duration: clip.start - cursor });
    }
    video.push({
      type: "clip",
      uri: clip.sourceUri,
      trimIn: clip.trimIn,
      trimOut: clip.trimOut,
      speed: clip.speed,
      rotate: clip.rotate ?? 0,
      flipX: !!clip.flipX,
    });
    cursor = Math.max(cursor, clipEnd(clip));
  }
  if (duration > cursor + EPS) {
    video.push({ type: "gap", duration: duration - cursor });
  }

  const audio: PlanAudioItem[] = audioMuted
    ? []
    : project.tracks.audio
        .filter((c) => c.volume > 0)
        .map((c) => ({
          uri: c.sourceUri,
          start: c.start,
          trimIn: c.trimIn,
          trimOut: c.trimOut,
          speed: c.speed,
          volume: Math.max(0, Math.min(1, c.volume)),
        }));

  return {
    outputPath,
    width,
    height,
    fps: settings.fps,
    videoBitrate: exportVideoBitrate(settings, aspect),
    background: canvas.background,
    crop: canvas.crop ?? null,
    video,
    audio,
    duration,
  };
}
