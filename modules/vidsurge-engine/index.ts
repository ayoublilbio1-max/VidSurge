// VidSurge engine — JavaScript side.
//
// The native part (android/…/vidsurgeengine/*.kt) only exists in an app
// build made after this module was added. Before that — and on iOS for now —
// `isEngineAvailable()` is false and exportVideo() rejects with a clear
// message instead of the app crashing on start.
//
// Engine v3 (app build 0.25+) also has the editor's native preview:
// NativePreviewView (the whole edit on one Media3 player) and NativePipView
// (where the PIP video is drawn). See VidsurgePreviewView.kt.

import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import type { ViewProps } from "react-native";

/** One piece of the main video track, in timeline order. */
export type PlanVideoItem =
  | { type: "gap"; duration: number }
  | {
      type: "clip";
      /** The clip's id (the preview changes its look live by id). */
      id?: string;
      uri: string;
      /** The whole file's length (seconds). */
      sourceDuration?: number;
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
  /** The clip's id (the preview changes its volume live by id). */
  id?: string;
  uri: string;
  /** The whole file's length (seconds). */
  sourceDuration?: number;
  start: number;
  trimIn: number;
  trimOut: number;
  speed: number;
  /** 0–2 (above 1 = louder than the file, up to 200%). */
  volume: number;
};

/**
 * One PIP clip (video or photo) drawn over the main video. Sizes and
 * positions are in pixels of the exported frame.
 */
export type PlanPipItem = {
  id?: string;
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
  /** PIP clips, in timeline order (engine v3 draws overlapping ones too). */
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
  /** Missing before the v0.25 app build. */
  thumbnails?: (
    uri: string,
    timesMs: number[],
    height: number,
  ) => Promise<{ uris: string[]; width: number; height: number }>;
  addListener(
    event: "onProgress",
    listener: (e: { progress: number }) => void,
  ): { remove(): void };
};

const native = requireOptionalNativeModule<NativeEngine>("VidsurgeEngine");

/**
 * Timeline thumbnails read by the engine: the EXACT frame at each time
 * (ms), `height` px tall, plus the video's picture size (upright).
 * null = this app build's engine can't (the caller uses its old way).
 */
export async function videoThumbnails(
  uri: string,
  timesMs: number[],
  height: number,
): Promise<{ uris: (string | null)[]; width: number; height: number } | null> {
  if (!native || typeof native.thumbnails !== "function") return null;
  const r = await native.thumbnails(uri, timesMs, Math.round(height));
  return {
    uris: r.uris.map((u) => (u ? u : null)),
    width: r.width,
    height: r.height,
  };
}

/**
 * The engine version this JS needs: v3 = native preview + export of
 * everything (texts, stickers, PIP, opacity, canvas colour) on one track.
 * (v2 had texts / stickers; its PIP / opacity / canvas colour failed.)
 */
export const REQUIRED_ENGINE_VERSION = 3;

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

// ---- Native preview (engine v3) ------------------------------------------------

/**
 * The timeline the preview plays: the export plan's shape without the
 * export-only parts (output file, bitrate, text pictures). PIP clips are
 * listed for the PIP view's sync (their place / size is the app's PIP frame).
 */
export type PreviewPlan = Omit<
  ExportPlan,
  "outputPath" | "videoBitrate" | "overlays"
>;

/** What the preview view can do (called through its ref). */
export type PreviewHandle = {
  /**
   * The edit to play (a PreviewPlan as JSON). Only live values changed
   * (turn, mirror, opacity, volume, canvas colour)? Applied right away;
   * otherwise the timeline is rebuilt at `positionMs`.
   */
  setTimeline(json: string, positionMs: number): Promise<void>;
  play(): Promise<void>;
  /** Pauses; resolves with where the picture stopped (ms). */
  pause(): Promise<number>;
  seekTo(ms: number): Promise<void>;
  /** On while the user drags the timeline (fast frequent seeks). */
  setScrubbing(on: boolean): Promise<void>;
  setMuted(on: boolean): Promise<void>;
  getPosition(): Promise<number>;
  /** A PNG (file uri) of the main picture as shown right now. */
  capture(): Promise<string>;
};

export type PipViewHandle = {
  /** A PNG (file uri) of the PIP picture as shown right now. */
  capture(): Promise<string>;
};

type NativeEvent<T> = { nativeEvent: T };

export type PreviewViewProps = ViewProps & {
  ref?: Ref<PreviewHandle>;
  /** Every ~50 ms while playing. */
  onTime?: (e: NativeEvent<{ time: number; playing: boolean }>) => void;
  /** Time really moving (playing) or waiting for the picture (loading). */
  onPlayback?: (
    e: NativeEvent<{ playing: boolean; waiting: boolean; time: number }>,
  ) => void;
  onEnded?: (e: NativeEvent<{ time: number }>) => void;
  onError?: (e: NativeEvent<{ message: string }>) => void;
};

export type PipViewProps = ViewProps & { ref?: Ref<PipViewHandle> };

/** Whether this app build has the native preview. */
export function hasNativePreview(): boolean {
  return engineVersion() >= 3;
}

let previewView: ComponentType<PreviewViewProps> | null | undefined;
let pipView: ComponentType<PipViewProps> | null | undefined;

/** The native preview view (null in an app build without engine v3). */
export function getNativePreviewView(): ComponentType<PreviewViewProps> | null {
  if (previewView === undefined) {
    previewView = hasNativePreview()
      ? requireNativeView<PreviewViewProps>(
          "VidsurgeEngine",
          "VidsurgePreviewView",
        )
      : null;
  }
  return previewView;
}

/** The native PIP view (null in an app build without engine v3). */
export function getNativePipView(): ComponentType<PipViewProps> | null {
  if (pipView === undefined) {
    pipView = hasNativePreview()
      ? requireNativeView<PipViewProps>("VidsurgeEngine", "VidsurgePipView")
      : null;
  }
  return pipView;
}

/**
 * What in this plan the app build's engine can't export (empty = it can).
 *   v1: main video + sound only.
 *   v2: + texts / stickers (its PIP, opacity and canvas colour failed).
 *   v3: everything.
 */
export function unsupportedByEngine(
  plan: ExportPlan,
  version: number = engineVersion(),
): string[] {
  if (version >= 3) return [];
  const out: string[] = [];
  if (version < 2 && plan.overlays.length > 0) out.push("texts / stickers");
  if (plan.pip.length > 0) out.push("PIP");
  if (plan.video.some((v) => v.type === "clip" && v.opacity < 0.999))
    out.push("lowered opacity");
  if (plan.background.replace("#", "").toLowerCase().slice(0, 6) !== "000000")
    out.push("a canvas colour");
  return out;
}

/** Runs the export. Resolves with the written file; rejects on error/cancel. */
export async function exportVideo(plan: ExportPlan): Promise<ExportResult> {
  if (!native) {
    throw new Error("The export engine isn't in this app build yet.");
  }
  // An older engine would export a plan with more than it knows wrong (or
  // fail): it's refused with a clear message; what it can do is exported.
  const missing = unsupportedByEngine(plan);
  if (missing.length > 0) {
    throw new Error(
      `This app build's export engine (v${engineVersion()}) can't export ${missing.join(", ")}. The next app build fixes it — until then, remove them to export.`,
    );
  }
  if (__DEV__ && engineVersion() < REQUIRED_ENGINE_VERSION)
    console.log(
      `[engine] old engine v${engineVersion()} — this plan only uses what it can export`,
    );
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
