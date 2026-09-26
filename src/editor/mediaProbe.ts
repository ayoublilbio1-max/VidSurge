import { createVideoPlayer } from "expo-video";

/**
 * Length (seconds) of a media file — audio or video — or 0 if it can't be
 * read in time. Loads it in a throwaway player (never shown or heard) just
 * to read its duration, then releases it.
 */
export async function probeDuration(
  uri: string,
  timeoutMs = 8000,
): Promise<number> {
  const player = createVideoPlayer(uri);
  player.muted = true;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const d = player.duration;
      if (typeof d === "number" && d > 0 && Number.isFinite(d)) {
        if (__DEV__)
          console.log(
            `[mediaProbe] ${uri.split("/").pop()} — ${d.toFixed(2)}s (read in ${Date.now() - startedAt}ms)`,
          );
        return d;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (__DEV__)
      console.log(
        `[mediaProbe] ${uri.split("/").pop()} — no duration after ${timeoutMs}ms`,
      );
    return 0;
  } finally {
    player.release();
  }
}
