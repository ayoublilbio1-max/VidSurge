// VidSurge export engine — JavaScript side.
//
// The native part (android/…/VidsurgeEngineModule.kt) only exists in an app
// build made after this module was added. Before that — and on iOS for now —
// `isEngineAvailable()` is false and exportVideo() rejects with a clear
// message instead of the app crashing on start.

import { requireOptionalNativeModule } from "expo";

/** One piece of the main video track, in timeline order. */
export type PlanVideoItem =
  | { type: "gap"; duration: number }
  | {
      type: "clip";
      uri: string;
      /** Source seconds. */
      trimIn: number;
      trimOut: number;
      speed: number;
      /** Degrees, clockwise (like the editor). */
      rotate: number;
      flipX: boolean;
      /** 0–1 (Opacity tool); the canvas colour shows through. */
      opacity: number;
    };

/** One audio clip, placed at `start` on the timeline (seconds). */
export type PlanAudioItem = {
  uri: string;
  start: number;
  trimIn: number;
  trimOut: number;
  speed: number;
  /** 0–1. */
  volume: number;
};

/**
 * One PIP clip (video or photo) drawn over the main video. Sizes and
 * positions are in pixels of the exported frame.
 */
export type PlanPipItem = {
  kind: "video" | "image";
  uri: string;
  /** Timeline seconds where it starts. */
  start: number;
  /** Source seconds (a photo uses trimOut - trimIn as its length). */
  trimIn: number;
  trimOut: number;
  speed: number;
  /** 0–1. */
  opacity: number;
  /** Centre of the picture in the frame (px). */
  cx: number;
  cy: number;
  /** Size of the picture (px), before turning. */
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation: number;
};

/**
 * A picture of every text / sticker shown during [start, end): a
 * transparent PNG the size of the exported frame.
 */
export type PlanOverlay = {
  start: number;
  end: number;
  uri: string;
};

export type ExportPlan = {
  /** file:// path of the .mp4 to write. */
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  /** Bits per second. */
  videoBitrate: number;
  /** "#RRGGBB" — gaps are drawn in it. */
  background: string;
  /** The whole video's crop (Crop tool), normalized 0–1; null = none. */
  crop: { x: number; y: number; w: number; h: number } | null;
  video: PlanVideoItem[];
  /** PIP clips, in timeline order (they never overlap). */
  pip: PlanPipItem[];
  /** Texts + stickers, one picture per stretch of time. */
  overlays: PlanOverlay[];
  audio: PlanAudioItem[];
  /** Length of the whole edit (seconds) — for logs / checks. */
  duration: number;
};

export type ExportResult = {
  uri: string;
  durationMs: number;
  sizeBytes: number;
};

type NativeEngine = {
  /** Missing in the first engine (v0.17 app builds). */
  version?: () => number;
  exportVideo(planJson: string): Promise<ExportResult>;
  cancelExport(): Promise<boolean>;
  addListener(
    event: "onProgress",
    listener: (e: { progress: number }) => void,
  ): { remove(): void };
};

const native = requireOptionalNativeModule<NativeEngine>("VidsurgeEngine");

/** The engine version this JS needs for texts, stickers, PIP, opacity, canvas colour. */
export const REQUIRED_ENGINE_VERSION = 2;

/** The native engine's version in this app build (0 = no engine). */
export function engineVersion(): number {
  if (!native) return 0;
  return typeof native.version === "function" ? native.version() : 1;
}

if (__DEV__) {
  if (native) {
    console.log(
      `[engine] native export engine ready — engine v${engineVersion()}${engineVersion() < REQUIRED_ENGINE_VERSION ? ` (OLD: this app build must be rebuilt for engine v${REQUIRED_ENGINE_VERSION})` : ""}`,
    );
  } else {
    // Diagnosis: which native Expo modules this app build does have.
    const all = Object.keys(
      (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo
        ?.modules ?? {},
    ).sort();
    console.log(
      `[engine] native export engine NOT in this app build — the build has ${all.length} Expo native modules: ${all.join(", ")}`,
    );
  }
}

export function isEngineAvailable(): boolean {
  return native != null;
}

/** Runs the export. Resolves with the written file; rejects on error/cancel. */
export async function exportVideo(plan: ExportPlan): Promise<ExportResult> {
  if (!native) {
    throw new Error("The export engine isn't in this app build yet.");
  }
  if (engineVersion() < REQUIRED_ENGINE_VERSION) {
    throw new Error(
      `This app build has an old export engine (v${engineVersion()}) that can't export texts, stickers or PIP. Install the new app build.`,
    );
  }
  if (__DEV__)
    console.log(
      `[engine] export ${plan.width}x${plan.height} @${plan.fps}fps, ${plan.video.length} video item(s), ${plan.pip.length} PIP, ${plan.overlays.length} text/sticker picture(s), ${plan.audio.length} audio clip(s), ${plan.duration.toFixed(2)}s`,
    );
  return native.exportVideo(JSON.stringify(plan));
}

export async function cancelExport(): Promise<void> {
  if (!native) return;
  await native.cancelExport();
}

/** Progress 0–1 while an export runs. Returns the unsubscribe function. */
export function onExportProgress(
  listener: (progress: number) => void,
): () => void {
  if (!native) return () => undefined;
  const sub = native.addListener("onProgress", (e) => listener(e.progress));
  return () => sub.remove();
}
