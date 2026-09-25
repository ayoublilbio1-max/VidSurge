import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import ComingSoonModal from "../components/ComingSoonModal";
import EditorScreenSkeleton from "../components/EditorScreenSkeleton";
import EditorTimeline, {
  type ClipSelection,
  type TrimRange,
} from "../components/editor/EditorTimeline";
import EditorToolbar, {
  type LockMode,
} from "../components/editor/EditorToolbar";
import EditorTopBar from "../components/editor/EditorTopBar";
import {
  clipEnd,
  describeClip,
  EMPTY_PROJECT,
  findClip,
  findLinkedPartner,
  projectEnd,
  type Clip,
  type Project,
} from "../editor/clipModel";
import {
  initSourceAction,
  projectReducer,
  type ProjectAction,
} from "../editor/projectReducer";
import { useTheme } from "../hooks/useTheme";
import { useTimelineClock, type ClockTrack } from "../hooks/useTimelineClock";
import { useTrackTimelineSync } from "../hooks/useTrackTimelineSync";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;

const ZERO_TRIM: TrimRange = { start: 0, end: 0 };

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// Step 1a bridge: EditorTimeline and the sync hooks still take one
// trim range + offset per track. These turn a clip back into that shape.
// (Speed is always 1 until the speed tool exists, so trim length and
// timeline length are the same number here. 1b removes this bridge.)
function clipTrim(clip: Clip | null): TrimRange {
  return clip ? { start: clip.trimIn, end: clip.trimOut } : ZERO_TRIM;
}

