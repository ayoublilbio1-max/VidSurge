import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
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
import ComingSoonModal from "../components/ComingSoonModal";
import EditorScreenSkeleton from "../components/EditorScreenSkeleton";
import ClipSettingsSheet, {
  type ClipSettingKind,
} from "../components/editor/ClipSettingsSheet";
import EditorTimeline from "../components/editor/EditorTimeline";
import EditorToolbar, {
  type LockMode,
  type SelectionKind,
} from "../components/editor/EditorToolbar";
import EditorTopBar from "../components/editor/EditorTopBar";
import TextEditorSheet, {
  MIN_PANEL_HEIGHT,
} from "../components/editor/TextEditorSheet";
import TextOverlay, {
  type FrameRect,
  type TextTransform,
} from "../components/editor/TextOverlay";
import {
  activeClipAt,
  canSplitAt,
  clipContains,
  clipEnd,
  DEFAULT_TEXT_DATA,
  describeClip,
  EMPTY_PROJECT,
  findClip,
  findLinkedPartner,
  projectEnd,
  splitIntoPlayerSlots,
  textDataOf,
  type Clip,
  type ClipRange,
  type Project,
  type TextClipData,
} from "../editor/clipModel";
import { preloadAllFonts, useFontsVersion } from "../editor/fonts";
import { createHistory, historyReducer } from "../editor/history";
import { probeDuration } from "../editor/mediaProbe";
import {
  addAudioClipAction,
  addTextClipAction,
  duplicateClipAction,
  initSourceAction,
  projectReducer,
  splitClipAction,
  type ProjectAction,
} from "../editor/projectReducer";
import { useTheme } from "../hooks/useTheme";
import { useTimelineClock, type ClockTrack } from "../hooks/useTimelineClock";
import { useTrackTimelineSync } from "../hooks/useTrackTimelineSync";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function summarizeProject(project: Project): string {
  const lines = (["video", "audio", "text"] as const).map((track) => {
    const clips = project.tracks[track];
    return `  ${track}: ${clips.length === 0 ? "(empty)" : clips.map(describeClip).join(" | ")}`;
  });
  return `end ${projectEnd(project).toFixed(2)}s\n${lines.join("\n")}`;
}

