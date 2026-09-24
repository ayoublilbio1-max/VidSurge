import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useEffect, useRef, useState } from "react";
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
import EditorToolbar from "../components/editor/EditorToolbar";
import EditorTopBar from "../components/editor/EditorTopBar";
import { useTheme } from "../hooks/useTheme";
import { useTimelineClock, type ClockTrack } from "../hooks/useTimelineClock";
import { useTrackTimelineSync } from "../hooks/useTrackTimelineSync";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [thumbnailsReady, setThumbnailsReady] = useState(false);
  const thumbnailsGeneratedRef = useRef(false);

  const [selection, setSelection] = useState<ClipSelection>(null);
  const [audioLocked, setAudioLocked] = useState(true);

  const [videoTrim, setVideoTrim] = useState<TrimRange>({ start: 0, end: 0 });
  const [audioTrim, setAudioTrim] = useState<TrimRange>({ start: 0, end: 0 });

  const [videoOffset, setVideoOffset] = useState(0);
  const [audioOffset, setAudioOffset] = useState(0);

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

  useEvent(player, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  useEvent(audioPlayer, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  useEffect(() => {
    const id = setInterval(() => {
      if (player.duration > 0) {
        setDuration(player.duration);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [player]);

  useEffect(() => {
    if (duration > 0) {
      setVideoTrim({ start: 0, end: duration });
      setAudioTrim({ start: 0, end: duration });
    }
  }, [duration]);

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

  // ---- Clip bounds on the shared timeline -----------------------------
  const videoClipStart = videoOffset;
  const videoClipEnd = videoOffset + (videoTrim.end - videoTrim.start);
  const audioClipStart = audioOffset;
  const audioClipEnd = audioOffset + (audioTrim.end - audioTrim.start);

  const timelineDuration = Math.max(duration, videoClipEnd, audioClipEnd);

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

  const { timelineTime, seekVersion, seekTo } = useTimelineClock({
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
      setIsPlaying(false);
    }
  };

  const handleScrubStart = () => pauseForGesture("scrub");

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
    const alreadySelected =
      selection === clip || (audioLocked && selection !== null);
    if (alreadySelected) {
      if (__DEV__) console.log(`[editor] ${clip} tapped again — deselecting`);
      setSelection(null);
      return;
    }
    if (__DEV__) console.log(`[editor] select ${clip}`);
    setSelection(clip);
  };

  // Tap on empty space (empty timeline area, video preview, background).
  // Buttons (toolbar, play, zoom...) are touchables of their own, so they
  // take the tap first and never reach this — the selection survives them,
  // which tools like Split/Delete will need.
  const clearSelection = (reason: string) => {
    if (selection === null) return;
    if (__DEV__)
      console.log(`[editor] ${reason} tapped — deselecting ${selection}`);
    setSelection(null);
  };

  // Lock/unlock audio. Also an editing action, so it pauses playback first.
  const handleToggleAudioLock = () => {
    pauseForGesture("audio lock toggle");
    if (__DEV__)
      console.log(`[editor] audio ${audioLocked ? "unlocked" : "locked"}`);
    setAudioLocked((prev) => !prev);
  };

  const handleClipChange = (
    which: "video" | "audio",
    update: { trim: TrimRange; offset: number },
  ) => {
    const prevTrim = which === "video" ? videoTrim : audioTrim;
    const trimChanged =
      update.trim.start !== prevTrim.start || update.trim.end !== prevTrim.end;

    if (audioLocked) {
      setVideoTrim(update.trim);
      setAudioTrim(update.trim);
      setVideoOffset(update.offset);
      setAudioOffset(update.offset);
    } else if (which === "video") {
      setVideoTrim(update.trim);
      setVideoOffset(update.offset);
    } else {
      setAudioTrim(update.trim);
      setAudioOffset(update.offset);
    }

    if (trimChanged) {
      const clipStart = update.offset;
      const clipEnd = update.offset + (update.trim.end - update.trim.start);
      const clamped = clampJS(timelineTime, clipStart, clipEnd);
      if (clamped !== timelineTime) {
        seekTo(clamped);
      }
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
            audioLocked={audioLocked}
            onToggleAudioLock={handleToggleAudioLock}
            onToolPress={() => setComingSoonVisible(true)}
          />

          <View style={styles.timelineWrap}>
            <EditorTimeline
              clipLabel={clipLabel}
              currentTime={timelineTime}
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