function summarizeProject(project: Project): string {
  const lines = (["video", "audio"] as const).map((track) => {
    const clips = project.tracks[track];
    return `  ${track}: ${clips.length === 0 ? "(empty)" : clips.map(describeClip).join(" | ")}`;
  });
  return `end ${projectEnd(project).toFixed(2)}s\n${lines.join("\n")}`;
}

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // True while the user is dragging/flinging the timeline. The audio
  // player's seeks are held back during this (see useTrackTimelineSync's
  // `holdSeeks`) and done once, exactly, on release.
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [thumbnailsReady, setThumbnailsReady] = useState(false);
  const thumbnailsGeneratedRef = useRef(false);

  // The whole edit: a list of clips per track (see src/editor/clipModel.ts).
  // Every change goes through projectReducer as one action.
  const [project, dispatchProject] = useReducer(projectReducer, EMPTY_PROJECT);
  // Selection is a clip id now. The timeline still thinks in "video" /
  // "audio" until 1b, so `selection` below is derived from it.
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // Lock is NOT editor state any more: it lives in the clips (a shared
  // linkId = locked). See `audioLocked` / `lockMode` below.

  // Runs an action: computes the result first (the reducer is pure, so this
  // is the same result dispatch will produce), logs it, dispatches it, and
  // returns the new project so callers can react to it in the same tick.
  const commitProject = (action: ProjectAction, reason: string): Project => {
    const next = projectReducer(project, action);
    if (__DEV__) {
      console.log(
        next === project
          ? `[project] ${action.type} (${reason}) — no change`
          : `[project] ${action.type} (${reason})`,
      );
    }
    if (next !== project) dispatchProject(action);
    return next;
  };

  // Full model dump whenever it changes — easy to compare with the old
  // trim/offset logs while testing 1a.
  useEffect(() => {
    if (__DEV__) console.log(`[project] now: ${summarizeProject(project)}`);
  }, [project]);

  // ---- Players -------------------------------------------------------
  // The visual player. Its own embedded audio is muted permanently —
  // sound only ever comes from `audioPlayer` below, which is what lets
  // the "audio" track be dragged to a different timeline position than
  // the video track and actually be heard at that position instead of
  // the video's.
  const player = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });

  // A second, audio-only instance of the same source file. No <VideoView>
  // is mounted for this one — expo-video is able to decode/play just the
  // audio track with no view attached. It is synced independently, off
  // its own `audioOffset` / `audioTrim`.
  const audioPlayer = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
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
            const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
              time: Math.floor(segmentMidpoint * 1000),
            });
            results[i] = uri;
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

  // ---- Clips → the per-track values the timeline/hooks use (1a) --------
  // One clip per track until Split exists (step 2). 1b makes the timeline,
  // clock and sync work on the full clip lists instead.
  const videoClip = project.tracks.video[0] ?? null;
  const audioClip = project.tracks.audio[0] ?? null;

  const videoTrim = clipTrim(videoClip);
  const audioTrim = clipTrim(audioClip);
  const videoOffset = videoClip?.start ?? 0;
  const audioOffset = audioClip?.start ?? 0;

  const videoClipStart = videoOffset;
  const videoClipEnd = videoClip ? clipEnd(videoClip) : 0;
  const audioClipStart = audioOffset;
  const audioClipEnd = audioClip ? clipEnd(audioClip) : 0;

  const timelineDuration = Math.max(duration, projectEnd(project));

  const selectedClip = selectedClipId
    ? findClip(project, selectedClipId)
    : null;
  const selectedPartner = selectedClip
    ? findLinkedPartner(project, selectedClip)
    : null;
  const selection: ClipSelection =
    selectedClip?.track === "video"
      ? "video"
      : selectedClip?.track === "audio"
        ? "audio"
        : null;

  // Whether the video and audio clips are still locked together. The
  // timeline uses this to highlight/trim/move them as one (1a bridge).
  const audioLocked =
    videoClip !== null &&
    audioClip !== null &&
    videoClip.linkId !== null &&
    videoClip.linkId === audioClip.linkId;

  // Lock button: only usable when the selected clip is locked to a partner
  // (tap = unlock, one-way). Greyed out when nothing is selected or the
  // selected clip is already unlocked.
  const lockMode: LockMode = !selectedClip
    ? "none"
    : selectedPartner
      ? "locked"
      : "unlocked";

  // ---- Shared clock + per-track sync ----------------------------------
  const clockTracks: ClockTrack[] = [
    {
      label: "video",
      clipStart: videoClipStart,
      clipEnd: videoClipEnd,
      trimStart: videoTrim.start,
      priority: 0,
      getCurrentTime: () => player.currentTime,
      // Last-resort only: the clock calls this if the video player is stuck
      // on a wrong position for more than ~1.2s.
      resyncTo: (sourceTime) => {
        if (__DEV__)
          console.log(
            `[editor] clock pulled video player to ${sourceTime.toFixed(2)}s`,
          );
        player.currentTime = sourceTime;
      },
    },
    {
      label: "audio",
      clipStart: audioClipStart,
      clipEnd: audioClipEnd,
      trimStart: audioTrim.start,
      priority: 1,
      getCurrentTime: () => audioPlayer.currentTime,
      resyncTo: (sourceTime) => {
        if (__DEV__)
          console.log(
            `[editor] clock pulled audio player to ${sourceTime.toFixed(2)}s`,
          );
        audioPlayer.currentTime = sourceTime;
      },
    },
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

  useTrackTimelineSync({
    label: "video",
    player,
    isPlaying,
    timelineTime,
    seekVersion,
    clipStart: videoClipStart,
    clipEnd: videoClipEnd,
    trimStart: videoTrim.start,
    trimEnd: videoTrim.end,
  });

  useTrackTimelineSync({
    label: "audio",
    player: audioPlayer,
    isPlaying,
    timelineTime,
    seekVersion,
    clipStart: audioClipStart,
    clipEnd: audioClipEnd,
    trimStart: audioTrim.start,
    trimEnd: audioTrim.end,
    holdSeeks: isScrubbing,
  });

  const isVoidNow =
    timelineTime < videoClipStart - 0.001 ||
    timelineTime > videoClipEnd + 0.001;

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
  // Locked: video+audio act as one, so tapping EITHER while they're
  // selected deselects both. Unlocked: tapping the other clip switches the
  // selection to it. Either way, a tap on a clip means "I'm editing now",
  // so playback pauses first.
  const handleSelectClip = (clip: "video" | "audio") => {
    pauseForGesture(`${clip} clip tap`);
    const target = clip === "video" ? videoClip : audioClip;
    if (!target) return;
    // Locked: the tapped clip and its linked partner count as one.
    const alreadySelected =
      selectedClipId === target.id || selectedPartner?.id === target.id;
    if (alreadySelected) {
      if (__DEV__) console.log(`[editor] ${clip} tapped again — deselecting`);
      setSelectedClipId(null);
      return;
    }
    if (__DEV__) console.log(`[editor] select ${clip} (${target.id})`);
    setSelectedClipId(target.id);
  };

  // Tap on empty space (empty timeline area, video preview, background).
  // Buttons (toolbar, play, zoom...) are touchables of their own, so they
  // take the tap first and never reach this — the selection survives them,
  // which tools like Split/Delete will need.
  const clearSelection = (reason: string) => {
    if (selection === null) return;
    if (__DEV__)
      console.log(`[editor] ${reason} tapped — deselecting ${selection}`);
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
      `unlock ${selection}`,
    );
  };

  const handleClipChange = (
    which: "video" | "audio",
    update: { trim: TrimRange; offset: number },
  ) => {
    const clip = which === "video" ? videoClip : audioClip;
    if (!clip) return;
    const trimChanged =
      update.trim.start !== clip.trimIn || update.trim.end !== clip.trimOut;

    // One action for the whole edit. If the clip is locked to a partner,
    // the reducer applies the same range to it (video + audio cut and move
    // together).
    const nextProject = commitProject(
      {
        type: "UPDATE_CLIP_RANGE",
        clipId: clip.id,
        range: {
          start: update.offset,
          trimIn: update.trim.start,
          trimOut: update.trim.end,
        },
      },
      `${which} ${trimChanged ? "trim" : "move"}${audioLocked ? ", locked" : ""}`,
    );

    // The playhead STAYS where it is after a trim or move (it used to jump
    // to the start of the trimmed clip whenever it ended up outside it). If
    // the cut leaves it over empty space, the preview just shows the gap,
    // like any other gap. The only time it has to move: the timeline got
    // shorter than where the playhead sits.
    const nextTimelineDuration = Math.max(duration, projectEnd(nextProject));
    if (timelineTime > nextTimelineDuration) {
      if (__DEV__)
        console.log(
          `[editor] ${which} ${trimChanged ? "trim" : "move"} — timeline now ${nextTimelineDuration.toFixed(2)}s, playhead ${timelineTime.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(nextTimelineDuration);
    } else if (__DEV__) {
      console.log(
        `[editor] ${which} ${trimChanged ? "trim" : "move"} — playhead stays @ ${timelineTime.toFixed(2)}s`,
      );
    }
  };

  const clipLabel = videoUri
    ? (videoUri.split("/").pop() ?? "Video clip")
    : "Video clip";
  const isReady = duration > 0 && thumbnailsReady;

  if (!isReady) {
    return <EditorScreenSkeleton />;
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <EditorTopBar
        resolution="1080P"
        onBack={() => router.back()}
        onHelp={() => setComingSoonVisible(true)}
        onResolutionPress={() => setComingSoonVisible(true)}
        onExportPress={() => setComingSoonVisible(true)}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <Pressable onPress={() => clearSelection("background")}>
          <View style={styles.previewArea}>
            <View
              style={[styles.previewBox, { backgroundColor: colors.surface }]}
            >
              <VideoView
                player={player}
                style={styles.video}
                contentFit="contain"
                nativeControls={false}
              />
              {isVoidNow && (
                <View pointerEvents="none" style={styles.voidOverlay} />
              )}
            </View>
          </View>

          <View style={styles.transportRow}>
            <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
              <Ionicons
                name="arrow-undo-outline"
                size={20}
                color={colors.iconInactive}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
              <Ionicons
                name="arrow-redo-outline"
                size={20}
                color={colors.iconInactive}
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

            <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
              <Ionicons
                name="options-outline"
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

          <EditorToolbar
            lockMode={lockMode}
            onUnlock={handleUnlock}
            onToolPress={() => setComingSoonVisible(true)}
          />

          <View style={styles.timelineWrap}>
            <EditorTimeline
              clipLabel={clipLabel}
              currentTime={timelineTime}
              isPlaying={isPlaying}
              playhead={playhead}
              duration={duration}
              thumbnails={thumbnails}
              selection={selection}
              audioLocked={audioLocked}
              videoTrim={videoTrim}
              audioTrim={audioTrim}
              videoOffset={videoOffset}
              audioOffset={audioOffset}
              onMutePress={() => setComingSoonVisible(true)}
              onSelectClip={handleSelectClip}
              onAddTextPress={() => setComingSoonVisible(true)}
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

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
