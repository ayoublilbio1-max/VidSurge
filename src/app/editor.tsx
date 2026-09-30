import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Image,
  Keyboard,
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
  isEngineAvailable,
  type ExportPlan,
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
  splitIntoPlayerSlots,
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
import { buildExportPlan, overlaySegments } from "../editor/exportPlan";
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
  initSourceAction,
  insertVideoAtStartAction,
  projectReducer,
  splitClipAction,
  type ProjectAction,
} from "../editor/projectReducer";
import { useTheme } from "../hooks/useTheme";
import { useTimelineClock, type ClockTrack } from "../hooks/useTimelineClock";
import { useTrackTimelineSync } from "../hooks/useTrackTimelineSync";
import { hasContent, loadProject, saveProject } from "../lib/projectsStorage";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;

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

/**
 * Where a cropped picture goes in a canvas of cw × ch: the kept part (crop,
 * normalized) is fitted whole and centred — dw × dh at (left, top) — and
 * the whole picture is fw × fh, shifted by (ox, oy) inside that window.
 * No crop = the plain fitted picture. `va` = the video's width ÷ height.
 */
function cropLayout(crop: CropRect, va: number, cw: number, ch: number) {
  "worklet";
  if (!(va > 0) || cw <= 0 || ch <= 0) {
    return { dw: cw, dh: ch, left: 0, top: 0, fw: cw, fh: ch, ox: 0, oy: 0 };
  }
  const ca = (crop.w * va) / crop.h;
  let dw: number;
  let dh: number;
  if (ca > cw / ch) {
    dw = cw;
    dh = cw / ca;
  } else {
    dh = ch;
    dw = ch * ca;
  }
  const fw = dw / crop.w;
  const fh = dh / crop.h;
  return {
    dw,
    dh,
    left: (cw - dw) / 2,
    top: (ch - dh) / 2,
    fw,
    fh,
    ox: -crop.x * fw,
    oy: -crop.y * fh,
  };
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
};

/**
 * Run a call on a video player, ignoring "already released" errors. Leaving
 * the editor while playing releases the players; the timeline clock's
 * clean-up (and a late timer) still paused them → "Cannot use shared object
 * that was already released" red screen.
 */
function safePlayer<T>(fn: () => T, fallback: T, what: string): T {
  try {
    return fn();
  } catch (e) {
    if (__DEV__)
      console.log(
        `[editor] player ${what} skipped — player already released (${String(e).slice(0, 80)})`,
      );
    return fallback;
  }
}

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

/**
 * Transform for a rotated / flipped picture. It is turned about its centre
 * and shrunk just enough to stay whole inside the canvas — like CapCut,
 * nothing is cut off; the canvas background shows around it.
 */
