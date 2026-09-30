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
  exportVideo(planJson: string): Promise<ExportResult>;
  cancelExport(): Promise<boolean>;
  addListener(
    event: "onProgress",
    listener: (e: { progress: number }) => void,
  ): { remove(): void };
};

const native = requireOptionalNativeModule<NativeEngine>("VidsurgeEngine");

if (__DEV__) {
  if (native) {
    console.log("[engine] native export engine ready");
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
  if (__DEV__)
    console.log(
      `[engine] export ${plan.width}x${plan.height} @${plan.fps}fps, ${plan.video.length} video item(s), ${plan.audio.length} audio clip(s), ${plan.duration.toFixed(2)}s`,
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
