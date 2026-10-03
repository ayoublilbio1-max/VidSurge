import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import * as VideoThumbnails from "expo-video-thumbnails";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Image,
  Keyboard,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  engineVersion,
  getNativePipView,
  getNativePreviewView,
  isEngineAvailable,
  REQUIRED_ENGINE_VERSION,
  unsupportedByEngine,
  videoThumbnails,
  type ExportPlan,
  type PipViewHandle,
  type PreviewHandle,
} from "../../modules/vidsurge-engine";
import AppText from "../components/AppText";
import ComingSoonModal from "../components/ComingSoonModal";
import EditorScreenSkeleton from "../components/EditorScreenSkeleton";
import CanvasSheet from "../components/editor/CanvasSheet";
import ClipSettingsSheet, {
  type ClipSettingKind,
} from "../components/editor/ClipSettingsSheet";
import CropOverlay from "../components/editor/CropOverlay";
import CropSheet, { type CropPreset } from "../components/editor/CropSheet";
import DemoFeatureModal from "../components/editor/DemoFeatureModal";
import EditorTimeline from "../components/editor/EditorTimeline";
import EditorToolbar, {
  type LockMode,
  type SelectionKind,
} from "../components/editor/EditorToolbar";
import EditorTopBar, {
  type SaveState,
} from "../components/editor/EditorTopBar";
import ExportModal from "../components/editor/ExportModal";
import ExportSettingsSheet from "../components/editor/ExportSettingsSheet";
import LibPickerSheet from "../components/editor/LibPickerSheet";
import MultiSelectBar from "../components/editor/MultiSelectBar";
import OverlayRenderer, {
  type OverlayJob,
  type OverlayResult,
} from "../components/editor/OverlayRenderer";
import RotateSheet from "../components/editor/RotateSheet";
import StickerSheet from "../components/editor/StickerSheet";
import TextEditorSheet, {
  MIN_PANEL_HEIGHT,
} from "../components/editor/TextEditorSheet";
import TextOverlay, {
  type FrameRect,
  type OverlayItem,
  type TextTransform,
} from "../components/editor/TextOverlay";
import { useSyncedValue } from "../components/editor/TimelineClipBox";
import {
  activeClipAt,
  canSplitAt,
  canvasAspect,
  canvasOf,
  clipContains,
  clipEnd,
  clipLength,
  DEFAULT_STICKER_DATA,
  DEFAULT_TEXT_DATA,
  describeCanvas,
  describeClip,
  describeExport,
  EMPTY_PROJECT,
  exportOf,
  findClip,
  findLinkedPartner,
  frameAspect,
  FULL_CROP,
  pipDataOf,
  pipSize,
  projectEnd,
  resolutionLabel,
  stickerDataOf,
  textDataOf,
  timelineToSource,
  type CanvasSettings,
  type Clip,
  type ClipRange,
  type CropRect,
  type ExportResolution,
  type ExportSettings,
  type Project,
  type TextClipData,
} from "../editor/clipModel";
import {
  buildExportPlan,
  buildPreviewPlan,
  overlaySegments,
} from "../editor/exportPlan";
import { preloadAllFonts, useFontsVersion } from "../editor/fonts";
import { createHistory, historyReducer } from "../editor/history";
import { probeDuration } from "../editor/mediaProbe";
import {
  addAudioClipAction,
  addPipClipAction,
  addStickerClipAction,
  addTextClipAction,
  duplicateClipAction,
  duplicateClipsAction,
  freeAudioRoom,
  initSourceAction,
  insertVideoAtEndAction,
  insertVideoAtStartAction,
  projectReducer,
  splitClipAction,
  type ProjectAction,
} from "../editor/projectReducer";
import { useNativeClock } from "../hooks/useNativeClock";
import { useTheme } from "../hooks/useTheme";
import { runEngineDiagnostics } from "../lib/engineDiagnostics";
import { loadLibrary, type LibItem, type LibKind } from "../lib/libraryStorage";
import { hasContent, loadProject, saveProject } from "../lib/projectsStorage";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;
// Thumbnail height in pixels (the timeline's video row is 56 dp tall).
const THUMBNAIL_HEIGHT_PX = Math.min(200, Math.round(56 * PixelRatio.get()));

type ThumbSet = { uris: (string | null)[]; width: number; height: number };

function thumbTimesMs(lengthSec: number): number[] {
  return Array.from({ length: THUMBNAIL_COUNT }, (_, i) =>
    Math.floor((((i + 0.5) * lengthSec) / THUMBNAIL_COUNT) * 1000),
  );
}

/**
 * The video's picture size (upright), right away: the engine reads ONE
 * frame at 0 s (a keyframe — fast). null = not available (old app build).
 */
async function quickVideoSize(
  uri: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const r = await videoThumbnails(uri, [0], THUMBNAIL_HEIGHT_PX);
    if (r && r.width > 0 && r.height > 0)
      return { width: r.width, height: r.height };
  } catch {
    // the thumbnails below give it too
  }
  return null;
}

/**
 * Fast filmstrip (expo-video-thumbnails: nearest keyframe of each of the
 * 20 pieces). Shown first.
 */
async function quickThumbnails(
  uri: string,
  lengthSec: number,
): Promise<ThumbSet> {
  const timesMs = thumbTimesMs(lengthSec);
  const results: (string | null)[] = new Array(THUMBNAIL_COUNT).fill(null);
  let width = 0;
  let height = 0;
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= THUMBNAIL_COUNT) return;
      try {
        const shot = await VideoThumbnails.getThumbnailAsync(uri, {
          time: timesMs[i],
        });
        results[i] = shot.uri;
        if (i === 0) {
          width = shot.width;
          height = shot.height;
        }
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: THUMBNAIL_CONCURRENCY }, () => worker()),
  );
  return { uris: results, width, height };
}

/**
 * The EXACT frames (read by the engine; slower — each one is decoded from
 * the keyframe before it). Swapped in after the fast filmstrip.
 * null = not available (old app build) or failed.
 */
async function exactThumbnails(
  uri: string,
  lengthSec: number,
): Promise<(string | null)[] | null> {
  try {
    const r = await videoThumbnails(
      uri,
      thumbTimesMs(lengthSec),
      THUMBNAIL_HEIGHT_PX,
    );
    if (r && r.uris.some(Boolean)) return r.uris;
  } catch (e) {
    if (__DEV__)
      console.log(
        "[editor] exact thumbnails failed — keeping the fast ones",
        e,
      );
  }
  return null;
}

/** A Lib item in the shape of a picked gallery file (uri, ms length, size). */
function libAsset(item: LibItem) {
  return {
    uri: item.uri,
    type: item.kind === "image" ? ("image" as const) : ("video" as const),
    duration: item.kind === "image" ? null : item.duration * 1000,
    width: item.width,
    height: item.height,
    fileName: item.name,
  };
}

/** The exact frames where they exist, the fast ones elsewhere. */
function mergeThumbs(
  fast: (string | null)[],
  exact: (string | null)[],
): (string | null)[] {
  return fast.map((f, i) => exact[i] ?? f);
}

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function summarizeProject(project: Project): string {
  const lines = (["video", "audio", "pip", "text", "sticker"] as const).map(
    (track) => {
      const clips = project.tracks[track];
      return `  ${track}: ${clips.length === 0 ? "(empty)" : clips.map(describeClip).join(" | ")}`;
    },
  );
  return `end ${projectEnd(project).toFixed(2)}s, canvas ${describeCanvas(canvasOf(project))}, export ${describeExport(exportOf(project))}\n${lines.join("\n")}`;
}

// Export resolutions not in the demo build (lock + "not in the demo").
const DEMO_LOCKED_RESOLUTIONS: ExportResolution[] = [1440, 2160];

/** The project's export settings, with a locked resolution (a project
 *  saved before the lock) brought down to 1080P. */
function demoExportOf(project: Project): ExportSettings {
  const e = exportOf(project);
  return DEMO_LOCKED_RESOLUTIONS.includes(e.resolution)
    ? { ...e, resolution: 1080 }
    : e;
}

// Tools that are not part of the demo build: tapping one explains that and
// points to the developer (DemoFeatureModal). Key → name shown.
const DEMO_ONLY_TOOLS: Record<string, string> = {
  voiceRecord: "Voice record",
  effects: "Effects",
  filter: "Filter",
  reverse: "Reverse",
  blur: "Blur",
  blurArea: "Blur area",
};

/** Absolute position style for a rect inside the preview box. */
function frameStyle(r: FrameRect) {
  return {
    position: "absolute" as const,
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  };
}

/** The largest rect of `aspect` (w ÷ h) centred inside `box`. */
function containRect(box: FrameRect, aspect: number): FrameRect {
  if (aspect > box.width / box.height) {
    const h = box.width / aspect;
    return {
      left: box.left,
      top: box.top + (box.height - h) / 2,
      width: box.width,
      height: h,
    };
  }
  const w = box.height * aspect;
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top,
    width: w,
    height: box.height,
  };
}

// How long the mute button shows its spinner before the mute applies.
const MUTE_SPINNER_MS = 250;

// Fullscreen preview: height of the play / capture / exit bar pinned to the
// bottom (the navigation bar's height is added to it).
const FULLSCREEN_BAR = 72;

// react-native-view-shot (capture), loaded defensively: in an app build
// without it, capture falls back to the video file's frame.
type ViewShotModule = typeof import("react-native-view-shot");
let viewShot: ViewShotModule | null = null;
try {
  viewShot = require("react-native-view-shot") as unknown as ViewShotModule;
} catch {
  viewShot = null;
}

