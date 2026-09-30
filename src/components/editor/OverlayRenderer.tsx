// Draws the export's texts and stickers into pictures for the engine.
//
// The engine can't lay out text the way React Native does (fonts, outline,
// glow, box...), so the app draws them itself: for each stretch of time
// (overlaySegments) it shows those texts / stickers in a hidden frame the
// shape of the exported video — with the same TextOverlay as the preview,
// so they look and sit exactly the same — and saves it as a transparent
// PNG the size of the exported frame. The engine lays these pictures over
// the video at their times.

import { useEffect, useRef, useState } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import type { OverlaySegment } from "../../editor/exportPlan";
import TextOverlay, { type FrameRect } from "./TextOverlay";

type ViewShotModule = typeof import("react-native-view-shot");
let viewShot: ViewShotModule | null = null;
try {
  viewShot = require("react-native-view-shot") as unknown as ViewShotModule;
} catch {
  viewShot = null;
}

export type OverlayJob = {
  /** Changes for every export (restarts the drawing). */
  id: number;
  segments: OverlaySegment[];
  /** The exported frame, in pixels. */
  pixelWidth: number;
  pixelHeight: number;
};

export type OverlayResult = { uris: string[] } | { error: string };

const noop = () => undefined;

// After a stretch is shown: time for layout, the text's own measuring pass
// (TextOverlay fits big texts) and the UI thread to apply it.
const SETTLE_MS = 220;
const FIRST_SETTLE_MS = 450;

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export default function OverlayRenderer({
  job,
  onDone,
}: {
  job: OverlayJob | null;
  onDone: (result: OverlayResult) => void;
}) {
  const [index, setIndex] = useState(0);
  const shotRef = useRef<any>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!job) return;
    let alive = true;
    const uris: string[] = [];
    const startedAt = Date.now();
    (async () => {
      try {
        if (!viewShot)
          throw new Error("This app build can't draw texts for the export.");
        for (let i = 0; i < job.segments.length; i++) {
          setIndex(i);
          await nextFrame();
          await nextFrame();
          await wait(i === 0 ? FIRST_SETTLE_MS : SETTLE_MS);
          if (!alive) return;
          const uri = await viewShot.captureRef(shotRef, {
            format: "png",
            result: "tmpfile",
            width: job.pixelWidth,
            height: job.pixelHeight,
          });
          if (!alive) return;
          uris.push(uri);
          const s = job.segments[i];
          if (__DEV__)
            console.log(
              `[overlay] ${i + 1}/${job.segments.length} ${s.start.toFixed(2)}–${s.end.toFixed(2)}s (${s.items.length} item(s)) → ${uri.split("/").pop()}`,
            );
        }
        if (__DEV__)
          console.log(
            `[overlay] ${uris.length} picture(s) at ${job.pixelWidth}x${job.pixelHeight} in ${Date.now() - startedAt}ms`,
          );
        if (alive) onDoneRef.current({ uris });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (__DEV__) console.log("[overlay] drawing failed", message);
        if (alive) onDoneRef.current({ error: message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [job]);

  if (!job) return null;
  const segment = job.segments[Math.min(index, job.segments.length - 1)];
  const ratio = PixelRatio.get();
  const frame: FrameRect = {
    left: 0,
    top: 0,
    width: job.pixelWidth / ratio,
    height: job.pixelHeight / ratio,
  };

  return (
    <View
      ref={shotRef}
      collapsable={false}
      pointerEvents="none"
      style={[styles.hidden, { width: frame.width, height: frame.height }]}
    >
      <TextOverlay
        items={segment ? segment.items : []}
        frame={frame}
        selectedId={null}
        onSelect={noop}
        onEditSelected={noop}
        onDelete={noop}
        onTransform={noop}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Far off screen: never seen, but laid out and drawable.
  hidden: {
    position: "absolute",
    left: -100000,
    top: 0,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
});