// How long the mute button shows its spinner before the mute applies.
const MUTE_SPINNER_MS = 250;

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
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
  const videoAStyle = useAnimatedStyle(() => ({
    opacity: visibleVideoSV.value === 0 ? opacityASV.value : 0,
  }));
  const videoBStyle = useAnimatedStyle(() => ({
    opacity: visibleVideoSV.value === 1 ? opacityBSV.value : 0,
  }));

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
    if (duration > 0 && videoUri) {
      commitProject(initSourceAction(videoUri, duration), "source loaded");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, videoUri]);

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

  // ---- Clips on each track -------------------------------------------
  const videoClips = project.tracks.video;
  const audioClips = project.tracks.audio;
  const textClips = project.tracks.text;

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
      : selectedPartner
        ? "locked"
        : selectedClip.track === "audio"
          ? "audio"
          : "video";

  // ---- Clips per player -------------------------------------------------
  // Consecutive clips on a track alternate between the track's two players
  // (clip 0 → A, clip 1 → B, clip 2 → A...). Tracks are kept sorted by
  // start, so the next clip is always on the other, free player.
  const videoClipsBySlot = useMemo(
    () => [
      videoClips.filter((_, i) => i % 2 === 0),
      videoClips.filter((_, i) => i % 2 === 1),
    ],
    [videoClips],
  );
  // Audio: a clip that simply continues the previous one (e.g. the two
  // halves of a split) stays on the same player, which plays on across the
  // cut — handing the sound to the other player there could start late
  // (busy JS thread), heard as a short silence, a sped-up catch-up or a
  // lag. See splitIntoPlayerSlots.
  const audioClipsBySlot = useMemo(() => {
    const slots = splitIntoPlayerSlots(audioClips);
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
    if (!audioPlayers[slot].muted && audioPlayers[1 - slot].muted) return;
    audioPlayers[slot].muted = false;
    audioPlayers[1 - slot].muted = true;
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
      getCurrentTime: () => p.currentTime,
      // Used when a player is stuck (ground truth, ~1.2s) or has drifted
      // away from the playhead (the other tracks).
      resyncTo: (sourceTime) => {
        if (__DEV__)
          console.log(
            `[editor] clock pulled ${clip.track} player ${slot === 0 ? "A" : "B"} (${clip.id}) to ${sourceTime.toFixed(2)}s`,
          );
        p.currentTime = sourceTime;
      },
      pause: () => p.pause(),
      play: () => p.play(),
      setRate: (rate) => {
        p.playbackRate = rate;
      },
      activate: () =>
        clip.track === "audio"
          ? hearAudioSlot(slot, `${clip.id} begins`)
          : showVideoSlot(slot, `${clip.id} begins`),
      silence:
        clip.track === "audio"
          ? () => {
              p.muted = true;
            }
          : undefined,
    }));
  // Video first (priority 0): the picture is what the playhead follows.
  const clockTracks: ClockTrack[] = [
    ...clockEntries(videoClipsBySlot[0], videoPlayerA, 0, 0),
    ...clockEntries(videoClipsBySlot[1], videoPlayerB, 1, 0),
    ...clockEntries(audioClipsBySlot[0], audioPlayerA, 0, 1),
    ...clockEntries(audioClipsBySlot[1], audioPlayerB, 1, 1),
  ];

  const { timelineTime, seekVersion, seekTo, playhead, halt } =
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
  const handleSelectClip = (clipId: string) => {
    const target = findClip(project, clipId);
    pauseForGesture(`${target?.track ?? "clip"} clip tap`);
    if (!target) return;
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
          `[editor] add audio — "${title}" (${duration.toFixed(2)}s) wanted @ ${at.toFixed(2)}s, placed @ ${added?.start.toFixed(2) ?? "?"}s`,
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
    if (!selectedClip || selectedClip.track !== "text") return;
    pauseForGesture("duplicate");
    const action = duplicateClipAction(selectedClip);
    commitProject(action, "duplicate text");
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
    : selectedClip?.track === "text"
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
    openEditText(id);
  };

  const handleTextDelete = (id: string) => {
    if (id === DRAFT_ID) {
      closeTextEditor("draft deleted (✕)");
      return;
    }
    if (textEditor) closeTextEditor("text deleted (✕)");
    pauseForGesture("delete text");
    commitProject(
      { type: "DELETE_CLIP", clipId: id },
      "delete text (✕ on preview)",
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
  const visibleTexts: { id: string; data: TextClipData }[] = [];
  for (const clip of textClips) {
    if (textEditor?.mode === "edit" && textEditor.clipId === clip.id) {
      visibleTexts.push({ id: clip.id, data: textEditor.draft });
    } else if (clipContains(clip, timelineTime)) {
      visibleTexts.push({ id: clip.id, data: textDataOf(clip) });
    }
  }
  if (textEditor?.mode === "add") {
    visibleTexts.push({
      id: DRAFT_ID,
      data: textEditor.draft.text
        ? textEditor.draft
        : { ...textEditor.draft, text: "Enter text" },
    });
  }

  // Where the video picture sits in the preview box (contentFit "contain").
  let frame: FrameRect | null = null;
  if (previewSize) {
    const { width: bw, height: bh } = previewSize;
    if (videoSize) {
      const aspect = videoSize.width / videoSize.height;
      if (aspect > bw / bh) {
        const h = bw / aspect;
        frame = { left: 0, top: (bh - h) / 2, width: bw, height: h };
      } else {
        const w = bh * aspect;
        frame = { left: (bw - w) / 2, top: 0, width: w, height: bh };
      }
    } else {
      frame = { left: 0, top: 0, width: bw, height: bh };
    }
  }

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
    const target =
      kind === "volume"
        ? halfOn("audio")
        : kind === "opacity"
          ? halfOn("video")
          : selectedClip;
    if (!target) return;
    pauseForGesture(kind);
    if (__DEV__) console.log(`[editor] ${kind} sheet open for ${target.id}`);
    // Opacity is judged by looking at the picture: bring the playhead into
    // the clip if it's elsewhere, so the preview shows the change live.
    if (kind === "opacity" && !clipContains(target, timelineTime)) {
      const into = Math.min(clipEnd(target) - 0.05, target.start + 0.05);
      if (__DEV__)
        console.log(
          `[editor] opacity — playhead ${timelineTime.toFixed(2)}s is outside ${target.id}, moved to ${into.toFixed(2)}s`,
        );
      seekTo(into);
    }
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
  useEffect(() => {
    const svs = [opacityASV, opacityBSV];
    for (const slot of [0, 1]) {
      const clips = videoClipsBySlot[slot];
      const clip =
        activeClipAt(clips, timelineTime) ??
        clips.find((c) => c.start > timelineTime) ??
        null;
      if (!clip) continue;
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
  ]);

  // Tools that aren't built yet (and the ones routed from here).
  const handleComingSoonTool = (key: string) => {
    if (key === "speed" || key === "volume" || key === "opacity") {
      openClipSetting(key);
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
    if (__DEV__)
      console.log(
        `[editor] ${key} on ${selectionKind === "none" ? "project" : `${selectionKind} selection`} — coming soon`,
      );
    setComingSoonVisible(true);
  };

  // Capture (camera next to play): will save the frame under the playhead.
  const handleCapture = () => {
    if (__DEV__)
      console.log(
        `[editor] capture pressed @ ${timelineTime.toFixed(2)}s — coming soon`,
      );
    setComingSoonVisible(true);
  };

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
      style={[styles.root, { backgroundColor: colors.background }]}
      onLayout={(e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        setMaxRootHeight((m) => Math.max(m, h));
        setRootHeight(h);
      }}
    >
      <EditorTopBar
        resolution="1080P"
        onBack={() => router.back()}
        onHelp={() => setComingSoonVisible(true)}
        onResolutionPress={() => setComingSoonVisible(true)}
        onExportPress={() => setComingSoonVisible(true)}
      />

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        scrollEnabled={!textGestureActive && !textEditor}
        onLayout={(e: { nativeEvent: { layout: { y: number } } }) =>
          setTopOffset(e.nativeEvent.layout.y)
        }
      >
        <Pressable onPress={() => clearSelection("background")}>
          <View style={styles.previewArea}>
            <View
              style={[
                styles.previewBox,
                { backgroundColor: colors.surface },
                editingPreviewHeight !== null && {
                  width: (editingPreviewHeight * 9) / 16,
                  height: editingPreviewHeight,
                },
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
              {/* Black behind the picture (only where the picture is), so a
                  clip with lowered Opacity fades to black — as it will in
                  the exported video. */}
              {frame && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.pictureBackdrop,
                    {
                      left: frame.left,
                      top: frame.top,
                      width: frame.width,
                      height: frame.height,
                    },
                  ]}
                />
              )}
              {/* Two stacked video views, one per video player; only the
                  active one is visible. TextureView (not the default
                  SurfaceView) so they can be layered and faded on Android. */}
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, videoAStyle]}
              >
                <VideoView
                  player={videoPlayerA}
                  style={styles.video}
                  contentFit="contain"
                  nativeControls={false}
                  surfaceType="textureView"
                />
              </Animated.View>
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, videoBStyle]}
              >
                <VideoView
                  player={videoPlayerB}
                  style={styles.video}
                  contentFit="contain"
                  nativeControls={false}
                  surfaceType="textureView"
                />
              </Animated.View>
              {isVoidNow && (
                <View pointerEvents="none" style={styles.voidOverlay} />
              )}
              <TextOverlay
                texts={visibleTexts}
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
              accessibilityRole="button"
              accessibilityLabel="Capture frame"
            >
              <Ionicons
                name="camera-outline"
                size={20}
                color={colors.iconInactive}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
              <Ionicons
                name="expand-outline"
                size={20}
                color={colors.iconInactive}
              />
            </TouchableOpacity>
          </View>
        </Pressable>

        {/* The toolbar sits OUTSIDE the tap-to-deselect areas: inside one,
            the wrapper competed with the toolbar's own horizontal scroll
            for the same touch, so scrolling sometimes didn't start or felt
            sticky. Taps on the toolbar never deselect anyway. */}
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

        <Pressable onPress={() => clearSelection("background")}>
          <View style={styles.timelineWrap}>
            <EditorTimeline
              clipLabel={clipLabel}
              currentTime={timelineTime}
              isPlaying={isPlaying}
              playhead={playhead}
              timelineDuration={timelineDuration}
              thumbnails={thumbnails}
              videoClips={videoClips}
              audioClips={audioClips}
              textClips={textClips}
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
      </ScrollView>

      {textEditor && (
        <TextEditorSheet
          mode={textEditor.mode}
          value={textEditor.draft}
          keyboardOpen={keyboardHeight > 0}
          bottomOffset={sheetBottom}
          panelHeight={lastKeyboardHeight}
          onPatch={patchDraft}
          onDone={handleTextDone}
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

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
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
  previewBox: {
    width: "75%",
    aspectRatio: 9 / 16,
    borderRadius: 16,
    overflow: "hidden",
  },
  video: { width: "100%", height: "100%" },
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
