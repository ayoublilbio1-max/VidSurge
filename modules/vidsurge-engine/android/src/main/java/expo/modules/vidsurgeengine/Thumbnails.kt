package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Timeline thumbnails, read by the engine: the EXACT frame at each time
 * (OPTION_CLOSEST — not the nearest keyframe like expo-video-thumbnails),
 * decoded straight at the small size the timeline shows, with one file
 * reader for all of them. Saved as small JPEGs in the cache, reused if the
 * same frame is asked for again.
 */
internal object Thumbnails {
  /** Result: one file uri per time ("" = that frame couldn't be read) + the picture size (upright). */
  fun make(context: Context, uri: String, timesMs: List<Double>, height: Int): Map<String, Any> {
    val startedAt = SystemClock.uptimeMillis()
    val folder = File(context.cacheDir, "vidsurge-thumbs").apply { mkdirs() }
    val key = Integer.toHexString(uri.hashCode())
    val out = ArrayList<String>(timesMs.size)
    val retriever = MediaMetadataRetriever()
    var width = 0
    var heightPx = 0
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      val w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val turned = rotation % 180 != 0
      width = if (turned) h else w
      heightPx = if (turned) w else h
      val thumbH = max(16, height)
      val thumbW = if (width > 0 && heightPx > 0) max(16, (thumbH.toFloat() * width / heightPx).roundToInt()) else thumbH
      for (t in timesMs) {
        val ms = max(0L, t.roundToLong())
        val file = File(folder, "$key-$ms-$thumbH.jpg")
        if (file.exists() && file.length() > 0) {
          out.add("file://${file.absolutePath}")
          continue
        }
        out.add(
          try {
            val frame = readFrame(retriever, ms * 1000, thumbW, thumbH)
            if (frame == null) {
              ""
            } else {
              FileOutputStream(file).use { frame.compress(Bitmap.CompressFormat.JPEG, 80, it) }
              frame.recycle()
              "file://${file.absolutePath}"
            }
          } catch (e: Exception) {
            Log.w(TAG, "[thumbs] frame at ${ms}ms failed", e)
            ""
          },
        )
      }
    } catch (e: Exception) {
      Log.w(TAG, "[thumbs] couldn't open $uri", e)
      while (out.size < timesMs.size) out.add("")
    } finally {
      try {
        retriever.release()
      } catch (e: Exception) {
        // already released
      }
    }
    Log.d(
      TAG,
      "[thumbs] ${out.count { it.isNotEmpty() }}/${timesMs.size} exact frames of ${uri.substringAfterLast('/')} " +
        "(${width}x$heightPx) in ${SystemClock.uptimeMillis() - startedAt}ms",
    )
    return mapOf("uris" to out, "width" to width, "height" to heightPx)
  }

  /** The exact frame at timeUs, about w × h px (aspect kept). */
  private fun readFrame(r: MediaMetadataRetriever, timeUs: Long, w: Int, h: Int): Bitmap? {
    if (Build.VERSION.SDK_INT >= 27) {
      return r.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST, w, h)
    }
    val full = r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST) ?: return null
    val scaled = Bitmap.createScaledBitmap(full, w, h, true)
    if (scaled !== full) full.recycle()
    return scaled
  }
}