function pictureTransform(
  deg: number,
  flip: number,
  w: number,
  h: number,
  cw: number,
  ch: number,
) {
  "worklet";
  // w × h = the picture (already fitted in the canvas), cw × ch = the
  // canvas. Turned, its bounding box must still fit in the canvas.
  let fit = 1;
  if (deg !== 0 && w > 0 && h > 0 && cw > 0 && ch > 0) {
    const rad = (deg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    fit = Math.min(1, cw / (w * c + h * sn), ch / (w * sn + h * c));
  }
  return [{ rotate: `${deg}deg` }, { scaleX: fit * flip }, { scaleY: fit }];
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
  // True while the user is dragging/flinging the timeline. The audio
  // player's seeks are held back during this (see useTrackTimelineSync's
  // `holdSeeks`) and done once, exactly, on release.
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
  // (see handleCapture) — `shotHiddenSlot` is the video player that isn't
  // on screen, moved out of the picture while it's taken.
  const [shotMode, setShotMode] = useState(false);
  const [shotHiddenSlot, setShotHiddenSlot] = useState<number | null>(null);
  const captureFrameRef = useRef<any>(null);
  // Capture, step 2: each video on screen replaced for a moment by a still
  // picture of itself (see handleCapture). Uri per layer, or null.
  const [frozen, setFrozen] = useState<{
    a?: string;
    b?: string;
    pip?: string;
  } | null>(null);
  const picARef = useRef<any>(null);
  const picBRef = useRef<any>(null);
  const pipPicRef = useRef<any>(null);
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

  // ---- Players -------------------------------------------------------
  // Two players per track that take turns: consecutive clips on a track
  // alternate between player A and player B. While one plays the current
  // clip, the other is already parked on the next clip's first frame and
  // started early, so a cut (a split point, reordered parts) needs no seek
  // — we just switch which player you see / hear. With one player per
  // track, every cut to a different part of the source was a 0.2–0.5s seek
  // (a hitch, then drift corrections).
  //
  // Video players: their own embedded audio is muted permanently — sound
  // only ever comes from the audio players, which is what lets the audio
  // track sit at different timeline positions than the video.
  const videoPlayerA = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  const videoPlayerB = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  // Audio-only instances of the same file (no <VideoView> attached —
  // expo-video can decode/play just the audio).
  const audioPlayerA = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
  });
  const audioPlayerB = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  // The PIP layer's own player (a video from the phone over the main
  // video). Starts empty; each PIP clip's file is loaded into it. Muted
  // until its clip begins (an early start mustn't be heard).
  const pipPlayer = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  const player = videoPlayerA;
  const audioPlayers = [audioPlayerA, audioPlayerB] as const;

  // Which video player is on screen (0 = A, 1 = B). Switched on the UI
  // thread at the exact cut (by the clock), so no React re-render sits
  // between the cut and the new picture.
  const visibleVideoSV = useSharedValue(0);
  // Each video player's picture opacity = the Opacity setting of the clip
  // it is showing (or about to show). Set ahead of the cut (see the
  // effect near the clip settings), so the UI-thread switch shows the new
  // clip at its own opacity straight away.
  const opacityASV = useSharedValue(1);
  const opacityBSV = useSharedValue(1);
  // Same for the Rotate tool: angle (degrees) and mirror (-1 = flipped).
  const rotateASV = useSharedValue(0);
  const rotateBSV = useSharedValue(0);
  const flipASV = useSharedValue(1);
  const flipBSV = useSharedValue(1);
  // And for Crop: the part of the picture each player shows.
  const cropASV = useSharedValue<CropRect>(FULL_CROP);
  const cropBSV = useSharedValue<CropRect>(FULL_CROP);
  // The canvas size in the preview (see `frame`) and the video's shape, for
  // laying out a cropped / turned picture inside it.
  const frameWSV = useSharedValue(0);
  const frameHSV = useSharedValue(0);
  const videoAspectSV = useSharedValue(0);
  const videoAStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropASV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return {
      opacity: visibleVideoSV.value === 0 ? opacityASV.value : 0,
      transform: pictureTransform(
        rotateASV.value,
        flipASV.value,
        l.dw,
        l.dh,
        frameWSV.value,
        frameHSV.value,
      ),
    };
  });
  const videoBStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropBSV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return {
      opacity: visibleVideoSV.value === 1 ? opacityBSV.value : 0,
      transform: pictureTransform(
        rotateBSV.value,
        flipBSV.value,
        l.dw,
        l.dh,
        frameWSV.value,
        frameHSV.value,
      ),
    };
  });
  // The kept part, centred in the canvas (clips the rest)…
  const cropWindowAStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropASV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return { left: l.left, top: l.top, width: l.dw, height: l.dh };
  });
  const cropWindowBStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropBSV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return { left: l.left, top: l.top, width: l.dw, height: l.dh };
  });
  // …and the whole picture behind it, enlarged and shifted so exactly the
  // kept part shows through.
  const cropPictureAStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropASV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return { left: l.ox, top: l.oy, width: l.fw, height: l.fh };
  });
  const cropPictureBStyle = useAnimatedStyle(() => {
    const l = cropLayout(
      cropBSV.value,
      videoAspectSV.value,
      frameWSV.value,
      frameHSV.value,
    );
    return { left: l.ox, top: l.oy, width: l.fw, height: l.fh };
  });

  // Note: there used to be two `useEvent(player, "timeUpdate")`
  // subscriptions here. Their values were never read (the timeline clock
  // reads `player.currentTime` directly every frame), but each event still
  // re-rendered this whole screen ~5x/s per player — 10 wasted full
  // re-renders per second during playback. Removed for smoother playback.

  useEffect(() => {
    const id = setInterval(() => {
      if (player.duration > 0) {
        setDuration(player.duration);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [player]);

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
      const results: (string | null)[] = new Array(THUMBNAIL_COUNT).fill(null);
      let nextIndex = 0;

      const worker = async () => {
        while (true) {
          const i = nextIndex++;
          if (i >= THUMBNAIL_COUNT) return;
          const segmentMidpoint = ((i + 0.5) * duration) / THUMBNAIL_COUNT;
          try {
            const { uri, width, height } =
              await VideoThumbnails.getThumbnailAsync(videoUri, {
                time: Math.floor(segmentMidpoint * 1000),
              });
            results[i] = uri;
            if (i === 0 && width > 0 && height > 0) {
              setVideoSize({ width, height });
              if (__DEV__)
                console.log(`[editor] video picture size ${width}x${height}`);
            }
          } catch {
            results[i] = null;
          }
        }
      };

      const workers = Array.from({ length: THUMBNAIL_CONCURRENCY }, () =>
        worker(),
      );
      await Promise.all(workers);

      setThumbnails(results);
      setThumbnailsReady(true);
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
        const results: (string | null)[] = new Array(THUMBNAIL_COUNT).fill(
          null,
        );
        let next = 0;
        const worker = async () => {
          while (true) {
            const i = next++;
            if (i >= THUMBNAIL_COUNT) return;
            try {
              const shot = await VideoThumbnails.getThumbnailAsync(uri, {
                time: Math.floor(
                  (((i + 0.5) * length) / THUMBNAIL_COUNT) * 1000,
                ),
              });
              results[i] = shot.uri;
            } catch {
              results[i] = null;
            }
          }
        };
        await Promise.all(
          Array.from({ length: THUMBNAIL_CONCURRENCY }, () => worker()),
        );
        if (__DEV__)
          console.log(
            `[editor] thumbnails for ${uri.split("/").pop()} — ${results.filter(Boolean).length}/${THUMBNAIL_COUNT} in ${Date.now() - startedAt}ms`,
          );
        setThumbnailsBySource((m) => ({ ...m, [uri]: results }));
      })();
    }
  }, [otherVideoSources]);

  // ---- Clips on each track -------------------------------------------
  const videoClips = project.tracks.video;
  const audioClips = project.tracks.audio;
  const textClips = project.tracks.text;
  const stickerClips = project.tracks.sticker;
  const pipClips = project.tracks.pip;
  const pipVideoClips = useMemo(
    () => pipClips.filter((c) => pipDataOf(c).kind === "video"),
    [pipClips],
  );

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

  // ---- Clips per player -------------------------------------------------
  // Consecutive clips on a track alternate between the track's two players
  // (clip 0 → A, clip 1 → B, clip 2 → A...), so the next clip's player is
  // free to get ready. Except a clip that simply continues the previous one
  // (the parts of a split, same look): it stays on the same player, which
  // plays straight on across the cut. Handing the picture to the other
  // player there meant starting a second video decoder right at the cut —
  // on the busy dev JS thread it started 0.3–1s late, then got seeked
  // (~1s more), and the picture froze / jumped. See splitIntoPlayerSlots.
  const videoClipsBySlot = useMemo(() => {
    const slots = splitIntoPlayerSlots(videoClips, "video");
    if (__DEV__)
      console.log(
        `[editor] video players — A: ${slots[0].map((c) => c.id).join(", ") || "-"} | B: ${slots[1].map((c) => c.id).join(", ") || "-"}`,
      );
    return slots;
  }, [videoClips]);
  // Audio: a clip that simply continues the previous one (e.g. the two
  // halves of a split) stays on the same player, which plays on across the
  // cut — handing the sound to the other player there could start late
  // (busy JS thread), heard as a short silence, a sped-up catch-up or a
  // lag. See splitIntoPlayerSlots.
  const audioClipsBySlot = useMemo(() => {
    const slots = splitIntoPlayerSlots(audioClips, "audio");
    if (__DEV__)
      console.log(
        `[editor] audio players — A: ${slots[0].map((c) => c.id).join(", ") || "-"} | B: ${slots[1].map((c) => c.id).join(", ") || "-"}`,
      );
    return slots;
  }, [audioClips]);

  // Make a video player the one on screen.
  const showVideoSlot = (slot: number, why: string) => {
    if (visibleVideoSV.get() === slot) return;
    visibleVideoSV.set(slot);
    if (__DEV__)
      console.log(
        `[editor] showing video player ${slot === 0 ? "A" : "B"} (${why})`,
      );
  };
  // Make an audio player the one you hear (the other is muted).
  const hearAudioSlot = (slot: number, why: string) => {
    const done = safePlayer(
      () => {
        if (!audioPlayers[slot].muted && audioPlayers[1 - slot].muted)
          return true;
        audioPlayers[slot].muted = false;
        audioPlayers[1 - slot].muted = true;
        return false;
      },
      true,
      "hear",
    );
    if (done) return;
    if (__DEV__)
      console.log(
        `[editor] hearing audio player ${slot === 0 ? "A" : "B"} (${why})`,
      );
  };

  // Timeline mute button: silences the whole audio track (both audio
  // players) without touching any clip's volume. Not an undo step.
  // The button shows a spinner first (same idea as Split/Delete): the
  // spinner is drawn right away, then the mute is applied — the editor's
  // re-render takes a moment in the dev build, so the tap never looks
  // ignored.
  const [audioMuted, setAudioMuted] = useState(false);
  // For the clock's clip-start callback (it runs outside React renders).
  const audioMutedRef = useRef(audioMuted);
  useEffect(() => {
    audioMutedRef.current = audioMuted;
  }, [audioMuted]);
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

  // ---- Shared clock + per-player sync -----------------------------------
  // One clock entry per clip, reading the player that clip plays on.
  const clockEntries = (
    clips: Clip[],
    p: typeof player,
    slot: number,
    priority: number,
  ): ClockTrack[] =>
    clips.map((clip) => ({
      label: clip.id,
      trackKey: `${clip.track}#${slot}`,
      clipStart: clip.start,
      clipEnd: clipEnd(clip),
      trimStart: clip.trimIn,
      speed: clip.speed,
      priority,
      getCurrentTime: () => safePlayer(() => p.currentTime, NaN, "currentTime"),
      // Used when a player is stuck (ground truth, ~1.2s) or has drifted
      // away from the playhead (the other tracks).
      resyncTo: (sourceTime) => {
        if (__DEV__)
          console.log(
            `[editor] clock pulled ${clip.track} player ${slot === 0 ? "A" : "B"} (${clip.id}) to ${sourceTime.toFixed(2)}s`,
          );
        safePlayer(
          () => {
            p.currentTime = sourceTime;
          },
          undefined,
          "seek",
        );
      },
      pause: () => safePlayer(() => p.pause(), undefined, "pause"),
      play: () => safePlayer(() => p.play(), undefined, "play"),
      setRate: (rate) =>
        safePlayer(
          () => {
            p.playbackRate = rate;
          },
          undefined,
          "rate",
        ),
      activate: () => {
        if (clip.track === "video") {
          showVideoSlot(slot, `${clip.id} begins`);
          return;
        }
        // PIP videos are silent (their sound is not used at all).
        if (clip.track === "pip") return;
        // This clip's volume, right at the cut: a split part with another
        // volume plays on the same player (splitIntoPlayerSlots), and
        // React's re-render would only set it a moment later.
        const volume =
          clip.track === "audio" && audioMutedRef.current
            ? 0
            : Math.max(0, Math.min(1, clip.volume));
        safePlayer(
          () => {
            if (Math.abs(p.volume - volume) > 0.001) {
              p.volume = volume;
              if (__DEV__)
                console.log(
                  `[editor] ${clip.track} player ${clip.track === "pip" ? "" : slot === 0 ? "A " : "B "}volume → ${Math.round(volume * 100)}% at the cut (${clip.id})`,
                );
            }
          },
          undefined,
          "clip start",
        );
        if (clip.track === "audio") hearAudioSlot(slot, `${clip.id} begins`);
      },
      silence:
        clip.track === "audio" || clip.track === "pip"
          ? () =>
              safePlayer(
                () => {
                  p.muted = true;
                },
                undefined,
                "mute",
              )
          : undefined,
    }));
  // Video first (priority 0): the picture is what the playhead follows.
  const clockTracks: ClockTrack[] = [
    ...clockEntries(videoClipsBySlot[0], videoPlayerA, 0, 0),
    ...clockEntries(videoClipsBySlot[1], videoPlayerB, 1, 0),
    ...clockEntries(audioClipsBySlot[0], audioPlayerA, 0, 1),
    ...clockEntries(audioClipsBySlot[1], audioPlayerB, 1, 1),
    // PIP videos: one player, followed last (priority 2).
    ...clockEntries(pipVideoClips, pipPlayer, 0, 2),
  ];

  const { timelineTime, seekVersion, seekTo, playhead, stopTimeRef, halt } =
    useTimelineClock({
      isPlaying,
      timelineDuration,
      tracks: clockTracks,
      onReachEnd: () => {
        if (__DEV__)
          console.log("[editor] timeline reached end, stopping playback");
        setIsPlaying(false);
      },
    });

  // One sync per player, each with its own clips. Entering a clip (paused,
  // scrubbing or playing) makes that player the one you see / hear.
  useTrackTimelineSync({
    label: "video A",
    player: videoPlayerA,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: videoClipsBySlot[0],
    initialUri: videoUri ?? "",
    onEnterClip: () => showVideoSlot(0, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "video B",
    player: videoPlayerB,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: videoClipsBySlot[1],
    initialUri: videoUri ?? "",
    onEnterClip: () => showVideoSlot(1, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "audio A",
    player: audioPlayerA,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: audioClipsBySlot[0],
    trackMuted: audioMuted,
    initialUri: videoUri ?? "",
    holdSeeks: isScrubbing,
    onEnterClip: () => hearAudioSlot(0, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "pip",
    player: pipPlayer,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: pipVideoClips,
    initialUri: "",
    holdSeeks: isScrubbing,
    // PIP videos have no sound: their player stays muted (it was created
    // muted) and at volume 0. Their audio playing next to the main sound
    // was confusing — and during a catch-up it played sped up.
    trackMuted: true,
  });
  useTrackTimelineSync({
    label: "audio B",
    player: audioPlayerB,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: audioClipsBySlot[1],
    trackMuted: audioMuted,
    initialUri: videoUri ?? "",
    holdSeeks: isScrubbing,
    onEnterClip: () => hearAudioSlot(1, "playhead entered its clip"),
  });

  // ---- PIP layer ---------------------------------------------------------
  // The PIP clip under the playhead — or else the next one, or else the
  // last one. The PIP layer (and its video view) stays mounted as long as
  // the project has a PIP: mounting it just before the clip (as before)
  // froze the app for ~1s right at the PIP's start — the PIP then started
  // late, was pulled forward, and the main video stalled too. Shown /
  // hidden on the UI thread from the drawn playhead (React comes ~0.2s
  // late).
  const pipShown =
    activeClipAt(pipClips, timelineTime) ??
    pipClips.find((c) => c.start > timelineTime) ??
    pipClips[pipClips.length - 1] ??
    null;
  const pipStartSV = useSyncedValue(pipShown?.start ?? -1);
  const pipEndSV = useSyncedValue(pipShown ? clipEnd(pipShown) : -1);
  // Its Opacity (live draft while the Opacity sheet is open) — set in the
  // per-player effect near the clip settings.
  const pipOpacitySV = useSharedValue(1);
  const pausedTimeSV = useSyncedValue(timelineTime);
  const pipVisibleStyle = useAnimatedStyle(() => {
    const t = playhead.playingSV.value
      ? playhead.uiTimeSV.value
      : pausedTimeSV.value;
    const on = t >= pipStartSV.value - 0.001 && t < pipEndSV.value;
    return { opacity: on ? pipOpacitySV.value : 0 };
  });

  // Black preview when no video clip is under the playhead. Clip ends count
  // as covered (inclusive), so pausing exactly on the last frame of the
  // timeline still shows it instead of going black.
  const isVoidNow = !videoClips.some(
    (clip) =>
      timelineTime >= clip.start - 0.001 &&
      timelineTime <= clipEnd(clip) + 0.001,
  );

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

  // ---- Transport handlers (thin — the hooks above react to the state
  // changes these make, so there's no manual player.play()/currentTime
  // wiring here anymore) --------------------------------------------------
  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    if (timelineTime >= timelineDuration - 0.001) {
      seekTo(0);
    }

    // Safety net: if a scrub-end was somehow missed, never keep the audio
    // seek on hold once playback starts.
    if (isScrubbing) {
      if (__DEV__)
        console.log("[editor] play pressed while scrub flag set — clearing it");
      setIsScrubbing(false);
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
    if (__DEV__) console.log("[editor] scrub start — holding audio seeks");
    setIsScrubbing(true);
  };

  const handleScrubEnd = () => {
    if (__DEV__) console.log("[editor] scrub end — releasing audio seek");
    setIsScrubbing(false);
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

  // Add music from the phone (the empty audio row's "Add audio", or the
  // Music tool): opens the phone's file picker for audio files, reads the
  // file's length, and adds it as a new unlinked audio clip at the playhead
  // — full length, even past the end of the video. If the playhead is inside
  // another audio clip, it goes to that clip's nearer edge and later clips
  // move right (clips never overlap on a track).
  const handleAddAudio = async (from: string) => {
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
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = result.canceled ? null : result.assets?.[0];
      if (!asset) {
        if (__DEV__) console.log("[editor] add audio — picker cancelled");
        return;
      }
      if (__DEV__)
        console.log(
          `[editor] add audio — picked ${asset.name} (${asset.mimeType ?? "unknown type"})`,
        );
      setAddingAudio(true);
      const duration = await probeDuration(asset.uri);
      if (duration <= 0) {
        Alert.alert(
          "Couldn't add audio",
          "This file couldn't be read. Try another audio file.",
        );
        return;
      }
      const title = asset.name.replace(/\.[^.]+$/, "") || "Music";
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
  const handleAddVideoAtStart = async () => {
    if (addingVideoRef.current) return;
    addingVideoRef.current = true;
    pauseForGesture("add video at start");
    if (__DEV__) console.log("[editor] add video at 0s — opening the gallery");
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        allowsEditing: false,
        quality: 1,
      });
      const asset = result.canceled ? null : result.assets?.[0];
      if (!asset) {
        if (__DEV__) console.log("[editor] add video at 0s — picker cancelled");
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
      const action = insertVideoAtStartAction(asset.uri, length);
      commitProject(action, "add video at start");
      if (action.type === "INSERT_VIDEO_AT_START") {
        flashClips([action.videoClipId, action.audioClipId]);
      }
      setSelectedClipId(null);
      seekTo(0);
      if (__DEV__)
        console.log(
          `[editor] add video at 0s — ${asset.fileName ?? asset.uri.split("/").pop()} (${length.toFixed(2)}s, ${asset.width}×${asset.height}); everything else moved right by ${length.toFixed(2)}s`,
        );
    } catch (error) {
      if (__DEV__) console.log("[editor] add video at 0s failed", error);
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
  const handleAddPip = async (from: string) => {
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
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsEditing: false,
        quality: 1,
      });
      const asset = result.canceled ? null : result.assets?.[0];
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
          ref={pipPicRef}
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
              <VideoView
                player={pipPlayer}
                style={[styles.video, frozen?.pip ? styles.offCanvas : null]}
                contentFit="cover"
                nativeControls={false}
                surfaceType="textureView"
              />
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
  } | null>(null);
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
    setExportPlan({ ...pending.plan, overlays });
  };
  const closeExport = () => {
    setOverlayJob(null);
    setExportPlan(null);
  };
  const handleExport = () => {
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
    if (__DEV__)
      console.log(
        `[editor] export start — ${plan.width}x${plan.height} ${plan.fps}fps, ${plan.pip.length} PIP, ${segments.length} text/sticker stretch(es)`,
      );
    if (segments.length === 0) {
      setExportPlan(plan);
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

  // Picture opacity of each video player: the clip under the playhead on
  // that player, or — in a gap — its next clip (the clock starts players
  // early, before React knows the clip has begun). While the Opacity
  // sheet is open, its draft value is shown live for that clip.
  const opacityDraftId =
    clipSetting?.kind === "opacity" ? clipSetting.clipId : null;
  const opacityDraftValue =
    clipSetting?.kind === "opacity" ? clipSetting.value : null;
  const isCropping = cropSetting !== null;
  // The whole video's crop (Crop tool), shown by every video clip.
  const frameCrop = canvas.crop ?? null;
  const rotateDraftId = rotateSetting?.clipId ?? null;
  const rotateDraftAngle = rotateSetting?.angle ?? 0;
  const rotateDraftFlip = rotateSetting?.flip ?? false;
  useEffect(() => {
    const svs = [opacityASV, opacityBSV];
    const rotSVs = [rotateASV, rotateBSV];
    const flipSVs = [flipASV, flipBSV];
    const cropSVs = [cropASV, cropBSV];
    for (const slot of [0, 1]) {
      const clips = videoClipsBySlot[slot];
      const clip =
        activeClipAt(clips, timelineTime) ??
        clips.find((c) => c.start > timelineTime) ??
        null;
      // The whole video's crop — the same for every clip, so it's set on
      // both players even when one has no clip nearby (it was left stale
      // there until React caught up, and could flash the old framing at the
      // cut). While cropping: the whole picture (the crop box is drawn over).
      const crop = isCropping ? FULL_CROP : (frameCrop ?? FULL_CROP);
      const cur = cropSVs[slot].get();
      if (
        cur.x !== crop.x ||
        cur.y !== crop.y ||
        cur.w !== crop.w ||
        cur.h !== crop.h
      ) {
        cropSVs[slot].set(crop);
        if (__DEV__)
          console.log(
            `[editor] video player ${slot === 0 ? "A" : "B"} crop → ${crop === FULL_CROP ? "whole picture" : `${crop.x},${crop.y} ${crop.w}×${crop.h}`}${isCropping ? " (cropping)" : ""}`,
          );
      }
      if (!clip) continue;
      // Rotation / flip (draft while the Rotate sheet is open).
      const isRotDraft = clip.id === rotateDraftId;
      const angle = isCropping
        ? 0
        : isRotDraft
          ? rotateDraftAngle
          : clip.rotate;
      const flip = (
        isCropping ? false : isRotDraft ? rotateDraftFlip : !!clip.flipX
      )
        ? -1
        : 1;
      if (rotSVs[slot].get() !== angle || flipSVs[slot].get() !== flip) {
        rotSVs[slot].set(angle);
        flipSVs[slot].set(flip);
        if (__DEV__)
          console.log(
            `[editor] video player ${slot === 0 ? "A" : "B"} rotate → ${angle}°${flip < 0 ? ", flipped" : ""} (${clip.id}${isRotDraft ? ", preview" : ""})`,
          );
      }
      const opacity =
        clip.id === opacityDraftId && opacityDraftValue !== null
          ? opacityDraftValue
          : clip.opacity;
      if (Math.abs(svs[slot].get() - opacity) > 0.001) {
        svs[slot].set(opacity);
        if (__DEV__)
          console.log(
            `[editor] video player ${slot === 0 ? "A" : "B"} opacity → ${Math.round(opacity * 100)}% (${clip.id}${clip.id === opacityDraftId ? ", preview" : ""})`,
          );
      }
    }
  }, [
    timelineTime,
    videoClipsBySlot,
    opacityDraftId,
    opacityDraftValue,
    opacityASV,
    opacityBSV,
    rotateDraftId,
    rotateDraftAngle,
    rotateDraftFlip,
    isCropping,
    frameCrop,
    cropASV,
    cropBSV,
    rotateASV,
    rotateBSV,
    flipASV,
    flipBSV,
  ]);

  // The PIP layer's opacity: its clip's, or the Opacity sheet's draft.
  const pipOpacity = pipShown
    ? pipShown.id === opacityDraftId && opacityDraftValue !== null
      ? opacityDraftValue
      : pipShown.opacity
    : 1;
  useEffect(() => {
    pipOpacitySV.set(pipOpacity);
  }, [pipOpacity, pipOpacitySV]);

  // Canvas size + video shape, for laying out a cropped / rotated picture.
  const frameW = frame?.width ?? 0;
  const frameH = frame?.height ?? 0;
  useEffect(() => {
    frameWSV.set(frameW);
    frameHSV.set(frameH);
    videoAspectSV.set(videoAspect ?? 0);
  }, [frameW, frameH, videoAspect, frameWSV, frameHSV, videoAspectSV]);

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
      void handleAddPip("PIP tool");
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
      void handleAddAudio("Music tool");
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
        const hidden = visibleVideoSV.get() === 0 ? 1 : 0;
        setShotHiddenSlot(hidden);
        setShotMode(true);
        try {
          // Let the pause settle and the capture layout reach the screen.
          await new Promise((r) => setTimeout(r, 120));
          await nextFrame();
          await nextFrame();
          // A video view can't be drawn into a picture properly (view-shot
          // draws it on top of everything, and turned / scaled ones in the
          // wrong place — the rotated video moved). So: take a still of
          // each video on screen by itself (untransformed — exact), show
          // the still in its place for a moment, then take the whole
          // frame, where everything is now an ordinary view.
          const still = async (ref: { current: unknown }) =>
            ref.current
              ? await shot.captureRef(ref, { format: "png", result: "tmpfile" })
              : undefined;
          const f: { a?: string; b?: string; pip?: string } = {};
          if (activeClipAt(videoClips, t)) {
            if (hidden === 1) f.a = await still(picARef);
            else f.b = await still(picBRef);
          }
          const pipNow = activeClipAt(pipClips, t);
          if (pipNow && pipDataOf(pipNow).kind === "video")
            f.pip = await still(pipPicRef);
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
          uri = await shot.captureRef(captureFrameRef, {
            format: "jpg",
            quality: 0.95,
            result: "tmpfile",
          });
          how = `preview picture (${count} video still${count === 1 ? "" : "s"})`;
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
          setShotHiddenSlot(null);
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
          onHelp={() => setComingSoonVisible(true)}
          onResolutionPress={openExportSettings}
          onExportPress={handleExport}
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
                  frame is. Shows around a picture that doesn't fill it
                  (other shape, rotated) and through lowered Opacity — as
                  it will in the exported video. */}
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
                  {/* Two stacked video views, one per video player; only the
                  active one is visible. TextureView (not the default
                  SurfaceView) so they can be layered and faded on Android. */}
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      frame ? frameStyle(frame) : StyleSheet.absoluteFill,
                      videoAStyle,
                      shotMode && shotHiddenSlot === 0 && styles.offCanvas,
                    ]}
                  >
                    <Animated.View
                      style={[styles.cropWindow, cropWindowAStyle]}
                    >
                      <Animated.View
                        ref={picARef}
                        collapsable={false}
                        style={[styles.cropPicture, cropPictureAStyle]}
                      >
                        {frozen?.a && (
                          <Image
                            source={{ uri: frozen.a }}
                            style={StyleSheet.absoluteFill}
                            resizeMode="stretch"
                            fadeDuration={0}
                            onLoad={onFrozenLoad}
                            onError={onFrozenLoad}
                          />
                        )}
                        <VideoView
                          player={videoPlayerA}
                          style={[
                            styles.video,
                            frozen?.a ? styles.offCanvas : null,
                          ]}
                          contentFit="contain"
                          nativeControls={false}
                          surfaceType="textureView"
                        />
                      </Animated.View>
                    </Animated.View>
                  </Animated.View>
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      frame ? frameStyle(frame) : StyleSheet.absoluteFill,
                      videoBStyle,
                      shotMode && shotHiddenSlot === 1 && styles.offCanvas,
                    ]}
                  >
                    <Animated.View
                      style={[styles.cropWindow, cropWindowBStyle]}
                    >
                      <Animated.View
                        ref={picBRef}
                        collapsable={false}
                        style={[styles.cropPicture, cropPictureBStyle]}
                      >
                        {frozen?.b && (
                          <Image
                            source={{ uri: frozen.b }}
                            style={StyleSheet.absoluteFill}
                            resizeMode="stretch"
                            fadeDuration={0}
                            onLoad={onFrozenLoad}
                            onError={onFrozenLoad}
                          />
                        )}
                        <VideoView
                          player={videoPlayerB}
                          style={[
                            styles.video,
                            frozen?.b ? styles.offCanvas : null,
                          ]}
                          contentFit="contain"
                          nativeControls={false}
                          surfaceType="textureView"
                        />
                      </Animated.View>
                    </Animated.View>
                  </Animated.View>
                  {isVoidNow && (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.voidOverlay,
                        frame && frameStyle(frame),
                        { backgroundColor: canvas.background },
                      ]}
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
                onAddVideoAtStartPress={() => void handleAddVideoAtStart()}
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
                onAddPipPress={() => void handleAddPip("empty PIP row")}
                onAddStickerPress={() =>
                  openStickers("add", "empty overlay row")
                }
                selectedClipId={selectedClip?.id ?? null}
                onMutePress={toggleAudioMuted}
                audioMuted={audioMuted}
                muteBusy={muteBusy}
                onSelectClip={handleSelectClip}
                onAddTextPress={() => openAddText("empty text row")}
                onAddAudioPress={() => void handleAddAudio("empty audio row")}
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
  cropWindow: { position: "absolute", overflow: "hidden" },
  cropPicture: { position: "absolute" },
  pictureBackdrop: { position: "absolute", backgroundColor: "#000000" },
  voidOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000000",
  },
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