export default function EditorScreen() {
  const colors = useTheme();
  // `projectId`: a saved project is being opened (Recent projects). Then
  // `videoUri` is its first video (the copy in the project folder).
  const { videoUri, projectId } = useLocalSearchParams<{
    videoUri: string;
    projectId: string;
  }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  // Tools left out of the demo build (DEMO_ONLY_TOOLS): their name while the
  // "not in the demo" modal is open.
  const [demoFeature, setDemoFeature] = useState<string | null>(null);
  // The phone's file picker is open / the picked file is being read.
  const addingAudioRef = useRef(false);
  // A picked song is being read (spinner on "Add audio" + the Music tool).
  const [addingAudio, setAddingAudio] = useState(false);
  // "It worked" flash on the clips an edit just made or changed.
  const [flash, setFlash] = useState<{ ids: string[]; token: number }>({
    ids: [],
    token: 0,
  });
  const flashClips = (ids: string[]) =>
    setFlash((f) => ({ ids, token: f.token + 1 }));
  const [isPlaying, setIsPlaying] = useState(false);
  // True while the user is dragging/flinging the timeline (the preview is
  // in scrubbing mode meanwhile).
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [thumbnailsReady, setThumbnailsReady] = useState(false);
  // The source video's picture size (from the first thumbnail), to know
  // where the picture sits inside the preview box (texts are placed on it).
  const [videoSize, setVideoSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // The preview box's size on screen.
  const [previewSize, setPreviewSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const thumbnailsGeneratedRef = useRef(false);

  // The whole edit: a list of clips per track (see src/editor/clipModel.ts).
  // Every change goes through projectReducer as one action.
  // The project, with undo/redo history around it (src/editor/history.ts).
  const [history, dispatchHistory] = useReducer(
    historyReducer,
    EMPTY_PROJECT,
    createHistory,
  );
  // The latest history, also between a dispatch and the re-render it
  // causes: two quick taps (redo, redo) both ran on the same stale
  // `history`, so the second one logged the wrong step and checked the
  // playhead against the wrong version. Handlers read and advance this.
  const historyRef = useRef(history);
  // Synced after each commit (not during render — the React Compiler
  // doesn't allow writing refs while rendering).
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  const project = history.present;

  // ---- Saving (Recent projects) ------------------------------------------
  // The saved project's id (null until the first save of a new project),
  // and the version last saved / opened — nothing is written again while
  // the edit is unchanged.
  const projectIdRef = useRef<string | null>(projectId ?? null);
  // Its name (for the Exports screen): from the saved project.
  const projectNameRef = useRef<string | null>(null);
  const lastSavedRef = useRef<Project | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Capture in progress: the preview is briefly laid out for the picture
  // (see handleCapture).
  const [shotMode, setShotMode] = useState(false);
  const captureFrameRef = useRef<any>(null);
  // Capture, step 2: the native pictures (main video, PIP video) replaced
  // for a moment by a still of themselves (see handleCapture).
  const [frozen, setFrozen] = useState<{
    main?: string;
    pip?: string;
  } | null>(null);
  // Resolves when the still pictures have loaded.
  const frozenLoadRef = useRef<{ left: number; done: (() => void) | null }>({
    left: 0,
    done: null,
  });
  const onFrozenLoad = () => {
    const f = frozenLoadRef.current;
    f.left -= 1;
    if (f.left <= 0 && f.done) {
      const done = f.done;
      f.done = null;
      done();
    }
  };

  // Open a saved project: it replaces the (still empty) edit, with a fresh
  // undo history.
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    (async () => {
      const saved = await loadProject(projectId);
      if (!alive) return;
      if (!saved) {
        if (__DEV__)
          console.log(`[editor] project ${projectId} could not be opened`);
        Alert.alert("Can't open project", "This project could not be read.");
        router.back();
        return;
      }
      lastSavedRef.current = saved.project;
      historyRef.current = createHistory(saved.project);
      dispatchHistory({ type: "RESET", project: saved.project });
      projectNameRef.current = saved.name;
      if (__DEV__)
        console.log(`[editor] opened project "${saved.name}" (${projectId})`);
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Saves the edit if it changed since the last save. Safe to call any
  // time: an empty edit (nothing loaded yet) is never saved.
  const saveNow = async (why: string): Promise<boolean> => {
    const current = historyRef.current.present;
    if (!hasContent(current)) return false;
    if (current === lastSavedRef.current) {
      if (__DEV__) console.log(`[editor] save (${why}) — nothing changed`);
      return true;
    }
    try {
      const item = await saveProject({
        id: projectIdRef.current,
        videoUri: videoUri ?? "",
        project: current,
      });
      projectIdRef.current = item.id;
      projectNameRef.current = item.name;
      lastSavedRef.current = current;
      if (__DEV__) console.log(`[editor] saved (${why})`);
      return true;
    } catch (e) {
      if (__DEV__) console.log(`[editor] save (${why}) failed`, e);
      return false;
    }
  };
  // The latest saveNow, for the listeners below (they're set up once).
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  });

  // Autosave: when the app goes to the background (a crash or the phone
  // closing the app later can't lose the edit), and when leaving the editor
  // (back arrow, Android back, swipe — the screen unmounts).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: string) => {
      if (state === "background") void saveNowRef.current("app in background");
    });
    return () => {
      sub.remove();
      void saveNowRef.current("left the editor");
    };
  }, []);

  // Save button: spinner first (drawn right away), then the save, then
  // "Saved" for a moment.
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );
  const handleSavePress = () => {
    if (saveState === "saving") return;
    if (__DEV__) console.log("[editor] Save pressed");
    setSaveState("saving");
    setTimeout(async () => {
      const ok = await saveNow("Save button");
      setSaveState(ok ? "saved" : "idle");
      if (!ok) Alert.alert("Not saved", "The project could not be saved.");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveState("idle"), 1600);
    }, 30);
  };

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  // The selected clip's id (null = nothing selected).
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // Lock is NOT editor state: it lives in the clips (a shared linkId =
  // locked). See `lockMode` below.

  // Runs an action: computes the result first (the reducer is pure, so this
  // is the same result dispatch will produce), logs it, dispatches it, and
  // returns the new project so callers can react to it in the same tick.
  const commitProject = (action: ProjectAction, reason: string): Project => {
    const current = historyRef.current;
    const next = projectReducer(current.present, action);
    if (__DEV__) {
      console.log(
        next === current.present
          ? `[project] ${action.type} (${reason}) — no change`
          : `[project] ${action.type} (${reason})`,
      );
    }
    if (next !== current.present) {
      const historyAction = { type: "APPLY", action, label: reason } as const;
      historyRef.current = historyReducer(current, historyAction);
      dispatchHistory(historyAction);
    }
    return next;
  };

  // Full model dump whenever it changes.
  useEffect(() => {
    if (__DEV__) console.log(`[project] now: ${summarizeProject(project)}`);
  }, [project]);

  // ---- Native preview (engine v3) ------------------------------------
  // The whole edit plays on ONE native player with its own clock (see
  // modules/vidsurge-engine, VidsurgePreviewView.kt): main video (cuts,
  // speed, crop, turn, mirror, opacity, canvas colour) and all the sound.
  // The PIP video plays in its own native view (inside the PIP frame below)
  // kept in step natively. JavaScript only sends the edit and play / pause /
  // seek — it is not involved while the video plays.
  const NativePreview = getNativePreviewView();
  const NativePip = getNativePipView();
  const previewRef = useRef<PreviewHandle | null>(null);
  const pipViewRef = useRef<PipViewHandle | null>(null);
  // The native view is on screen (its ref is set): the edit can be sent.
  const [previewMounted, setPreviewMounted] = useState(false);
  // Stable (a new function each render would make React detach / attach
  // the ref on every render).
  const setPreviewRef = useCallback((handle: PreviewHandle | null) => {
    previewRef.current = handle;
    setPreviewMounted(handle !== null);
  }, []);
  useEffect(() => {
    if (__DEV__)
      console.log(
        NativePreview
          ? "[editor] native preview (engine v3)"
          : `[editor] this app build has no native preview (engine v${engineVersion()}) — rebuild the app`,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The first video's length, read from the file (new project: its first
  // clip; any project: its thumbnails on the timeline).
  useEffect(() => {
    if (!videoUri) return;
    let alive = true;
    void probeDuration(videoUri).then((d) => {
      if (alive && d > 0) setDuration(d);
    });
    return () => {
      alive = false;
    };
  }, [videoUri]);

  // First load: one linked video + audio clip covering the whole file.
  // (The reducer ignores this if the project already has clips.)
  useEffect(() => {
    // A saved project brings its own clips (see the load above).
    if (duration > 0 && videoUri && !projectId) {
      commitProject(initSourceAction(videoUri, duration), "source loaded");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, videoUri, projectId]);

  useEffect(() => {
    if (!videoUri || duration <= 0 || thumbnailsGeneratedRef.current) return;
    thumbnailsGeneratedRef.current = true;

    const generate = async () => {
      const startedAt = Date.now();
      const name = videoUri.split("/").pop();
      // 1. The picture's shape, right away (the frame / preview need it).
      let sizeKnown = false;
      const size = await quickVideoSize(videoUri);
      if (size) {
        sizeKnown = true;
        setVideoSize(size);
        if (__DEV__)
          console.log(
            `[editor] video picture size ${size.width}x${size.height} (in ${Date.now() - startedAt}ms)`,
          );
      }
      // 2. The fast filmstrip.
      const fast = await quickThumbnails(videoUri, duration);
      if (!sizeKnown && fast.width > 0 && fast.height > 0) {
        setVideoSize({ width: fast.width, height: fast.height });
        if (__DEV__)
          console.log(
            `[editor] video picture size ${fast.width}x${fast.height}`,
          );
      }
      setThumbnails(fast.uris);
      setThumbnailsReady(true);
      if (__DEV__)
        console.log(
          `[editor] thumbnails for ${name} — ${fast.uris.filter(Boolean).length}/${THUMBNAIL_COUNT} fast in ${Date.now() - startedAt}ms`,
        );
      // 3. The exact frames, swapped in when ready.
      const exact = await exactThumbnails(videoUri, duration);
      if (exact) {
        setThumbnails(mergeThumbs(fast.uris, exact));
        if (__DEV__)
          console.log(
            `[editor] thumbnails for ${name} — exact frames in after ${Date.now() - startedAt}ms`,
          );
      }
    };

    generate();
  }, [videoUri, duration]);

  // Thumbnails of the other video files (added with the timeline's "+"),
  // by file — the original video's are `thumbnails` above.
  const [thumbnailsBySource, setThumbnailsBySource] = useState<
    Record<string, (string | null)[]>
  >({});
  const thumbsStartedRef = useRef(new Set<string>());
  const otherVideoSources = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of project.tracks.video) {
      if (c.sourceUri && c.sourceUri !== videoUri && !seen.has(c.sourceUri)) {
        seen.set(c.sourceUri, c.sourceDuration);
      }
    }
    return [...seen.entries()];
  }, [project.tracks.video, videoUri]);
  useEffect(() => {
    for (const [uri, length] of otherVideoSources) {
      if (thumbsStartedRef.current.has(uri) || !(length > 0)) continue;
      thumbsStartedRef.current.add(uri);
      void (async () => {
        const startedAt = Date.now();
        const results = (await quickThumbnails(uri, length)).uris;
        if (__DEV__)
          console.log(
            `[editor] thumbnails for ${uri.split("/").pop()} — ${results.filter(Boolean).length}/${THUMBNAIL_COUNT} in ${Date.now() - startedAt}ms`,
          );
        setThumbnailsBySource((m) => ({ ...m, [uri]: results }));
        // The exact frames, swapped in when ready.
        const exact = await exactThumbnails(uri, length);
        if (exact) {
          setThumbnailsBySource((m) => ({
            ...m,
            [uri]: mergeThumbs(results, exact),
          }));
          if (__DEV__)
            console.log(
              `[editor] thumbnails for ${uri.split("/").pop()} — exact frames in after ${Date.now() - startedAt}ms`,
            );
        }
      })();
    }
  }, [otherVideoSources]);

  // ---- Clips on each track -------------------------------------------
  const videoClips = project.tracks.video;
  const audioClips = project.tracks.audio;
  const textClips = project.tracks.text;
  const stickerClips = project.tracks.sticker;
  const pipClips = project.tracks.pip;

  // The timeline ends where the last clip ends (after trimming everything
  // shorter, playback stops there instead of running on through black to
  // the original video's length).
  const timelineDuration = projectEnd(project);

  const selectedClip = selectedClipId
    ? findClip(project, selectedClipId)
    : null;
  const selectedPartner = selectedClip
    ? findLinkedPartner(project, selectedClip)
    : null;

  // Lock button (clip tools only): usable when the selected clip is locked
  // to a partner (tap = unlock, one-way); greyed out if already unlocked.
  const lockMode: LockMode = !selectedClip
    ? "none"
    : selectedPartner
      ? "locked"
      : "unlocked";

  // Which clip tools the toolbar shows: a locked pair gets all of them
  // (each applies to the part it belongs to), an unlocked clip only its
  // own kind's (video: picture tools, no Volume; audio: Volume, no
  // picture tools).
  const selectionKind: SelectionKind = !selectedClip
    ? "none"
    : selectedClip.track === "text"
      ? "text"
      : selectedClip.track === "sticker"
        ? "sticker"
        : selectedClip.track === "pip"
          ? "pip"
          : selectedPartner
            ? "locked"
            : selectedClip.track === "audio"
              ? "audio"
              : "video";

  // Timeline mute button: silences the whole audio track (both audio
  // players) without touching any clip's volume. Not an undo step.
  // The button shows a spinner first (same idea as Split/Delete): the
  // spinner is drawn right away, then the mute is applied — the editor's
  // re-render takes a moment in the dev build, so the tap never looks
  // ignored.
  const [audioMuted, setAudioMuted] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const toggleAudioMuted = () => {
    if (muteBusy) return;
    setMuteBusy(true);
    if (__DEV__) console.log("[editor] mute pressed — spinner");
    setTimeout(() => {
      setAudioMuted((m) => {
        if (__DEV__)
          console.log(`[editor] audio track ${m ? "unmuted" : "muted"}`);
        return !m;
      });
      setMuteBusy(false);
    }, MUTE_SPINNER_MS);
  };

  // ---- Clock (the native player's time) -----------------------------------
  // Every clip edge on every track: crossing one while playing updates the
  // screen right away (texts, stickers, PIP frame, tools).
  const clipEdges = useMemo(() => {
    const out: number[] = [];
    for (const track of ["video", "audio", "text", "sticker", "pip"] as const) {
      for (const c of project.tracks[track]) out.push(c.start, clipEnd(c));
    }
    return out;
  }, [project.tracks]);

  const {
    timelineTime,
    seekTo,
    playhead,
    stopTimeRef,
    halt,
    getTime,
    onTimeEvent,
    onPlaybackEvent,
    onEndedEvent,
  } = useNativeClock({
    previewRef,
    isPlaying,
    timelineDuration,
    edges: clipEdges,
    onReachEnd: () => {
      if (__DEV__)
        console.log("[editor] timeline reached end, stopping playback");
      setIsPlaying(false);
    },
  });

  // The native preview couldn't play something: stop, say so.
  const handlePreviewError = (message: string) => {
    if (__DEV__) console.log(`[editor] preview error — ${message}`);
    setIsPlaying(false);
    showToast("The preview couldn't play this part");
  };

  // The mute button silences the preview right away (no reload).
  useEffect(() => {
    if (previewMounted) void previewRef.current?.setMuted(audioMuted);
  }, [audioMuted, previewMounted]);

  // ---- PIP layer ---------------------------------------------------------
  // The PIP clip under the playhead — or else the next one, or else the
  // last one. The PIP layer (and its native video view) stays mounted as
  // long as the project has a PIP; the native preview plays the right clip
  // into it, in step. Shown / hidden on the UI thread from the drawn
  // playhead (React comes a moment late).
  const pipShown =
    activeClipAt(pipClips, timelineTime) ??
    pipClips.find((c) => c.start > timelineTime) ??
    pipClips[pipClips.length - 1] ??
    null;
  const pipStartSV = useSyncedValue(pipShown?.start ?? -1);
  const pipEndSV = useSyncedValue(pipShown ? clipEnd(pipShown) : -1);
  // Its Opacity (live draft while the Opacity sheet is open) — set near the
  // clip settings ("The PIP layer's opacity").
  const pipOpacitySV = useSharedValue(1);
  const pausedTimeSV = useSyncedValue(timelineTime);
  const pipVisibleStyle = useAnimatedStyle(() => {
    const t = playhead.playingSV.value
      ? playhead.uiTimeSV.value
      : pausedTimeSV.value;
    const on = t >= pipStartSV.value - 0.001 && t < pipEndSV.value;
    return { opacity: on ? pipOpacitySV.value : 0 };
  });

  // Split is usable when the playhead is inside the selected clip (and its
  // locked partner), at least MIN_SPLIT_PART from either edge.
  const splitEnabled =
    selectedClip !== null &&
    canSplitAt(selectedClip, timelineTime) &&
    (selectedPartner === null || canSplitAt(selectedPartner, timelineTime));

  // Delete is usable on any selected clip, unless it (with its locked
  // partner) is everything left in the project: an empty project has no way
  // to add media back yet (that comes with an "add clip" tool).
  // (Texts can always be deleted.)
  const clipCount = project.tracks.video.length + project.tracks.audio.length;
  const deleteEnabled =
    selectedClip !== null &&
    (selectedClip.track === "text" ||
      selectedClip.track === "sticker" ||
      selectedClip.track === "pip" ||
      clipCount - (selectedPartner ? 2 : 1) > 0);

  // ---- Transport handlers (thin — the clock reacts to the state changes
  // these make and drives the native preview) ------------------------------
  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    if (timelineTime >= timelineDuration - 0.001) {
      seekTo(0);
    }

    // Safety net: if a scrub-end was somehow missed, never stay in
    // scrubbing mode once playback starts (it holds the picture).
    if (isScrubbing) {
      if (__DEV__)
        console.log("[editor] play pressed while scrub flag set — clearing it");
      setIsScrubbing(false);
      void previewRef.current?.setScrubbing(false);
    }

    // Play = watching, not editing: drop the clip selection (the toolbar
    // goes back to the project tools, trim handles disappear).
    if (selectedClip) {
      if (__DEV__)
        console.log(
          `[editor] play pressed — deselecting ${selectedClip.track} (${selectedClip.id})`,
        );
      setSelectedClipId(null);
    }

    setIsPlaying(true);
  };

  const handleScrub = (time: number) => {
    const clamped = clampJS(time, 0, timelineDuration);
    seekTo(clamped);
  };

  // Any editing action (scrubbing, moving a clip, dragging a trim handle,
  // tapping zoom +/-, pinch-zooming, tapping a clip, toggling the audio
  // lock) pauses playback first, InShot-style. Playback stays paused
  // afterwards — the user presses play to continue. Without this, the play
  // clock and the gesture both tried to own the playhead/players at the
  // same time.
  const pauseForGesture = (reason: string) => {
    if (isPlaying) {
      if (__DEV__)
        console.log(`[editor] ${reason} started while playing — pausing`);
      // Freeze the playhead immediately (see the clock's `halt`), then let
      // React catch up with the paused state.
      halt();
      setIsPlaying(false);
    }
  };

  const handleScrubStart = () => {
    pauseForGesture("scrub");
    if (__DEV__)
      console.log("[editor] scrub start — preview in scrubbing mode");
    setIsScrubbing(true);
    // Fast frequent seeks (Media3's scrubbing mode) while the finger moves.
    void previewRef.current?.setScrubbing(true);
  };

  const handleScrubEnd = () => {
    if (__DEV__) console.log("[editor] scrub end — preview back to normal");
    setIsScrubbing(false);
    void previewRef.current?.setScrubbing(false);
  };

  const handleClipGestureStart = (kind: "move" | "trim") =>
    pauseForGesture(`clip ${kind}`);

  const handleZoomButtonPress = (direction: "in" | "out") =>
    pauseForGesture(`zoom ${direction}`);

  const handlePinchZoomStart = () => pauseForGesture("pinch zoom");

  // Tapping a clip: selects it, or deselects if it's already selected.
  // A locked pair acts as one, so tapping EITHER clip of a selected pair
  // deselects both. Otherwise tapping another clip switches the selection
  // to it. Either way, a tap on a clip means "I'm editing now", so playback
  // pauses first.
  // ---- Multi-select (the timeline's ☑ button) ---------------------------
  // Taps pick / unpick clips; dragging a picked clip moves them all
  // (MOVE_CLIPS); the bar under the preview has Duplicate / Delete / Done.
  const [multiSelect, setMultiSelect] = useState(false);
  const [multiIds, setMultiIds] = useState<string[]>([]);
  // Picks that no longer exist (undo, delete) are dropped.
  const liveMultiIds = multiIds.filter((id) => findClip(project, id) !== null);
  const toggleMultiSelect = () => {
    pauseForGesture("multi-select");
    if (multiSelect) {
      if (__DEV__) console.log("[editor] multi-select off");
      setMultiSelect(false);
      setMultiIds([]);
      return;
    }
    // The clip selected right now becomes the first pick.
    const first = selectedClipId ? [selectedClipId] : [];
    if (__DEV__)
      console.log(
        `[editor] multi-select on${first.length ? ` (starting with ${first[0]})` : ""}`,
      );
    setSelectedClipId(null);
    setMultiIds(first);
    setMultiSelect(true);
  };
  const toggleMultiPick = (clipId: string) => {
    const clip = findClip(project, clipId);
    if (!clip) return;
    const partner = findLinkedPartner(project, clip);
    const picked =
      multiIds.includes(clip.id) ||
      (partner !== null && multiIds.includes(partner.id));
    const next = picked
      ? multiIds.filter((id) => id !== clip.id && id !== partner?.id)
      : [...multiIds, clip.id];
    if (__DEV__)
      console.log(
        `[editor] multi-select ${picked ? "unpick" : "pick"} ${clip.track} ${clip.id}${partner ? ` (+ locked ${partner.id})` : ""} — ${next.length} picked`,
      );
    setMultiIds(next);
  };
  const handleMoveClips = (ids: string[], delta: number): boolean => {
    const next = commitProject(
      { type: "MOVE_CLIPS", clipIds: ids, delta },
      `move ${ids.length} clips`,
    );
    return next !== project;
  };
  const handleDeletePicked = () => {
    if (liveMultiIds.length === 0) return;
    pauseForGesture("delete picked");
    commitProject(
      { type: "DELETE_CLIPS", clipIds: liveMultiIds },
      `delete ${liveMultiIds.length} clips`,
    );
    setMultiIds([]);
    const end = projectEnd(historyRef.current.present);
    if (timelineTime > end) seekTo(end);
  };
  const handleDuplicatePicked = () => {
    if (liveMultiIds.length === 0) return;
    pauseForGesture("duplicate picked");
    const action = duplicateClipsAction(project, liveMultiIds);
    commitProject(action, `duplicate ${liveMultiIds.length} clips`);
    if (action.type === "DUPLICATE_CLIPS")
      flashClips(action.copies.map((c) => c.id));
  };

  const handleSelectClip = (clipId: string) => {
    const target = findClip(project, clipId);
    pauseForGesture(`${target?.track ?? "clip"} clip tap`);
    if (!target) return;
    if (multiSelect) {
      toggleMultiPick(target.id);
      return;
    }
    const alreadySelected =
      selectedClipId === target.id || selectedPartner?.id === target.id;
    if (alreadySelected) {
      if (__DEV__)
        console.log(`[editor] ${target.track} tapped again — deselecting`);
      setSelectedClipId(null);
      return;
    }
    if (__DEV__) console.log(`[editor] select ${target.track} (${target.id})`);
    setSelectedClipId(target.id);
  };

  // Tap on empty space (empty timeline area, video preview, background).
  // Buttons (toolbar, play, zoom...) are touchables of their own, so they
  // take the tap first and never reach this — the selection survives them,
  // which tools like Split/Delete will need.
  // A tap on a text on the preview also reaches the preview's own
  // "tap background = deselect" — ignore that one.
  const lastTextTapAtRef = useRef(0);
  const clearSelection = (reason: string) => {
    if (selectedClip === null) return;
    if (Date.now() - lastTextTapAtRef.current < 700) return;
    if (__DEV__)
      console.log(
        `[editor] ${reason} tapped — deselecting ${selectedClip.track} (${selectedClip.id})`,
      );
    setSelectedClipId(null);
  };

  // Unlock the selected clip from its partner — one-way, there is no
  // re-lock. The toolbar only enables the button when this can apply, but
  // it's checked again here. Also an editing action, so it pauses first.
  // The selected clip stays selected; its partner just stops being
  // highlighted with it.
  const handleUnlock = () => {
    if (!selectedClip || !selectedPartner) {
      if (__DEV__)
        console.log("[editor] lock button pressed — nothing to unlock");
      return;
    }
    pauseForGesture("unlock");
    if (__DEV__)
      console.log(
        `[editor] unlock ${selectedClip.id} from ${selectedPartner.id}`,
      );
    commitProject(
      { type: "UNLINK_CLIP", clipId: selectedClip.id },
      `unlock ${selectedClip.track}`,
    );
    // Both clips flash: they're now separate.
    flashClips([selectedClip.id, selectedPartner.id]);
  };

  // Split the selected clip at the playhead. Locked: its partner is cut at
  // the same moment (the reducer does both). Unlocked: only this clip. The
  // left half keeps the original id, so it stays selected.
  const handleSplit = () => {
    if (!selectedClip) return;
    // While playing, cut where the playhead is DRAWN (the throttled React
    // time can be ~0.2s behind), then pause there.
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    if (isPlaying) {
      pauseForGesture("split");
      seekTo(at);
    }
    if (!canSplitAt(selectedClip, at)) {
      if (__DEV__)
        console.log(
          `[editor] split @ ${at.toFixed(2)}s — playhead not inside ${selectedClip.id} (or too close to an edge)`,
        );
      return;
    }
    if (__DEV__)
      console.log(
        `[editor] split ${selectedClip.id}${selectedPartner ? ` + locked ${selectedPartner.id}` : " (unlocked, alone)"} @ ${at.toFixed(2)}s`,
      );
    const action = splitClipAction(selectedClip.id, at);
    const next = commitProject(
      action,
      `split ${selectedClip.track}${selectedPartner ? ", locked" : ""}`,
    );
    if (next !== project && action.type === "SPLIT_CLIP") {
      flashClips(
        selectedPartner
          ? [
              selectedClip.id,
              action.rightId,
              selectedPartner.id,
              action.partnerRightId,
            ]
          : [selectedClip.id, action.rightId],
      );
    }
  };

  // Delete the selected clip — and its locked partner (the reducer does
  // both). The gap stays; nothing else moves. Pauses first, like every
  // edit. Nothing is selected afterwards (project tools come back). The
  // playhead stays, unless the timeline got shorter than where it sits.
  const handleDelete = () => {
    if (!selectedClip || !deleteEnabled) return;
    pauseForGesture("delete");
    if (__DEV__)
      console.log(
        `[editor] delete ${selectedClip.id}${selectedPartner ? ` + locked ${selectedPartner.id}` : " (unlocked, alone)"}`,
      );
    const nextProject = commitProject(
      { type: "DELETE_CLIP", clipId: selectedClip.id },
      `delete ${selectedClip.track}${selectedPartner ? ", locked" : ""}`,
    );
    setSelectedClipId(null);
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    const end = projectEnd(nextProject);
    if (at > end) {
      if (__DEV__)
        console.log(
          `[editor] delete — timeline now ${end.toFixed(2)}s, playhead ${at.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(end);
    } else {
      if (isPlaying) seekTo(at);
      if (__DEV__)
        console.log(`[editor] delete — playhead stays @ ${at.toFixed(2)}s`);
    }
  };

  // The Lib (the user's saved audio / videos / images): when it has
  // something of the right kind, adding music / a video / a PIP first asks
  // "from your Lib or from the phone?" (LibPickerSheet); otherwise the
  // phone's picker opens right away, as before.
  const [libChoice, setLibChoice] = useState<{
    title: string;
    items: LibItem[];
    fromDevice: () => void;
    fromLib: (item: LibItem) => void;
  } | null>(null);
  const offerLib = (
    kinds: LibKind[],
    title: string,
    fromDevice: () => void,
    fromLib: (item: LibItem) => void,
  ) => {
    void loadLibrary()
      .then((all) => {
        const items = all.filter((it) => kinds.includes(it.kind));
        if (items.length === 0) {
          fromDevice();
          return;
        }
        if (__DEV__)
          console.log(
            `[editor] ${title} — ${items.length} Lib item(s) offered`,
          );
        setLibChoice({ title, items, fromDevice, fromLib });
      })
      .catch(() => fromDevice());
  };

  // Add music from the phone (the empty audio row's "Add audio", or the
  // Music tool): opens the phone's file picker for audio files, reads the
  // file's length, and adds it as a new unlinked audio clip at the playhead
  // — full length, even past the end of the video. If the playhead is inside
  // another audio clip, it goes to that clip's nearer edge and later clips
  // move right (clips never overlap on a track).
  const handleAddAudio = async (from: string, picked?: LibItem) => {
    if (addingAudioRef.current) return;
    addingAudioRef.current = true;
    pauseForGesture("add audio");
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    if (isPlaying) seekTo(at);
    if (__DEV__)
      console.log(
        `[editor] add audio (${from}) @ ${at.toFixed(2)}s — opening the file picker`,
      );
    try {
      // From the Lib: the file and its length are known already.
      let asset: { uri: string; name: string; mimeType?: string } | null = null;
      if (picked) {
        asset = { uri: picked.uri, name: picked.name };
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: "audio/*",
          copyToCacheDirectory: true,
          multiple: false,
        });
        asset = result.canceled ? null : (result.assets?.[0] ?? null);
      }
      if (!asset) {
        if (__DEV__) console.log("[editor] add audio — picker cancelled");
        return;
      }
      if (__DEV__)
        console.log(
          `[editor] add audio — ${picked ? "from the Lib:" : "picked"} ${asset.name} (${asset.mimeType ?? (picked ? "lib" : "unknown type")})`,
        );
      setAddingAudio(true);
      const duration =
        picked && picked.duration > 0
          ? picked.duration
          : await probeDuration(asset.uri);
      if (duration <= 0) {
        Alert.alert(
          "Couldn't add audio",
          "This file couldn't be read. Try another audio file.",
        );
        return;
      }
      const title = picked
        ? picked.name
        : asset.name.replace(/\.[^.]+$/, "") || "Music";
      const addAction = addAudioClipAction(asset.uri, duration, title, at);
      const next = commitProject(addAction, "add audio");
      if (addAction.type === "ADD_CLIP") flashClips([addAction.clip.id]);
      if (__DEV__) {
        const added = next.tracks.audio.find(
          (c) => c.sourceUri === asset.uri && !findClip(project, c.id),
        );
        console.log(
          `[editor] add audio — "${title}" (${duration.toFixed(2)}s) wanted @ ${at.toFixed(2)}s, placed @ ${added?.start.toFixed(2) ?? "?"}s${added && clipLength(added) < duration - 0.01 ? `, shortened to ${clipLength(added).toFixed(2)}s to fit before the next clip` : ""}`,
        );
      }
    } catch (error) {
      if (__DEV__) console.log("[editor] add audio failed", error);
      Alert.alert(
        "Couldn't add audio",
        "Something went wrong opening the file.",
      );
    } finally {
      addingAudioRef.current = false;
      setAddingAudio(false);
    }
  };

  // The timeline's "+" (above the mute button): a video from the phone put
  // FIRST, at 0s. Everything already on the timeline moves right by its
  // length (INSERT_VIDEO_AT_START); the playhead goes to 0 to show it.
  const addingVideoRef = useRef(false);
  const [addingVideo, setAddingVideo] = useState(false);
  // The timeline's two "+" buttons: "start" (above the mute button) puts
  // the video FIRST, at 0s — everything already on the timeline moves right
  // by its length (INSERT_VIDEO_AT_START); "end" (after the last video clip)
  // puts it right after the last video clip — nothing moves
  // (INSERT_VIDEO_AT_END). The playhead goes to the new clip's start.
  const handleAddVideo = async (where: "start" | "end", picked?: LibItem) => {
    if (addingVideoRef.current) return;
    addingVideoRef.current = true;
    pauseForGesture(`add video at ${where}`);
    if (__DEV__)
      console.log(`[editor] add video at ${where} — opening the gallery`);
    try {
      const asset = picked
        ? libAsset(picked)
        : await (async () => {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["videos"],
              allowsEditing: false,
              quality: 1,
            });
            return result.canceled ? null : (result.assets?.[0] ?? null);
          })();
      if (!asset) {
        if (__DEV__)
          console.log(`[editor] add video at ${where} — picker cancelled`);
        return;
      }
      setAddingVideo(true);
      let length = asset.duration ? asset.duration / 1000 : 0;
      if (!(length > 0)) length = await probeDuration(asset.uri);
      if (!(length > 0)) {
        Alert.alert(
          "Couldn't add video",
          "This video couldn't be read. Try another one.",
        );
        return;
      }
      const name = asset.fileName ?? asset.uri.split("/").pop();
      if (where === "start") {
        const action = insertVideoAtStartAction(asset.uri, length);
        commitProject(action, "add video at start");
        if (action.type === "INSERT_VIDEO_AT_START") {
          flashClips([action.videoClipId, action.audioClipId]);
        }
        setSelectedClipId(null);
        seekTo(0);
        if (__DEV__)
          console.log(
            `[editor] add video at 0s — ${name} (${length.toFixed(2)}s, ${asset.width}×${asset.height}); everything else moved right by ${length.toFixed(2)}s`,
          );
      } else {
        const at = videoClips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
        const room = freeAudioRoom(project, at);
        const action = insertVideoAtEndAction(asset.uri, length);
        const next = commitProject(action, "add video at end");
        if (action.type === "INSERT_VIDEO_AT_END") {
          const added = [action.videoClipId, action.audioClipId].filter(
            (id) => findClip(next, id) !== null,
          );
          flashClips(added);
        }
        setSelectedClipId(null);
        seekTo(at);
        if (room < length - 0.001)
          showToast(
            room >= 0.5
              ? "Video added — its sound was shortened (music is there)"
              : "Video added — without its sound (music is there)",
          );
        if (__DEV__)
          console.log(
            `[editor] add video at the end (${at.toFixed(2)}s) — ${name} (${length.toFixed(2)}s, ${asset.width}×${asset.height}); sound: ${room >= length - 0.001 ? "full, locked" : room >= 0.5 ? `shortened to ${room.toFixed(2)}s (audio row busy)` : "left out (audio row busy)"}`,
          );
      }
    } catch (error) {
      if (__DEV__) console.log(`[editor] add video at ${where} failed`, error);
      Alert.alert(
        "Couldn't add video",
        "Something went wrong opening the gallery.",
      );
    } finally {
      addingVideoRef.current = false;
      setAddingVideo(false);
    }
  };

  // PIP tool: a video or photo from the phone, as a layer over the main
  // video at the playhead (half the frame's width, in the middle).
  const addingPipRef = useRef(false);
  const handleAddPip = async (from: string, picked?: LibItem) => {
    if (addingPipRef.current) return;
    addingPipRef.current = true;
    pauseForGesture("add PIP");
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    if (isPlaying) seekTo(at);
    if (__DEV__)
      console.log(
        `[editor] add PIP (${from}) @ ${at.toFixed(2)}s — opening the gallery`,
      );
    try {
      const asset = picked
        ? libAsset(picked)
        : await (async () => {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images", "videos"],
              allowsEditing: false,
              quality: 1,
            });
            return result.canceled ? null : (result.assets?.[0] ?? null);
          })();
      if (!asset) {
        if (__DEV__) console.log("[editor] add PIP — picker cancelled");
        return;
      }
      const isVideo = asset.type === "video";
      let duration = 0;
      if (isVideo) {
        duration = asset.duration
          ? asset.duration / 1000
          : await probeDuration(asset.uri);
        if (!(duration > 0)) duration = await probeDuration(asset.uri);
        if (!(duration > 0)) {
          Alert.alert(
            "Couldn't add PIP",
            "This video couldn't be read. Try another one.",
          );
          return;
        }
      }
      const aspect =
        asset.width > 0 && asset.height > 0
          ? asset.width / asset.height
          : 16 / 9;
      const title = (
        asset.fileName ??
        asset.uri.split("/").pop() ??
        "PIP"
      ).replace(/\.[^.]+$/, "");
      const action = addPipClipAction(
        asset.uri,
        {
          kind: isVideo ? "video" : "image",
          aspect,
          x: 0.5,
          y: 0.5,
          width: 0.5,
          scale: 1,
          rotation: 0,
          title,
        },
        duration,
        at,
      );
      if (__DEV__)
        console.log(
          `[editor] add PIP — ${isVideo ? `video ${duration.toFixed(2)}s` : "photo"} ${asset.width}×${asset.height} "${title}"`,
        );
      commitProject(action, `add PIP ${isVideo ? "video" : "photo"}`);
      if (action.type === "ADD_CLIP") {
        setSelectedClipId(action.clip.id);
        flashClips([action.clip.id]);
      }
    } catch (error) {
      if (__DEV__) console.log("[editor] add PIP failed", error);
      Alert.alert(
        "Couldn't add PIP",
        "Something went wrong opening the gallery.",
      );
    } finally {
      addingPipRef.current = false;
    }
  };

  // Undo / redo: step back / forward through the edits (history.ts). Like
  // any edit, it pauses first and clears the selection (the selected clip
  // may not exist in the other version). The playhead stays, unless the
  // timeline gets shorter than where it sits.
  const handleHistory = (direction: "undo" | "redo") => {
    const current = historyRef.current;
    const entry =
      direction === "undo"
        ? current.past[current.past.length - 1]
        : current.future[0];
    if (!entry) {
      if (__DEV__)
        console.log(`[editor] ${direction} — nothing to ${direction}`);
      return;
    }
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    pauseForGesture(direction);
    // (Only when something is selected: an extra re-render of the whole
    // editor per tap made fast undo / redo feel slower.)
    if (selectedClipId !== null) setSelectedClipId(null);
    const historyAction = {
      type: direction === "undo" ? "UNDO" : "REDO",
    } as const;
    const after = historyReducer(current, historyAction);
    historyRef.current = after;
    dispatchHistory(historyAction);
    const target = after.present;
    const end = projectEnd(target);
    if (__DEV__)
      console.log(
        `[editor] ${direction} "${entry.label}" — ${after.past.length} step(s) back available, ${after.future.length} forward`,
      );
    if (at > end) {
      if (__DEV__)
        console.log(
          `[editor] ${direction} — timeline now ${end.toFixed(2)}s, playhead ${at.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(end);
    } else if (isPlaying) {
      seekTo(at);
    }
  };

  // ---- Text (step 5a / 5a.1) --------------------------------------------
  // The text sheet: adding a new text at `at`, or editing an existing one.
  // `draft` is what the sheet shows — drawn live on the preview.
  const [textEditor, setTextEditor] = useState<
    | { mode: "add"; at: number; draft: TextClipData }
    | { mode: "edit"; clipId: string; draft: TextClipData }
    | null
  >(null);
  // The sheet's height (the preview shrinks to fit above it) and whether a
  // text is being dragged / rotated on the preview (page scroll paused).
  const [sheetHeight, setSheetHeight] = useState(0);
  const [textGestureActive, setTextGestureActive] = useState(false);
  const [topOffset, setTopOffset] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const { width: windowWidth } = useWindowDimensions();
  // Status bar / navigation bar space (fullscreen preview).
  const insets = useSafeAreaInsets();
  useFontsVersion(); // redraw texts when a downloaded font is ready

  const patchDraft = (patch: Partial<TextClipData>) =>
    setTextEditor((t) => (t ? { ...t, draft: { ...t.draft, ...patch } } : t));

  const openAddText = (from: string) => {
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    pauseForGesture("add text");
    if (isPlaying) seekTo(at);
    setSelectedClipId(null);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    if (__DEV__)
      console.log(
        `[editor] add text (${from}) @ ${at.toFixed(2)}s — sheet open`,
      );
    setTextEditor({ mode: "add", at, draft: { ...DEFAULT_TEXT_DATA } });
  };

  const openEditText = (clipId?: string) => {
    const clip = clipId ? findClip(project, clipId) : selectedClip;
    if (!clip || clip.track !== "text") return;
    pauseForGesture("edit text");
    setSelectedClipId(clip.id);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    if (__DEV__) console.log(`[editor] edit text ${clip.id} — sheet open`);
    setTextEditor({ mode: "edit", clipId: clip.id, draft: textDataOf(clip) });
  };

  const closeTextEditor = (why: string) => {
    Keyboard.dismiss();
    if (__DEV__) console.log(`[editor] text sheet closed (${why})`);
    setTextEditor(null);
    setSheetHeight(0);
  };

  const handleTextDone = () => {
    if (!textEditor) return;
    const draft = { ...textEditor.draft, text: textEditor.draft.text.trim() };
    if (!draft.text) {
      closeTextEditor("empty text — nothing saved");
      return;
    }
    if (textEditor.mode === "add") {
      const action = addTextClipAction(draft, textEditor.at);
      commitProject(action, "add text");
      if (action.type === "ADD_CLIP") {
        // Select it (its tools show) and flash it.
        setSelectedClipId(action.clip.id);
        flashClips([action.clip.id]);
      }
    } else {
      const next = commitProject(
        { type: "UPDATE_CLIP_DATA", clipId: textEditor.clipId, data: draft },
        "edit text",
      );
      if (next !== project) flashClips([textEditor.clipId]);
    }
    closeTextEditor("done");
  };

  const handleDuplicate = () => {
    if (
      !selectedClip ||
      (selectedClip.track !== "text" && selectedClip.track !== "sticker")
    )
      return;
    pauseForGesture("duplicate");
    const action = duplicateClipAction(selectedClip);
    commitProject(action, `duplicate ${selectedClip.track}`);
    if (action.type === "ADD_CLIP") {
      setSelectedClipId(action.clip.id);
      flashClips([action.clip.id]);
    }
  };

  // Android back button closes the sheet without saving.
  useEffect(() => {
    if (!textEditor) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeTextEditor("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEditor !== null]);

  // The Google fonts ship with the app: load them all once, so every font
  // is ready (offline too) by the time a text uses it.
  useEffect(() => {
    preloadAllFonts();
  }, []);

  // ---- Texts on the preview ------------------------------------------------
  const DRAFT_ID = "__draft__";
  const selectedTextId = textEditor
    ? textEditor.mode === "add"
      ? DRAFT_ID
      : textEditor.clipId
    : selectedClip?.track === "text" ||
        selectedClip?.track === "sticker" ||
        selectedClip?.track === "pip"
      ? selectedClip.id
      : null;

  const handleTextSelect = (id: string) => {
    lastTextTapAtRef.current = Date.now();
    if (textEditor) return; // finish the open text first
    pauseForGesture("text tap");
    if (__DEV__)
      console.log(`[editor] select text ${id} (tapped on the preview)`);
    setSelectedClipId(id);
  };

  const handleTextEditSelected = (id: string) => {
    lastTextTapAtRef.current = Date.now();
    if (textEditor) return;
    // A selected PIP tapped again: nothing to edit there.
    if (findClip(project, id)?.track === "pip") return;
    // Tapping a selected sticker again opens the stickers to swap it.
    if (findClip(project, id)?.track === "sticker") {
      openStickers("replace", "sticker tapped again", id);
      return;
    }
    openEditText(id);
  };

  const handleTextDelete = (id: string) => {
    if (id === DRAFT_ID) {
      closeTextEditor("draft deleted (✕)");
      return;
    }
    if (textEditor) closeTextEditor("text deleted (✕)");
    pauseForGesture("delete text");
    const kind = findClip(project, id)?.track ?? "text";
    commitProject(
      { type: "DELETE_CLIP", clipId: id },
      `delete ${kind} (✕ on preview)`,
    );
    setSelectedClipId(null);
  };

  const handleTextTransform = (id: string, t: TextTransform) => {
    lastTextTapAtRef.current = Date.now();
    const editingThis =
      textEditor &&
      ((textEditor.mode === "add" && id === DRAFT_ID) ||
        (textEditor.mode === "edit" && textEditor.clipId === id));
    if (editingThis) {
      patchDraft(t); // saved with the sheet's ✓
      return;
    }
    const clip = findClip(project, id);
    if (!clip) return;
    if (clip.track === "sticker") {
      commitProject(
        {
          type: "UPDATE_CLIP_DATA",
          clipId: id,
          data: { ...stickerDataOf(clip), ...t },
        },
        "move / resize sticker",
      );
      return;
    }
    if (clip.track === "pip") {
      commitProject(
        {
          type: "UPDATE_CLIP_DATA",
          clipId: id,
          data: { ...pipDataOf(clip), ...t },
        },
        "move / resize PIP",
      );
      return;
    }
    commitProject(
      {
        type: "UPDATE_CLIP_DATA",
        clipId: id,
        data: { ...textDataOf(clip), ...t },
      },
      "move / resize text",
    );
  };

  // Keyboard: lift the text sheet above it. If Android already shrank the
  // screen for the keyboard (adjustResize), only the part it didn't cover.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // The keyboard's height the last time it was open: the text sheet's
  // panel gets the same height, so it takes the keyboard's place exactly
  // and the sheet / preview don't jump when the keyboard closes.
  const [lastKeyboardHeight, setLastKeyboardHeight] = useState(0);
  const [rootHeight, setRootHeight] = useState(0);
  // The screen's full height (the most it has been — the keyboard can only
  // make it smaller).
  const [maxRootHeight, setMaxRootHeight] = useState(0);
  useEffect(() => {
    // Android often reports the keyboard twice while it opens (e.g. 302px,
    // then 255px once the suggestion bar settles): the panel height follows
    // only the settled value, so the preview doesn't resize twice.
    let settle: ReturnType<typeof setTimeout> | null = null;
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      const h = e.endCoordinates.height;
      setKeyboardHeight(h);
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => setLastKeyboardHeight(h), 300);
      if (__DEV__) console.log(`[editor] keyboard open (${Math.round(h)}px)`);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboardHeight(0),
    );
    return () => {
      if (settle) clearTimeout(settle);
      show.remove();
      hide.remove();
    };
  }, []);
  const sheetBottom = Math.max(
    0,
    keyboardHeight - Math.max(0, maxRootHeight - rootHeight),
  );

  // While the sheet is open, the preview shrinks to fit above it (CapCut
  // style): as tall as the space left, never bigger than normal.
  const normalPreviewHeight = ((windowWidth - 24) * 0.75 * 16) / 9;
  // Computed from things that DON'T change when the keyboard opens or
  // closes: the screen's full height, the sheet's top part and the panel
  // height (= the keyboard's height). Before, it used the live sheet height
  // and screen height, which change at slightly different moments when the
  // keyboard opens — the preview jumped small and back.
  const panelSpace = Math.max(MIN_PANEL_HEIGHT, lastKeyboardHeight);
  const editingPreviewHeight =
    textEditor && sheetHeight > 0 && maxRootHeight > 0
      ? Math.max(
          120,
          Math.min(
            normalPreviewHeight,
            maxRootHeight - topOffset - sheetHeight - panelSpace - 16,
          ),
        )
      : null;

  // Texts drawn on the preview: those under the playhead, plus the one in
  // the sheet (always shown while it's being written / edited).
  // Stickers under the playhead are drawn above the texts; the PIP below
  // both.
  const visibleTexts: OverlayItem[] = [];
  for (const clip of textClips) {
    if (textEditor?.mode === "edit" && textEditor.clipId === clip.id) {
      visibleTexts.push({ id: clip.id, kind: "text", data: textEditor.draft });
    } else if (clipContains(clip, timelineTime)) {
      visibleTexts.push({ id: clip.id, kind: "text", data: textDataOf(clip) });
    }
  }
  if (textEditor?.mode === "add") {
    visibleTexts.push({
      id: DRAFT_ID,
      kind: "text",
      data: textEditor.draft.text
        ? textEditor.draft
        : { ...textEditor.draft, text: "Enter text" },
    });
  }
  for (const clip of stickerClips) {
    if (clipContains(clip, timelineTime)) {
      visibleTexts.push({
        id: clip.id,
        kind: "sticker",
        data: stickerDataOf(clip),
      });
    }
  }

  // ---- Stickers ---------------------------------------------------------
  // The sticker sheet: adding a new one at the playhead, or swapping the
  // emoji of a selected one.
  const [stickerSheet, setStickerSheet] = useState<
    { mode: "add" } | { mode: "replace"; clipId: string } | null
  >(null);

  const openStickers = (
    mode: "add" | "replace",
    why: string,
    clipId?: string,
  ) => {
    pauseForGesture("stickers");
    if (__DEV__) console.log(`[editor] sticker sheet open (${mode}, ${why})`);
    if (mode === "replace") {
      const id = clipId ?? selectedClip?.id;
      if (!id) return;
      setStickerSheet({ mode: "replace", clipId: id });
    } else {
      setStickerSheet({ mode: "add" });
    }
  };

  const closeStickers = (why: string) => {
    if (__DEV__) console.log(`[editor] sticker sheet closed (${why})`);
    setStickerSheet(null);
  };

  const handleStickerPick = (emoji: string) => {
    if (!stickerSheet) return;
    if (stickerSheet.mode === "replace") {
      const clip = findClip(project, stickerSheet.clipId);
      if (clip) {
        commitProject(
          {
            type: "UPDATE_CLIP_DATA",
            clipId: clip.id,
            data: { ...stickerDataOf(clip), emoji },
          },
          `replace sticker → ${emoji}`,
        );
        flashClips([clip.id]);
      }
      closeStickers("replaced");
      return;
    }
    const action = addStickerClipAction(
      { ...DEFAULT_STICKER_DATA, emoji },
      timelineTime,
    );
    commitProject(action, `add sticker ${emoji}`);
    if (action.type === "ADD_CLIP") {
      setSelectedClipId(action.clip.id);
      flashClips([action.clip.id]);
    }
    closeStickers("added");
  };

  // Android back closes the sticker sheet.
  useEffect(() => {
    if (!stickerSheet) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeStickers("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickerSheet !== null]);

  // ---- Canvas (nothing selected): the output frame --------------------
  // While the Canvas sheet is open its draft is shown live.
  const [canvasDraft, setCanvasDraft] = useState<CanvasSettings | null>(null);
  // Crop tool (whole video): the draft box while its sheet is open. While
  // cropping, the frame shows the whole, uncropped video picture (the box
  // is drawn over it).
  const [cropSetting, setCropSetting] = useState<{
    rect: CropRect;
    preset: CropPreset;
  } | null>(null);
  const savedCanvas = canvasDraft ?? canvasOf(project);
  const canvas: CanvasSettings = cropSetting
    ? { ...savedCanvas, ratio: "original", crop: null }
    : savedCanvas;
  const videoAspect = videoSize ? videoSize.width / videoSize.height : null;

  // `frame` = the canvas (the exported video's frame) inside the preview
  // box: its shape, as big as fits. Texts are placed in it, the background
  // colour fills it, and each picture is fitted whole inside it.
  let frame: FrameRect | null = null;
  if (previewSize) {
    frame = containRect(
      { left: 0, top: 0, width: previewSize.width, height: previewSize.height },
      frameAspect(canvas, videoAspect),
    );
  }
  // The PIP layer (below the texts / stickers): its picture sized from its
  // clip; the video view stays mounted across PIP clips (layerKey).
  if (pipShown && frame) {
    const d = pipDataOf(pipShown);
    const size = pipSize(d, frame.width);
    visibleTexts.unshift({
      id: pipShown.id,
      layerKey: "pip-layer",
      kind: "pip",
      data: d,
      active: clipContains(pipShown, timelineTime),
      content: (
        <Animated.View
          collapsable={false}
          style={[
            { width: size.w, height: size.h },
            pipVisibleStyle,
            // Not in its clip: kept out of a capture (the capture draws
            // video views even when they're see-through).
            shotMode &&
              !clipContains(pipShown, timelineTime) &&
              styles.offCanvas,
          ]}
        >
          {d.kind === "video" ? (
            <>
              {/* The PIP video: a native view the preview plays the PIP
                  clip into, in step with the main video (see
                  VidsurgePreviewView.kt). Moved / sized / turned / faded by
                  this frame like before. */}
              {NativePip && (
                <NativePip
                  ref={pipViewRef}
                  style={[styles.video, frozen?.pip ? styles.offCanvas : null]}
                />
              )}
              {frozen?.pip && (
                <Image
                  source={{ uri: frozen.pip }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="stretch"
                  fadeDuration={0}
                  onLoad={onFrozenLoad}
                  onError={onFrozenLoad}
                />
              )}
            </>
          ) : (
            <Image
              source={{ uri: pipShown.sourceUri }}
              style={styles.video}
              resizeMode="cover"
            />
          )}
        </Animated.View>
      ),
    });
  }

  // The picture's own size inside the canvas (VideoView "contain").
  const picture =
    frame && videoAspect ? containRect(frame, videoAspect) : frame;

  // ---- Export quality (the "1080P" button) -----------------------------
  // A draft while the sheet is open; ✓ saves it (one undo step).
  const [exportDraft, setExportDraft] = useState<ExportSettings | null>(null);
  const openExportSettings = () => {
    // Not over another tool's sheet.
    if (
      textEditor ||
      stickerSheet ||
      cropSetting ||
      clipSetting ||
      rotateSetting ||
      canvasDraft
    ) {
      if (__DEV__)
        console.log("[editor] export settings — ignored while a sheet is open");
      return;
    }
    pauseForGesture("export settings");
    if (__DEV__)
      console.log(
        `[editor] export settings open (${describeExport(demoExportOf(project))})`,
      );
    setExportDraft(demoExportOf(project));
  };
  const closeExportSettings = (apply: boolean) => {
    if (apply && exportDraft) {
      commitProject(
        { type: "SET_EXPORT_SETTINGS", settings: exportDraft },
        `export ${describeExport(exportDraft)}`,
      );
    }
    if (__DEV__)
      console.log(
        `[editor] export settings closed (${apply ? "applied" : "cancelled"})`,
      );
    setExportDraft(null);
  };
  // Android back closes it without saving.
  useEffect(() => {
    if (!exportDraft) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeExportSettings(false);
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDraft !== null]);

  // ---- Export (the Export button) ---------------------------------------
  // The plan being exported (ExportModal shows while it's set).
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  // Before that, while the texts / stickers are drawn into pictures
  // (OverlayRenderer): the plan waiting for them.
  const [overlayJob, setOverlayJob] = useState<{
    job: OverlayJob;
    plan: ExportPlan;
    /** The engine test, not a real export (long press on Export). */
    test?: boolean;
  } | null>(null);
  // The engine test (dev): exports the project once per feature and says
  // which one makes the engine fail (see src/lib/engineDiagnostics.ts).
  const runEngineTest = async (plan: ExportPlan) => {
    showToast("Engine test running — watch the Metro log");
    const results = await runEngineDiagnostics(plan, (name, i, total) =>
      showToast(`Engine test ${i + 1}/${total}: ${name}`),
    );
    for (const o of plan.overlays) {
      try {
        const f = new File(o.uri);
        if (f.exists) f.delete();
      } catch {
        // left in the cache
      }
    }
    Alert.alert(
      "Engine test",
      results
        .map(
          (r) =>
            `${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n   ${r.error}`}`,
        )
        .join("\n"),
    );
  };
  const handleOverlaysDone = (result: OverlayResult) => {
    const pending = overlayJob;
    if (!pending) return;
    setOverlayJob(null);
    if ("error" in result) {
      Alert.alert(
        "Export failed",
        `Couldn't prepare the texts and stickers: ${result.error}`,
      );
      return;
    }
    const overlays = pending.job.segments.map((seg, i) => ({
      start: seg.start,
      end: seg.end,
      uri: result.uris[i],
    }));
    if (__DEV__)
      console.log(
        `[editor] export — ${overlays.length} text/sticker picture(s) ready`,
      );
    if (pending.test) {
      void runEngineTest({ ...pending.plan, overlays });
      return;
    }
    setExportPlan({ ...pending.plan, overlays });
  };
  const closeExport = () => {
    setOverlayJob(null);
    setExportPlan(null);
  };
  const handleExport = (test = false) => {
    if (
      textEditor ||
      stickerSheet ||
      cropSetting ||
      clipSetting ||
      rotateSetting ||
      canvasDraft ||
      exportDraft
    ) {
      if (__DEV__)
        console.log("[editor] export — ignored while a sheet is open");
      return;
    }
    if (overlayJob || exportPlan) {
      if (__DEV__) console.log("[editor] export — already running");
      return;
    }
    pauseForGesture("export");
    if (!isEngineAvailable()) {
      if (__DEV__)
        console.log("[editor] export — engine not in this app build");
      Alert.alert(
        "Export not available yet",
        "This app build doesn't include the export engine. Install the new build to export videos.",
      );
      return;
    }
    if (!hasContent(project) || project.tracks.video.length === 0) {
      showToast("Add a video to export");
      return;
    }
    // The edit is saved first (a crash while exporting can't lose it).
    void saveNow("export");
    const outputPath = new File(
      Paths.cache,
      `vidsurge-export-${Date.now()}.mp4`,
    ).uri;
    const plan = buildExportPlan({
      project,
      settings: demoExportOf(project),
      videoAspect,
      audioMuted,
      outputPath,
    });
    const segments = overlaySegments(project, plan.duration);
    // An app build with an older engine can't export everything: say so
    // right away (before drawing the texts).
    if (engineVersion() < REQUIRED_ENGINE_VERSION) {
      const missing = unsupportedByEngine({
        ...plan,
        overlays: segments.map((sg) => ({
          start: sg.start,
          end: sg.end,
          uri: "",
        })),
      });
      if (missing.length > 0) {
        if (__DEV__)
          console.log(
            `[editor] export — old engine v${engineVersion()} can't export: ${missing.join(", ")}`,
          );
        Alert.alert(
          "Not in this app build yet",
          `This app build's export engine (v${engineVersion()}) can't export ${missing.join(", ")} — the next app build fixes it. Until then, remove them from the video to export it.`,
        );
        return;
      }
    }
    if (__DEV__)
      console.log(
        `[editor] export start — ${plan.width}x${plan.height} ${plan.fps}fps, ${plan.pip.length} PIP, ${segments.length} text/sticker stretch(es)`,
      );
    if (test && __DEV__)
      console.log("[editor] Export long-pressed — engine test");
    if (segments.length === 0) {
      if (test) void runEngineTest(plan);
      else setExportPlan(plan);
      return;
    }
    setOverlayJob({
      job: {
        id: Date.now(),
        segments,
        pixelWidth: plan.width,
        pixelHeight: plan.height,
      },
      plan,
      test,
    });
  };

  const openCanvas = () => {
    pauseForGesture("canvas");
    if (__DEV__)
      console.log(
        `[editor] canvas sheet open (${describeCanvas(canvasOf(project))})`,
      );
    setCanvasDraft(canvasOf(project));
  };
  const closeCanvas = (why: string) => {
    if (__DEV__) console.log(`[editor] canvas sheet closed (${why})`);
    setCanvasDraft(null);
  };
  const applyCanvas = () => {
    if (!canvasDraft) return;
    commitProject(
      { type: "SET_CANVAS", canvas: canvasDraft },
      `canvas ${canvasDraft.ratio} on ${canvasDraft.background}`,
    );
    closeCanvas("applied");
  };
  // Android back closes the Canvas sheet without applying.
  useEffect(() => {
    if (!canvasDraft) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeCanvas("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasDraft !== null]);

  // ---- Clip settings: Speed / Volume (step 7) --------------------------
  // The open settings sheet: which setting, which clip, the draft value.
  const [clipSetting, setClipSetting] = useState<{
    kind: ClipSettingKind;
    clipId: string;
    value: number;
  } | null>(null);

  const openClipSetting = (kind: ClipSettingKind) => {
    if (!selectedClip) return;
    // Volume lives on the audio clip, Opacity on the video clip: for a
    // locked pair, that half.
    const halfOn = (track: "audio" | "video") =>
      selectedClip.track === track
        ? selectedClip
        : selectedPartner?.track === track
          ? selectedPartner
          : null;
    // A PIP has its own picture AND sound: every setting applies to it.
    const target =
      selectedClip.track === "pip"
        ? selectedClip
        : kind === "volume"
          ? halfOn("audio")
          : kind === "opacity"
            ? halfOn("video")
            : selectedClip;
    if (!target) return;
    pauseForGesture(kind);
    if (__DEV__) console.log(`[editor] ${kind} sheet open for ${target.id}`);
    if (kind === "opacity") bringPlayheadInto(target, kind);
    setClipSetting({
      kind,
      clipId: target.id,
      value:
        kind === "speed"
          ? target.speed
          : kind === "volume"
            ? target.volume
            : target.opacity,
    });
  };

  // Picture tools (Opacity, Rotate) are judged by looking at the picture:
  // bring the playhead into the clip if it's elsewhere, so the preview
  // shows the change live.
  const bringPlayheadInto = (target: Clip, why: string) => {
    if (clipContains(target, timelineTime)) return;
    const into = Math.min(clipEnd(target) - 0.05, target.start + 0.05);
    if (__DEV__)
      console.log(
        `[editor] ${why} — playhead ${timelineTime.toFixed(2)}s is outside ${target.id}, moved to ${into.toFixed(2)}s`,
      );
    seekTo(into);
  };

  // ---- Crop (whole video) ---------------------------------------------
  /** Width ÷ height of a crop preset (null = free). */
  const cropPresetAspect = (p: CropPreset): number | null =>
    p === "free" ? null : canvasAspect(p, videoAspect);

  const openCrop = () => {
    pauseForGesture("crop");
    const current = canvasOf(project);
    if (__DEV__)
      console.log(
        `[editor] crop sheet open (${current.crop ? describeCanvas(current) : "whole picture"})`,
      );
    setCropSetting({ rect: current.crop ?? FULL_CROP, preset: "free" });
  };

  const closeCrop = (why: string) => {
    if (__DEV__) console.log(`[editor] crop sheet closed (${why})`);
    setCropSetting(null);
  };

  const applyCropPreset = (p: CropPreset) => {
    setCropSetting((c) => {
      if (!c) return c;
      const r = cropPresetAspect(p);
      if (r === null || !videoAspect) return { ...c, preset: p };
      // The biggest box of that shape, centred on the current box.
      let w = 1;
      let h = 1;
      if (r >= videoAspect) h = videoAspect / r;
      else w = r / videoAspect;
      const cx = c.rect.x + c.rect.w / 2;
      const cy = c.rect.y + c.rect.h / 2;
      const x = Math.min(1 - w, Math.max(0, cx - w / 2));
      const y = Math.min(1 - h, Math.max(0, cy - h / 2));
      return { ...c, preset: p, rect: { x, y, w, h } };
    });
  };

  // ✓: the frame becomes the box (Canvas ratio shows "Crop"); the whole
  // picture again (Reset) removes the crop.
  const applyCrop = () => {
    if (!cropSetting) return;
    const current = canvasOf(project);
    const next = commitProject(
      { type: "SET_CANVAS", canvas: { ...current, crop: cropSetting.rect } },
      `crop ${cropSetting.rect.w.toFixed(2)}×${cropSetting.rect.h.toFixed(2)}`,
    );
    if (next !== project) flashClips(videoClips.map((c) => c.id));
    closeCrop("applied");
  };

  // Android back closes the Crop sheet without applying.
  useEffect(() => {
    if (!cropSetting) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeCrop("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropSetting !== null]);

  // ---- Rotate (video clips) --------------------------------------------
  const [rotateSetting, setRotateSetting] = useState<{
    clipId: string;
    angle: number;
    flip: boolean;
  } | null>(null);

  const openRotate = () => {
    if (!selectedClip) return;
    const target =
      selectedClip.track === "video"
        ? selectedClip
        : selectedPartner?.track === "video"
          ? selectedPartner
          : null;
    if (!target) return;
    pauseForGesture("rotate");
    if (__DEV__)
      console.log(
        `[editor] rotate sheet open for ${target.id} (${target.rotate}°${target.flipX ? ", flipped" : ""})`,
      );
    bringPlayheadInto(target, "rotate");
    setRotateSetting({
      clipId: target.id,
      angle: target.rotate,
      flip: !!target.flipX,
    });
  };

  const closeRotate = (why: string) => {
    if (__DEV__) console.log(`[editor] rotate sheet closed (${why})`);
    setRotateSetting(null);
  };

  const applyRotate = () => {
    if (!rotateSetting) return;
    const { clipId, angle, flip } = rotateSetting;
    const next = commitProject(
      { type: "SET_CLIP_ROTATION", clipId, rotate: angle, flipX: flip },
      `rotate ${angle}°${flip ? " flipped" : ""}`,
    );
    if (next !== project) flashClips([clipId]);
    closeRotate("applied");
  };

  // Android back closes the Rotate sheet without applying.
  useEffect(() => {
    if (!rotateSetting) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeRotate("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotateSetting !== null]);

  const closeClipSetting = (why: string) => {
    if (__DEV__)
      console.log(
        `[editor] ${clipSetting?.kind ?? "setting"} sheet closed (${why})`,
      );
    setClipSetting(null);
  };

  const applyClipSetting = () => {
    if (!clipSetting) return;
    const { kind, clipId, value } = clipSetting;
    const partner = (() => {
      const c = findClip(project, clipId);
      return c ? findLinkedPartner(project, c) : null;
    })();
    const next = commitProject(
      kind === "speed"
        ? { type: "SET_CLIP_SPEED", clipId, speed: value }
        : kind === "volume"
          ? { type: "SET_CLIP_VOLUME", clipId, volume: value }
          : { type: "SET_CLIP_OPACITY", clipId, opacity: value },
      `${kind} ${kind === "speed" ? `${value}×` : `${Math.round(value * 100)}%`}`,
    );
    if (next !== project) {
      flashClips(kind === "speed" && partner ? [clipId, partner.id] : [clipId]);
      const end = projectEnd(next);
      if (timelineTime > end) seekTo(end);
    }
    closeClipSetting("applied");
  };

  // Android back closes the settings sheet without applying.
  useEffect(() => {
    if (!clipSetting) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeClipSetting("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipSetting !== null]);

  const settingClip = clipSetting
    ? findClip(project, clipSetting.clipId)
    : null;

  // ---- The edit → native preview ---------------------------------------------
  // Live values while a sheet is open: the Opacity sheet's draft and the
  // Rotate sheet's draft show on the preview right away; while cropping, the
  // whole picture, unturned (the crop box is drawn over it).
  const opacityDraftId =
    clipSetting?.kind === "opacity" ? clipSetting.clipId : null;
  const opacityDraftValue =
    clipSetting?.kind === "opacity" ? clipSetting.value : null;
  const isCropping = cropSetting !== null;
  const rotateDraftId = rotateSetting?.clipId ?? null;
  const rotateDraftAngle = rotateSetting?.angle ?? 0;
  const rotateDraftFlip = rotateSetting?.flip ?? false;
  const previewPlanJson = useMemo(
    () =>
      JSON.stringify(
        buildPreviewPlan({
          project,
          canvas,
          videoAspect,
          drafts: {
            opacity:
              opacityDraftId !== null && opacityDraftValue !== null
                ? { clipId: opacityDraftId, value: opacityDraftValue }
                : null,
            rotate:
              rotateDraftId !== null
                ? {
                    clipId: rotateDraftId,
                    angle: rotateDraftAngle,
                    flip: rotateDraftFlip,
                  }
                : null,
            flat: isCropping,
          },
        }),
      ),
    [
      project,
      canvas,
      videoAspect,
      opacityDraftId,
      opacityDraftValue,
      rotateDraftId,
      rotateDraftAngle,
      rotateDraftFlip,
      isCropping,
    ],
  );
  // Sent whenever it changes. The native side only reloads the video when
  // the timeline itself changed (cuts, clips, speed, crop, frame shape);
  // looks (turn, mirror, opacity, volume, colour) change in place.
  const lastSentPlanRef = useRef("");
  // A new preview view (it was taken off screen) gets the edit again.
  useEffect(() => {
    if (!previewMounted) lastSentPlanRef.current = "";
  }, [previewMounted]);
  const hasVideo = project.tracks.video.length > 0;
  useEffect(() => {
    if (!previewMounted || !previewRef.current) return;
    // Nothing to show yet (a new project's first video is still loading).
    if (!hasVideo) return;
    if (previewPlanJson === lastSentPlanRef.current) return;
    lastSentPlanRef.current = previewPlanJson;
    if (__DEV__)
      console.log(
        `[editor] preview ← edit (${previewPlanJson.length} chars) @ ${getTime().toFixed(2)}s`,
      );
    void previewRef.current
      .setTimeline(previewPlanJson, getTime() * 1000)
      .catch((e: unknown) => {
        if (__DEV__) console.log("[editor] preview setTimeline failed", e);
      });
  }, [previewPlanJson, previewMounted, hasVideo, getTime]);

  // The PIP layer's opacity: its clip's, or the Opacity sheet's draft.
  const pipOpacity = pipShown
    ? pipShown.id === opacityDraftId && opacityDraftValue !== null
      ? opacityDraftValue
      : pipShown.opacity
    : 1;
  useEffect(() => {
    pipOpacitySV.set(pipOpacity);
  }, [pipOpacity, pipOpacitySV]);

  // Tools that aren't built yet (and the ones routed from here).
  const handleComingSoonTool = (key: string) => {
    if (key === "speed" || key === "volume" || key === "opacity") {
      openClipSetting(key);
      return;
    }
    if (key === "rotate") {
      openRotate();
      return;
    }
    if (key === "canvas") {
      openCanvas();
      return;
    }
    if (key === "pip") {
      offerLib(
        ["video", "image"],
        "Add PIP",
        () => void handleAddPip("PIP tool"),
        (item) => void handleAddPip("PIP tool, Lib", item),
      );
      return;
    }
    if (key === "stickers") {
      openStickers("add", "Stickers tool");
      return;
    }
    if (key === "replaceSticker") {
      openStickers("replace", "Replace tool");
      return;
    }
    if (key === "crop") {
      openCrop();
      return;
    }
    if (key === "music") {
      offerLib(
        ["audio"],
        "Add music",
        () => void handleAddAudio("Music tool"),
        (item) => void handleAddAudio("Music tool, Lib", item),
      );
      return;
    }
    if (key === "addText") {
      openAddText("Add text tool");
      return;
    }
    if (key === "editText") {
      openEditText();
      return;
    }
    if (key === "duplicate") {
      handleDuplicate();
      return;
    }
    const demoName = DEMO_ONLY_TOOLS[key];
    if (demoName) {
      if (__DEV__) console.log(`[editor] ${key} — not in the demo (modal)`);
      setDemoFeature(demoName);
      return;
    }
    if (__DEV__)
      console.log(
        `[editor] ${key} on ${selectionKind === "none" ? "project" : `${selectionKind} selection`} — coming soon`,
      );
    setComingSoonVisible(true);
  };

  // ---- Toast (short message over the preview) ---------------------------
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  };
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ---- Capture (camera next to play) ----------------------------------------
  // Saves exactly what the preview shows at the playhead — video, PIP,
  // texts, stickers, rotation, crop, canvas — as a photo in the gallery
  // (react-native-view-shot takes a picture of the frame's box). Without
  // view-shot in the app build (before the rebuild), it falls back to the
  // video file's frame (expo-video-thumbnails: nearest keyframe only).
  const [capturing, setCapturing] = useState(false);
  const nextFrame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const captureFallback = async (t: number): Promise<string | null> => {
    const clip = activeClipAt(videoClips, t);
    if (!clip) return null;
    const sourceTime = timelineToSource(clip, t);
    const shot = await VideoThumbnails.getThumbnailAsync(clip.sourceUri, {
      time: Math.max(0, Math.floor(sourceTime * 1000)),
      quality: 1,
    });
    return shot.uri;
  };
  const handleCapture = async () => {
    if (capturing) return;
    if (cropSetting) {
      showToast("Finish cropping first");
      return;
    }
    if (isPlaying) setIsPlaying(false);
    const t = timelineTime;
    if (!activeClipAt(videoClips, t) && !activeClipAt(pipClips, t)) {
      if (__DEV__)
        console.log(`[editor] capture @ ${t.toFixed(2)}s — no video there`);
      showToast("No video at the playhead");
      return;
    }
    setCapturing(true);
    // No selection outline / handles in the picture.
    if (selectedClipId !== null) setSelectedClipId(null);
    let uri: string | null = null;
    let how = "";
    try {
      if (viewShot && captureFrameRef.current) {
        const shot = viewShot;
        setShotMode(true);
        try {
          // Let the pause settle and the capture layout reach the screen.
          await new Promise((r) => setTimeout(r, 120));
          await nextFrame();
          await nextFrame();
          // The native pictures (main video, PIP video) can't be drawn into
          // a view picture. So: each gives a still of itself (exact), the
          // still is shown in its place for a moment, then the whole frame
          // is taken, where everything is now an ordinary view.
          const f: { main?: string; pip?: string } = {};
          try {
            const main = await previewRef.current?.capture();
            if (main) f.main = main;
          } catch (e) {
            if (__DEV__)
              console.log("[editor] capture — main picture still failed", e);
          }
          const pipNow = activeClipAt(pipClips, t);
          if (pipNow && pipDataOf(pipNow).kind === "video") {
            try {
              const pip = await pipViewRef.current?.capture();
              if (pip) f.pip = pip;
            } catch (e) {
              if (__DEV__)
                console.log("[editor] capture — PIP still failed", e);
            }
          }
          const count = Object.keys(f).length;
          if (count > 0) {
            await new Promise<void>((resolve) => {
              frozenLoadRef.current = { left: count, done: resolve };
              setFrozen(f);
              // Never wait forever for an image.
              setTimeout(resolve, 1500);
            });
            await nextFrame();
            await nextFrame();
          }
          if (f.main) {
            uri = await shot.captureRef(captureFrameRef, {
              format: "jpg",
              quality: 0.95,
              result: "tmpfile",
            });
            how = `preview picture (${count} native still${count === 1 ? "" : "s"})`;
          }
        } catch (e) {
          if (__DEV__)
            console.log(
              "[editor] capture — view-shot failed, using the video frame",
              e,
            );
        } finally {
          frozenLoadRef.current = { left: 0, done: null };
          setFrozen(null);
          setShotMode(false);
        }
      }
      if (!uri) {
        uri = await captureFallback(t);
        how = "video frame (fallback)";
      }
      if (!uri) {
        showToast("No video at the playhead");
        return;
      }
      // Loaded only when used. The legacy API: in this SDK the plain
      // "expo-media-library" functions throw "deprecated".
      const MediaLibrary = await import("expo-media-library/legacy");
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (!permission.granted) {
        if (__DEV__)
          console.log("[editor] capture — gallery permission refused");
        showToast("Allow photo access to save frames");
        return;
      }
      await MediaLibrary.saveToLibraryAsync(uri);
      if (__DEV__)
        console.log(
          `[editor] capture @ ${t.toFixed(2)}s — ${how} saved to gallery`,
        );
      showToast("Frame saved to gallery");
    } catch (e) {
      if (__DEV__) console.log("[editor] capture failed", e);
      showToast("Couldn't save the frame");
    } finally {
      setCapturing(false);
    }
  };

  // ---- Fullscreen preview (expand button) ------------------------------------
  // The same preview, made as big as the screen: the top bar, timeline and
  // toolbar are out of the way; play / pause, capture and ✕ stay.
  const [fullscreen, setFullscreen] = useState(false);
  const enterFullscreen = () => {
    if (
      textEditor ||
      stickerSheet ||
      cropSetting ||
      clipSetting ||
      rotateSetting ||
      canvasDraft
    ) {
      if (__DEV__)
        console.log("[editor] fullscreen — ignored while a sheet is open");
      return;
    }
    if (selectedClipId !== null) setSelectedClipId(null);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    setFullscreen(true);
    if (__DEV__) console.log("[editor] fullscreen on");
  };
  const exitFullscreen = (why: string) => {
    setFullscreen(false);
    if (__DEV__) console.log(`[editor] fullscreen off (${why})`);
  };
  // Android back leaves fullscreen first.
  useEffect(() => {
    if (!fullscreen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      exitFullscreen("back button");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // A trim or move committed on the timeline (finger lifted).
  // Returns whether the project changed.
  const handleClipChange = (clipId: string, range: ClipRange): boolean => {
    const clip = findClip(project, clipId);
    if (!clip) return false;
    const trimChanged =
      range.trimIn !== clip.trimIn || range.trimOut !== clip.trimOut;
    const kind = `${clip.track} ${trimChanged ? "trim" : "move"}`;
    const locked = findLinkedPartner(project, clip) !== null;

    // A move: dropped at `range.start`; the reducer inserts it (nearer edge
    // of the clip it landed on, later clips pushed right — never overlaps).
    // A trim: the new range as-is; the timeline already stopped the handles
    // at the neighbours. Locked: the partner gets the same either way.
    const action: ProjectAction = trimChanged
      ? { type: "UPDATE_CLIP_RANGE", clipId, range }
      : { type: "MOVE_CLIP", clipId, start: range.start };
    const nextProject = commitProject(
      action,
      `${kind}${locked ? ", locked" : ""}`,
    );
    if (__DEV__ && !trimChanged) {
      const landed = findClip(nextProject, clipId);
      const partnerId = findLinkedPartner(project, clip)?.id ?? null;
      const pushed = (["video", "audio"] as const).flatMap((track) =>
        nextProject.tracks[track].filter((c) => {
          const before = findClip(project, c.id);
          return (
            before !== null &&
            c.id !== clipId &&
            c.id !== partnerId &&
            before.start !== c.start
          );
        }),
      );
      console.log(
        `[editor] ${kind} — dropped at ${range.start.toFixed(2)}s, landed at ${landed?.start.toFixed(2)}s${pushed.length > 0 ? `, pushed: ${pushed.map((c) => `${c.id} → ${c.start.toFixed(2)}s`).join(", ")}` : ""}`,
      );
    }

    // The playhead STAYS where it is after a trim or move. If the edit
    // leaves it over empty space, the preview just shows the gap, like any
    // other gap. The only time it has to move: the timeline got shorter
    // than where the playhead sits.
    const nextTimelineDuration = projectEnd(nextProject);
    if (timelineTime > nextTimelineDuration) {
      if (__DEV__)
        console.log(
          `[editor] ${kind} — timeline now ${nextTimelineDuration.toFixed(2)}s, playhead ${timelineTime.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(nextTimelineDuration);
    } else if (__DEV__) {
      console.log(
        `[editor] ${kind} — playhead stays @ ${timelineTime.toFixed(2)}s`,
      );
    }
    return nextProject !== project;
  };

  const clipLabel = videoUri
    ? (videoUri.split("/").pop() ?? "Video clip")
    : "Video clip";
  const isReady = duration > 0 && thumbnailsReady;

  if (!isReady) {
    return <EditorScreenSkeleton />;
  }

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: fullscreen ? "#000000" : colors.background },
      ]}
      onLayout={(e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        setMaxRootHeight((m) => Math.max(m, h));
        setRootHeight(h);
      }}
    >
      {!fullscreen && (
        <EditorTopBar
          resolution={resolutionLabel(demoExportOf(project).resolution)}
          onBack={() => router.back()}
          onHelp={() => {
            pauseForGesture("guide");
            if (__DEV__) console.log("[editor] ? pressed — opening the guide");
            router.push("/guide");
          }}
          onResolutionPress={openExportSettings}
          onExportPress={() => handleExport()}
          onExportLongPress={__DEV__ ? () => handleExport(true) : undefined}
          saveState={saveState}
          onSavePress={handleSavePress}
        />
      )}

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          fullscreen && {
            flexGrow: 1,
            paddingBottom: FULLSCREEN_BAR + insets.bottom,
          },
        ]}
        scrollEnabled={!textGestureActive && !textEditor && !fullscreen}
        onLayout={(e: { nativeEvent: { layout: { y: number } } }) =>
          setTopOffset(e.nativeEvent.layout.y)
        }
      >
        <Pressable
          onPress={() => clearSelection("background")}
          style={fullscreen && styles.fill}
        >
          <View
            style={[
              styles.previewArea,
              fullscreen && [
                styles.previewAreaFull,
                { paddingTop: insets.top + 56 },
              ],
            ]}
          >
            <View
              style={[
                styles.previewBox,
                { backgroundColor: colors.surface },
                editingPreviewHeight !== null && {
                  width: (editingPreviewHeight * 9) / 16,
                  height: editingPreviewHeight,
                },
                fullscreen && styles.previewBoxFull,
              ]}
              onLayout={(e: {
                nativeEvent: { layout: { width: number; height: number } };
              }) =>
                setPreviewSize({
                  width: e.nativeEvent.layout.width,
                  height: e.nativeEvent.layout.height,
                })
              }
            >
              {/* The picture layers, in a box that is the whole preview box
                  normally — and exactly the frame while a capture is taken
                  (the inner box shifts back so nothing moves on screen).
                  The capture takes this box: the frame, nothing around it. */}
              <View
                ref={captureFrameRef}
                collapsable={false}
                pointerEvents="box-none"
                style={
                  shotMode && frame
                    ? frameStyle(frame)
                    : StyleSheet.absoluteFill
                }
              >
                <View
                  pointerEvents="box-none"
                  style={
                    shotMode && frame && previewSize
                      ? {
                          position: "absolute",
                          left: -frame.left,
                          top: -frame.top,
                          width: previewSize.width,
                          height: previewSize.height,
                        }
                      : StyleSheet.absoluteFill
                  }
                >
                  {/* The canvas: its background colour, where the exported
                  frame is (until the native picture is on screen). */}
                  {frame && (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.pictureBackdrop,
                        frameStyle(frame),
                        { backgroundColor: canvas.background },
                      ]}
                    />
                  )}
                  {/* The picture: the native preview, exactly the frame. It
                  draws the whole edit (video, gaps and bars in the canvas
                  colour, opacity, turn, crop) — the texts, stickers and the
                  PIP frame are drawn over it below. */}
                  {frame && NativePreview && (
                    <NativePreview
                      ref={setPreviewRef}
                      pointerEvents="none"
                      collapsable={false}
                      style={frameStyle(frame)}
                      onTime={onTimeEvent}
                      onPlayback={onPlaybackEvent}
                      onEnded={onEndedEvent}
                      onError={(e) => handlePreviewError(e.nativeEvent.message)}
                    />
                  )}
                  {frame && !NativePreview && (
                    <View
                      pointerEvents="none"
                      style={[frameStyle(frame), styles.noPreview]}
                    >
                      <AppText style={styles.noPreviewText}>
                        This app build has the old preview engine. Build the app
                        again to see the new preview.
                      </AppText>
                    </View>
                  )}
                  {/* Capture: a still of the native picture in its place for
                  a moment (see handleCapture). */}
                  {frame && frozen?.main && (
                    <Image
                      source={{ uri: frozen.main }}
                      style={frameStyle(frame)}
                      resizeMode="stretch"
                      fadeDuration={0}
                      onLoad={onFrozenLoad}
                      onError={onFrozenLoad}
                    />
                  )}
                  <TextOverlay
                    items={cropSetting ? [] : visibleTexts}
                    frame={frame}
                    selectedId={selectedTextId}
                    onSelect={handleTextSelect}
                    onEditSelected={handleTextEditSelected}
                    onDelete={handleTextDelete}
                    onTransform={handleTextTransform}
                    onGestureActive={(active) => {
                      // A drag / rotate on a text also ends as a "tap" on the
                      // preview behind it — don't let that deselect the text.
                      lastTextTapAtRef.current = Date.now();
                      setTextGestureActive(active);
                    }}
                  />
                </View>
              </View>
              {cropSetting && picture && (
                <CropOverlay
                  rect={cropSetting.rect}
                  picture={picture}
                  lock={(() => {
                    const r = cropPresetAspect(cropSetting.preset);
                    return r && videoAspect ? videoAspect / r : null;
                  })()}
                  onChange={(rect) =>
                    setCropSetting((c) => (c ? { ...c, rect } : c))
                  }
                />
              )}
            </View>
          </View>

          {!fullscreen && (
            <View style={styles.transportRow}>
              <TouchableOpacity
                onPress={() => handleHistory("undo")}
                disabled={!canUndo}
                accessibilityRole="button"
                accessibilityLabel="Undo"
                accessibilityState={{ disabled: !canUndo }}
                hitSlop={8}
              >
                <Ionicons
                  name="arrow-undo-outline"
                  size={20}
                  color={canUndo ? colors.textPrimary : colors.iconInactive}
                  style={!canUndo && styles.historyDisabled}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleHistory("redo")}
                disabled={!canRedo}
                accessibilityRole="button"
                accessibilityLabel="Redo"
                accessibilityState={{ disabled: !canRedo }}
                hitSlop={8}
              >
                <Ionicons
                  name="arrow-redo-outline"
                  size={20}
                  color={canRedo ? colors.textPrimary : colors.iconInactive}
                  style={!canRedo && styles.historyDisabled}
                />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={togglePlayback}
                style={styles.playButton}
              >
                <Ionicons
                  name={isPlaying ? "pause" : "play"}
                  size={22}
                  color={colors.textPrimary}
                />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleCapture}
                disabled={capturing}
                accessibilityRole="button"
                accessibilityLabel="Save this frame to the gallery"
                hitSlop={8}
              >
                {capturing ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Ionicons
                    name="camera-outline"
                    size={20}
                    color={colors.textPrimary}
                  />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={enterFullscreen}
                accessibilityRole="button"
                accessibilityLabel="Fullscreen preview"
                hitSlop={8}
              >
                <Ionicons
                  name="expand-outline"
                  size={20}
                  color={colors.textPrimary}
                />
              </TouchableOpacity>
            </View>
          )}
        </Pressable>

        {/* Fullscreen: the toolbar and timeline are hidden but stay mounted
            (the timeline keeps its scroll position and zoom). */}
        <View style={fullscreen ? styles.hidden : undefined}>
          {/* The toolbar sits OUTSIDE the tap-to-deselect areas: inside one,
            the wrapper competed with the toolbar's own horizontal scroll
            for the same touch, so scrolling sometimes didn't start or felt
            sticky. Taps on the toolbar never deselect anyway. */}
          {multiSelect ? (
            <MultiSelectBar
              count={liveMultiIds.length}
              onDuplicate={handleDuplicatePicked}
              onDelete={handleDeletePicked}
              onDone={toggleMultiSelect}
            />
          ) : (
            <EditorToolbar
              selectionKind={selectionKind}
              lockMode={lockMode}
              splitEnabled={splitEnabled}
              deleteEnabled={deleteEnabled}
              onUnlock={handleUnlock}
              onSplit={handleSplit}
              onDelete={handleDelete}
              busyToolKey={addingAudio ? "music" : null}
              onEditStart={(key) => {
                // Freeze playback at the tap; the edit lands there after the
                // button's short spinner.
                if (isPlaying) {
                  const at = playhead.uiTimeSV.get();
                  pauseForGesture(key);
                  seekTo(at);
                }
              }}
              onToolPress={handleComingSoonTool}
            />
          )}

          <Pressable onPress={() => clearSelection("background")}>
            <View style={styles.timelineWrap}>
              <EditorTimeline
                clipLabel={clipLabel}
                currentTime={timelineTime}
                isPlaying={isPlaying}
                playhead={playhead}
                stopTimeRef={stopTimeRef}
                timelineDuration={timelineDuration}
                thumbnails={thumbnails}
                thumbnailsBySource={thumbnailsBySource}
                onAddVideoAtStartPress={() =>
                  offerLib(
                    ["video"],
                    "Add a video at the start",
                    () => void handleAddVideo("start"),
                    (item) => void handleAddVideo("start", item),
                  )
                }
                onAddVideoAtEndPress={() =>
                  offerLib(
                    ["video"],
                    "Add a video at the end",
                    () => void handleAddVideo("end"),
                    (item) => void handleAddVideo("end", item),
                  )
                }
                multiSelect={multiSelect}
                multiSelectedIds={liveMultiIds}
                onToggleMultiSelect={toggleMultiSelect}
                onMoveClips={handleMoveClips}
                addingVideo={addingVideo}
                videoClips={videoClips}
                audioClips={audioClips}
                textClips={textClips}
                stickerClips={stickerClips}
                pipClips={pipClips}
                onAddPipPress={() =>
                  offerLib(
                    ["video", "image"],
                    "Add PIP",
                    () => void handleAddPip("empty PIP row"),
                    (item) => void handleAddPip("empty PIP row, Lib", item),
                  )
                }
                onAddStickerPress={() =>
                  openStickers("add", "empty overlay row")
                }
                selectedClipId={selectedClip?.id ?? null}
                onMutePress={toggleAudioMuted}
                audioMuted={audioMuted}
                muteBusy={muteBusy}
                onSelectClip={handleSelectClip}
                onAddTextPress={() => openAddText("empty text row")}
                onAddAudioPress={() =>
                  offerLib(
                    ["audio"],
                    "Add music",
                    () => void handleAddAudio("empty audio row"),
                    (item) => void handleAddAudio("empty audio row, Lib", item),
                  )
                }
                addingAudio={addingAudio}
                flash={flash}
                originalUri={videoUri ?? ""}
                onScrub={handleScrub}
                onScrubStart={handleScrubStart}
                onScrubEnd={handleScrubEnd}
                onClipGestureStart={handleClipGestureStart}
                onZoomButtonPress={handleZoomButtonPress}
                onPinchZoomStart={handlePinchZoomStart}
                onEmptyAreaPress={() => clearSelection("empty timeline area")}
                onClipChange={handleClipChange}
              />
            </View>
          </Pressable>
        </View>
      </ScrollView>

      {/* Fullscreen: a clear way back, top left. */}
      {fullscreen && (
        <TouchableOpacity
          onPress={() => exitFullscreen("✕ button")}
          style={[styles.fullscreenClose, { top: insets.top + 10 }]}
          accessibilityRole="button"
          accessibilityLabel="Exit fullscreen"
          hitSlop={10}
        >
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      )}

      {textEditor && (
        <TextEditorSheet
          mode={textEditor.mode}
          value={textEditor.draft}
          keyboardOpen={keyboardHeight > 0}
          bottomOffset={sheetBottom}
          panelHeight={lastKeyboardHeight}
          onPatch={patchDraft}
          onDone={handleTextDone}
          onCancel={() => closeTextEditor("✕ — cancelled")}
          onHeight={setSheetHeight}
        />
      )}

      {clipSetting && settingClip && (
        <ClipSettingsSheet
          kind={clipSetting.kind}
          value={clipSetting.value}
          sourceLength={settingClip.trimOut - settingClip.trimIn}
          onChange={(value) => setClipSetting((c) => (c ? { ...c, value } : c))}
          onCancel={() => closeClipSetting("cancelled")}
          onDone={applyClipSetting}
        />
      )}

      {stickerSheet && (
        <StickerSheet
          mode={stickerSheet.mode}
          onPick={handleStickerPick}
          onClose={() => closeStickers("✕")}
        />
      )}

      {cropSetting && (
        <CropSheet
          preset={cropSetting.preset}
          presetAspect={cropPresetAspect}
          onPreset={applyCropPreset}
          onReset={() => {
            if (__DEV__) console.log("[editor] crop reset");
            setCropSetting((c) =>
              c ? { ...c, rect: FULL_CROP, preset: "free" } : c,
            );
          }}
          onCancel={() => closeCrop("cancelled")}
          onDone={applyCrop}
        />
      )}

      <OverlayRenderer
        job={overlayJob?.job ?? null}
        onDone={handleOverlaysDone}
      />
      <ExportModal
        plan={exportPlan}
        preparing={overlayJob !== null}
        getProjectInfo={() => ({
          id: projectIdRef.current,
          name: projectNameRef.current,
        })}
        onClose={closeExport}
      />

      {exportDraft && (
        <ExportSettingsSheet
          value={exportDraft}
          frameAspect={frameAspect(canvas, videoAspect)}
          duration={timelineDuration}
          sourceShortSide={
            videoSize ? Math.min(videoSize.width, videoSize.height) : null
          }
          lockedResolutions={DEMO_LOCKED_RESOLUTIONS}
          onLockedPress={(label) => setDemoFeature(label)}
          onChange={setExportDraft}
          onCancel={() => closeExportSettings(false)}
          onDone={() => closeExportSettings(true)}
        />
      )}

      {canvasDraft && (
        <CanvasSheet
          value={canvasDraft}
          videoAspect={videoAspect}
          onChange={setCanvasDraft}
          onCancel={() => closeCanvas("cancelled")}
          onDone={applyCanvas}
          onLockedPress={(label: string) => setDemoFeature(label)}
        />
      )}

      {rotateSetting && (
        <RotateSheet
          angle={rotateSetting.angle}
          flip={rotateSetting.flip}
          onChange={(d) =>
            setRotateSetting((r) =>
              r ? { ...r, angle: d.angle, flip: d.flip } : r,
            )
          }
          onCancel={() => closeRotate("cancelled")}
          onDone={applyRotate}
        />
      )}

      <LibPickerSheet choice={libChoice} onClose={() => setLibChoice(null)} />

      <DemoFeatureModal
        feature={demoFeature}
        onClose={() => setDemoFeature(null)}
      />

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
      {/* Fullscreen controls: pinned to the bottom of the screen, above the
          navigation bar (black — it also covers anything of the editor
          that could show below the preview). The ✕ is top left. */}
      {fullscreen && (
        <>
          <View
            style={[
              styles.fullscreenBar,
              {
                height: FULLSCREEN_BAR + insets.bottom,
                paddingBottom: insets.bottom,
              },
            ]}
          >
            <TouchableOpacity
              onPress={handleCapture}
              disabled={capturing}
              accessibilityRole="button"
              accessibilityLabel="Save this frame to the gallery"
              hitSlop={10}
            >
              {capturing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="camera-outline" size={22} color="#FFFFFF" />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={togglePlayback}
              style={styles.playButton}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? "Pause" : "Play"}
            >
              <Ionicons
                name={isPlaying ? "pause" : "play"}
                size={26}
                color="#FFFFFF"
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => exitFullscreen("button")}
              accessibilityRole="button"
              accessibilityLabel="Exit fullscreen"
              hitSlop={10}
            >
              <Ionicons name="contract-outline" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </>
      )}
      {toast !== null && (
        <View
          pointerEvents="none"
          style={[styles.toast, { top: fullscreen ? insets.top + 64 : 104 }]}
        >
          <AppText style={styles.toastText}>{toast}</AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Undo / redo with nothing to undo / redo: dimmed.
  historyDisabled: { opacity: 0.4 },
  root: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  previewArea: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  // Moved far out of the picture (capture): the hidden player / PIP.
  offCanvas: { left: -100000 },
  toast: {
    position: "absolute",
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.78)",
  },
  toastText: { color: "#FFFFFF", fontSize: 13 },
  fullscreenBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 44,
    backgroundColor: "#000000",
  },
  // Fullscreen: the preview takes all the height the play row leaves.
  fill: { flex: 1 },
  hidden: { display: "none" },
  previewAreaFull: { flex: 1, paddingHorizontal: 0, paddingBottom: 0 },
  previewBoxFull: {
    flex: 1,
    width: "100%",
    aspectRatio: undefined,
    borderRadius: 0,
    backgroundColor: "#000000",
  },
  fullscreenClose: {
    position: "absolute",
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  previewBox: {
    width: "75%",
    aspectRatio: 9 / 16,
    borderRadius: 16,
    overflow: "hidden",
  },
  video: { width: "100%", height: "100%" },
  pictureBackdrop: { position: "absolute", backgroundColor: "#000000" },
  noPreview: {
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    backgroundColor: "#000000",
  },
  noPreviewText: { color: "#FFFFFF", textAlign: "center", fontSize: 13 },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    paddingVertical: 5,
  },
  playButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  timelineWrap: { paddingVertical: 12, paddingBottom: 24 },
});
