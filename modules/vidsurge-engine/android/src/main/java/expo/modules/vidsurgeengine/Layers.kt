package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.media.ExifInterface
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.OverlaySettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.MatrixTransformation
import androidx.media3.effect.StaticOverlaySettings
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

// The pieces both the preview and the export draw with (TimelineBuilder puts
// them together). Everything a slider can change while the preview is
// paused (turn, mirror, opacity, canvas colour, volume) is read from a
// "look" object at every frame, so the preview shows it right away without
// reloading the video.

internal const val TAG = "VidsurgeEngine"

// ---- Live values ------------------------------------------------------------------

/** One main-video clip's turn / mirror / opacity (written by the app, read per frame). */
internal class ClipLook(rotate: Float, flip: Boolean, opacity: Float) {
  @Volatile var rotate: Float = rotate
  @Volatile var flip: Boolean = flip
  @Volatile var opacity: Float = opacity
}

/** The canvas colour, shared by every clip and gap of one timeline. */
internal class CanvasLook(color: Int) {
  @Volatile var color: Int = color
}

/**
 * How much a clip whose content is cw × ch (after the fit into the frame)
 * must shrink so that, turned by `deg`, it still fits in the frame — the
 * same rule as the old preview (pictureTransform in editor.tsx).
 */
internal fun turnedFit(cw: Float, ch: Float, deg: Float, frameW: Float, frameH: Float): Float {
  if (deg == 0f || cw <= 0f || ch <= 0f) return 1f
  val rad = Math.toRadians(deg.toDouble())
  val c = abs(cos(rad)).toFloat()
  val s = abs(sin(rad)).toFloat()
  return min(1f, min(frameW / (cw * c + ch * s), frameH / (cw * s + ch * c)))
}

// ---- Turn + mirror ------------------------------------------------------------------

/**
 * Turns (clockwise, like the editor) and mirrors a clip that is already
 * fitted into the frame, shrinking it so it stays whole — read from its
 * ClipLook at every frame. The frame keeps its size (frameW × frameH); what
 * the turned clip doesn't cover is see-through (the canvas layer colours it).
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class LiveTransform(
  private val look: ClipLook,
  private val contentW: Float,
  private val contentH: Float,
  private val frameW: Float,
  private val frameH: Float,
) : MatrixTransformation {
  private val matrix = Matrix()

  override fun getMatrix(presentationTimeUs: Long): Matrix {
    val deg = look.rotate
    val mirror = if (look.flip) -1f else 1f
    val fit = turnedFit(contentW, contentH, deg, frameW, frameH)
    // In Media3's -1..1 frame (y up): to pixels, mirror + shrink, turn
    // (negative = clockwise on screen), back to -1..1.
    matrix.reset()
    matrix.setScale(frameW / 2f, frameH / 2f)
    matrix.postScale(fit * mirror, fit)
    matrix.postRotate(-deg)
    matrix.postScale(2f / frameW, 2f / frameH)
    return matrix
  }
}

// ---- Canvas colour + opacity ----------------------------------------------------------

/**
 * The canvas colour over one main clip: opaque where the clip doesn't
 * reach (bars), (1 - opacity) over the clip itself. For a gap (look =
 * null): the canvas colour over the whole frame. Read live from the looks;
 * the picture is only redrawn when something changed.
 *
 * A plain colour is a tiny picture stretched over the frame (overlay
 * scale); a picture with bars is drawn at the frame's size.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class CanvasLayer(
  private val look: ClipLook?,
  private val canvas: CanvasLook,
  private val contentW: Float,
  private val contentH: Float,
  private val frameW: Int,
  private val frameH: Int,
) : BitmapOverlay() {
  private var picture: Bitmap? = null
  private var settings: OverlaySettings = StaticOverlaySettings.Builder().build()
  private var lastKey = ""

  override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings = settings

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    val color = canvas.color or 0xFF000000.toInt()
    val opacity = (look?.opacity ?: 0f).coerceIn(0f, 1f)
    val deg = look?.rotate ?: 0f
    val key = "$color|$opacity|$deg"
    val current = picture
    if (current != null && key == lastKey) return current
    lastKey = key

    val throughAlpha = ((1f - opacity) * 255f).roundToInt().coerceIn(0, 255)
    val rgb = color and 0xFFFFFF
    val next: Bitmap
    if (look == null) {
      next = solid(0xFF000000.toInt() or rgb)
    } else if (rgb == 0 && opacity >= 0.999f) {
      // Black canvas, clip fully opaque: the bars are already black (the
      // frame around the clip is empty) — nothing to draw.
      next = solid(0)
    } else {
      val fit = turnedFit(contentW, contentH, deg, frameW.toFloat(), frameH.toFloat())
      val w = contentW * fit
      val h = contentH * fit
      val straight = abs(deg % 90f) < 0.01f
      val rad = Math.toRadians(deg.toDouble())
      val c = abs(cos(rad)).toFloat()
      val s = abs(sin(rad)).toFloat()
      val coversFrame = straight && w * c + h * s >= frameW - 1f && w * s + h * c >= frameH - 1f
      next =
        if (coversFrame) {
          // No bars: only the opacity lets the colour through.
          solid((throughAlpha shl 24) or rgb)
        } else {
          drawBars(rgb, throughAlpha, w, h, deg)
        }
    }
    picture?.let { if (it !== next) it.recycle() }
    picture = next
    return next
  }

  /** A 4 × 4 picture of one colour, stretched over the whole frame. */
  private fun solid(argb: Int): Bitmap {
    val b = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    b.isPremultiplied = false
    b.setPixels(IntArray(16) { argb }, 0, 4, 0, 0, 4, 4)
    settings = StaticOverlaySettings.Builder().setScale(frameW / 4f, frameH / 4f).build()
    return b
  }

  /** The frame in the colour, with the clip's (turned) place at (1 - opacity). */
  private fun drawBars(rgb: Int, throughAlpha: Int, w: Float, h: Float, deg: Float): Bitmap {
    val drawn = Bitmap.createBitmap(frameW, frameH, Bitmap.Config.ARGB_8888)
    val c = Canvas(drawn)
    c.drawColor(0xFF000000.toInt() or rgb, PorterDuff.Mode.SRC)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC)
      color = (throughAlpha shl 24) or rgb
    }
    val cx = frameW / 2f
    val cy = frameH / 2f
    c.save()
    c.rotate(deg, cx, cy) // clockwise, like the editor
    c.drawRect(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f, paint)
    c.restore()
    settings = StaticOverlaySettings.Builder().build()
    return straightAlphaCopy(drawn)
  }

  override fun release() {
    super.release()
    picture?.recycle()
    picture = null
  }
}

// ---- Volume -----------------------------------------------------------------------------

/**
 * Multiplies the sound by `gain` (0–2), read live. 16-bit and float PCM.
 * Always active, so a volume change while playing applies right away.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class LiveGainProcessor(gain: Float) : BaseAudioProcessor() {
  @Volatile var gain: Float = gain

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
      // Another sample format (rare): the sound passes unchanged rather than
      // stopping the preview / export.
      Log.w(TAG, "volume can't be changed for $inputAudioFormat — left as it is")
      return AudioProcessor.AudioFormat.NOT_SET
    }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val size = inputBuffer.remaining()
    if (size == 0) return
    val input = inputBuffer.order(ByteOrder.nativeOrder())
    val output = replaceOutputBuffer(size)
    val g = gain
    if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT) {
      while (input.remaining() >= 2) {
        val v = (input.short * g).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        output.putShort(v.toShort())
      }
    } else {
      while (input.remaining() >= 4) {
        output.putFloat((input.float * g).coerceIn(-1f, 1f))
      }
    }
    // Any odd leftover byte (never expected) is dropped.
    input.position(input.limit())
    output.flip()
  }
}

// ---- Bitmaps ------------------------------------------------------------------------------

/**
 * A copy of `source` whose pixels are NOT premultiplied. Media3 uploads a
 * bitmap's pixels as they are and blends them as straight alpha — a normal
 * (premultiplied) bitmap would make see-through parts too dark.
 * `source` is recycled.
 */
internal fun straightAlphaCopy(source: Bitmap): Bitmap {
  val w = source.width
  val h = source.height
  val pixels = IntArray(w * h)
  source.getPixels(pixels, 0, w, 0, 0, w, h) // getPixels gives straight ARGB
  source.recycle()
  val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
  out.isPremultiplied = false
  out.setPixels(pixels, 0, w, 0, 0, w, h)
  return out
}

/**
 * `source` drawn to fill exactly w × h px, cut to that shape around its
 * centre (like the preview's "cover"). `source` is not recycled.
 */
internal fun coverInto(source: Bitmap, w: Int, h: Int): Bitmap {
  val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
  val sw = source.width.toFloat()
  val sh = source.height.toFloat()
  val targetAspect = w.toFloat() / h
  val srcRect =
    if (sw / sh > targetAspect) {
      val cutW = sh * targetAspect
      val left = (sw - cutW) / 2f
      Rect(left.roundToInt(), 0, (left + cutW).roundToInt(), sh.toInt())
    } else {
      val cutH = sw / targetAspect
      val top = (sh - cutH) / 2f
      Rect(0, top.roundToInt(), sw.toInt(), (top + cutH).roundToInt())
    }
  val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
  Canvas(out).drawBitmap(source, srcRect, RectF(0f, 0f, w.toFloat(), h.toFloat()), paint)
  return out
}

// ---- Errors -------------------------------------------------------------------------------

/**
 * One line with every cause of an error (outermost first) and the place in
 * the code where the innermost one was thrown.
 */
internal fun describeError(e: Throwable): String {
  val parts = mutableListOf<String>()
  var current: Throwable? = e
  var innermost: Throwable = e
  var depth = 0
  while (current != null && depth < 8) {
    parts.add("${current.javaClass.simpleName}: ${current.message ?: "(no message)"}")
    innermost = current
    current = current.cause
    depth++
  }
  val where = innermost.stackTrace.take(3).joinToString(" < ") {
    "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
  }
  return parts.joinToString(" ← caused by ") + (if (where.isNotEmpty()) " @ $where" else "")
}

// ---- Export only: PIP pictures ------------------------------------------------------------

/**
 * One PIP clip drawn onto the exported video: its picture (exactly pw × ph
 * px) while it's on screen, nothing (a tiny see-through picture) otherwise.
 * Same place / size / turn / opacity as the preview (computed by the app).
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal abstract class PipOverlay(
  protected val startUs: Long,
  protected val endUs: Long,
  protected val pw: Int,
  protected val ph: Int,
  private val settings: StaticOverlaySettings,
) : BitmapOverlay() {
  private val empty: Bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)

  override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings = settings

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    if (presentationTimeUs < startUs - 500 || presentationTimeUs >= endUs - 500) return empty
    return try {
      pictureAt(presentationTimeUs) ?: empty
    } catch (e: Exception) {
      Log.e(TAG, "PIP picture at ${presentationTimeUs / 1000}ms failed", e)
      empty
    }
  }

  /** The picture at this output time (inside the clip's time). */
  protected abstract fun pictureAt(presentationTimeUs: Long): Bitmap?

  /** Closes the file it reads from (called when the export ends). */
  abstract fun closeSource()

  // NOT closing the file here: Media3 releases a layer's GL objects at every
  // cut of the main video (the clip's effects change) and keeps using the
  // layer after — closing the file then froze the PIP on its last frame.
}

/** A photo PIP: read once (turned upright by its EXIF), cut to pw × ph. */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class ImagePipOverlay(
  private val context: Context,
  private val uri: String,
  startUs: Long,
  endUs: Long,
  pw: Int,
  ph: Int,
  settings: StaticOverlaySettings,
) : PipOverlay(startUs, endUs, pw, ph, settings) {
  private var picture: Bitmap? = null
  private var failed = false

  override fun pictureAt(presentationTimeUs: Long): Bitmap? {
    picture?.let { return it }
    if (failed) return null
    val loaded = load()
    if (loaded == null) failed = true
    picture = loaded
    return loaded
  }

  private fun load(): Bitmap? {
    val parsed = Uri.parse(uri)
    val resolver = context.contentResolver
    // Its size first, to read it no bigger than needed.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      Log.e(TAG, "couldn't read PIP photo $uri")
      return null
    }
    val orientation =
      try {
        resolver.openInputStream(parsed)?.use {
          ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } ?: ExifInterface.ORIENTATION_NORMAL
      } catch (e: Exception) {
        ExifInterface.ORIENTATION_NORMAL
      }
    val turned = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
      orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
      orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
      orientation == ExifInterface.ORIENTATION_TRANSVERSE
    val uprightW = if (turned) bounds.outHeight else bounds.outWidth
    val uprightH = if (turned) bounds.outWidth else bounds.outHeight
    var sample = 1
    while (uprightW / (sample * 2) >= pw && uprightH / (sample * 2) >= ph) sample *= 2
    val options = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, options) }
    if (decoded == null) {
      Log.e(TAG, "couldn't decode PIP photo $uri")
      return null
    }
    val upright = applyExif(decoded, orientation)
    val cut = coverInto(upright, pw, ph)
    upright.recycle()
    Log.d(TAG, "  PIP photo ${bounds.outWidth}x${bounds.outHeight} (exif $orientation) → ${pw}x$ph")
    return straightAlphaCopy(cut)
  }

  private fun applyExif(bitmap: Bitmap, orientation: Int): Bitmap {
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
      else -> return bitmap
    }
    val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    if (out !== bitmap) bitmap.recycle()
    return out
  }

  override fun closeSource() {
    // Nothing open: the photo is read in one go.
  }
}

/**
 * A video PIP: its frames are read from the file as the export reaches
 * them, a few at a time (MediaMetadataRetriever.getFramesAtIndex), and cut
 * to pw × ph. Frame numbers come from the file's own frame times
 * (MediaExtractor), so the right frame shows at every moment and speed.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class VideoPipOverlay(
  private val context: Context,
  private val uri: String,
  startUs: Long,
  endUs: Long,
  private val trimInUs: Long,
  private val speed: Float,
  pw: Int,
  ph: Int,
  settings: StaticOverlaySettings,
) : PipOverlay(startUs, endUs, pw, ph, settings) {
  private var retriever: MediaMetadataRetriever? = null
  private var opened = false
  private var failed = false
  /** The file's frame times (µs), in showing order. */
  private var frameTimes: LongArray = LongArray(0)
  private var frameCount = 0
  private var useIndexReader = Build.VERSION.SDK_INT >= 28
  /** The file's turn (some phones give MediaMetadataRetriever frames un-turned). */
  private var fileRotation = 0
  private var codedW = 0
  private var codedH = 0

  private val ready = HashMap<Int, Bitmap>()
  private var currentIndex = -1
  private var current: Bitmap? = null
  private var framesShown = 0
  private var framesRead = 0

  // pictureAt runs on Media3's GL thread, closeSource may run on the main
  // thread (cancel): the file reader is never closed while it's reading.
  @Synchronized
  override fun pictureAt(presentationTimeUs: Long): Bitmap? {
    if (failed) return current
    if (!opened) open()
    val r = retriever ?: return current
    val sourceUs = trimInUs + ((presentationTimeUs - startUs).coerceAtLeast(0L) * speed).toLong()
    val index = indexFor(sourceUs)
    if (index == currentIndex && current != null) return current

    var next: Bitmap? = ready.remove(index)
    if (next == null) {
      // Frames before this one aren't needed any more.
      val stale = ready.keys.filter { it < index }
      for (k in stale) ready.remove(k)?.recycle()
      next = if (useIndexReader && index >= 0) readBatch(r, index) else null
      if (next == null) next = readOne(r, sourceUs, index)
    }
    if (next == null) return current

    val previous = current
    current = next
    currentIndex = index
    // The old picture isn't used by Media3 any more once the new one is
    // returned (it compares by reference, then uploads the new one).
    if (previous != null && previous !== next) previous.recycle()
    framesShown++
    if (framesShown == 1 || framesShown % 120 == 0) {
      Log.d(TAG, "  PIP video frame #$index (${sourceUs / 1000}ms in the file) at ${presentationTimeUs / 1000}ms — $framesRead frame(s) read so far")
    }
    return next
  }

  private fun open() {
    opened = true
    try {
      val r = MediaMetadataRetriever()
      r.setDataSource(context, Uri.parse(uri))
      retriever = r
      fileRotation = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      codedW = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      codedH = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
    } catch (e: Exception) {
      Log.e(TAG, "couldn't open PIP video $uri", e)
      failed = true
      return
    }
    frameTimes = readFrameTimes(context, uri)
    frameCount = frameTimes.size
    if (Build.VERSION.SDK_INT >= 28) {
      val metaCount = retriever?.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toIntOrNull()
      if (metaCount != null && metaCount > 0) frameCount = min(frameCount, metaCount)
    }
    if (frameCount <= 0) useIndexReader = false
    Log.d(TAG, "  PIP video opened: $frameCount frame(s), turn $fileRotation, ${codedW}x$codedH, " + (if (useIndexReader) "read in batches" else "read one by one"))
  }

  /** The last frame shown at or before `sourceUs` (-1 = unknown). */
  private fun indexFor(sourceUs: Long): Int {
    if (frameCount <= 0) return -1
    if (sourceUs + 1000 < frameTimes[0]) return 0
    var lo = 0
    var hi = frameCount - 1
    while (lo < hi) {
      val mid = (lo + hi + 1) / 2
      if (frameTimes[mid] <= sourceUs + 1000) lo = mid else hi = mid - 1
    }
    return lo
  }

  /** Reads frames index… index+N-1 in one go; returns frame `index`. */
  private fun readBatch(r: MediaMetadataRetriever, index: Int): Bitmap? {
    if (Build.VERSION.SDK_INT < 28) return null
    val count = min(BATCH, frameCount - index)
    if (count <= 0) return null
    return try {
      val params = MediaMetadataRetriever.BitmapParams()
      params.setPreferredConfig(Bitmap.Config.RGB_565)
      val frames = r.getFramesAtIndex(index, count, params)
      for ((k, frame) in frames.withIndex()) {
        val cut = fit(frame)
        frame.recycle()
        ready.put(index + k, cut)?.recycle()
        framesRead++
      }
      ready.remove(index)
    } catch (e: Exception) {
      Log.w(TAG, "PIP batch read failed at frame $index — reading one by one from now on", e)
      useIndexReader = false
      null
    }
  }

  /** One frame by time (slower: used if the batch reader can't be used). */
  private fun readOne(r: MediaMetadataRetriever, sourceUs: Long, index: Int): Bitmap? {
    val atUs = if (index >= 0 && index < frameCount) frameTimes[index] else sourceUs
    val frame = r.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST) ?: return null
    val cut = fit(frame)
    frame.recycle()
    framesRead++
    return cut
  }

  /** A frame turned upright (if the phone gave it un-turned) and cut to pw × ph. */
  private fun fit(frame: Bitmap): Bitmap {
    var upright = frame
    val turnedFile = fileRotation % 180 != 0 && codedW != codedH
    if (fileRotation != 0 && codedW > 0 && codedH > 0 &&
      frame.width == codedW && frame.height == codedH && (turnedFile || fileRotation % 360 == 180)
    ) {
      val m = Matrix().apply { postRotate(fileRotation.toFloat()) }
      upright = Bitmap.createBitmap(frame, 0, 0, frame.width, frame.height, m, true)
    }
    val cut = coverInto(upright, pw, ph)
    if (upright !== frame) upright.recycle()
    return cut
  }

  @Synchronized
  override fun closeSource() {
    try {
      retriever?.release()
    } catch (e: Exception) {
      // already released
    }
    retriever = null
    // Reopened if it's needed again.
    opened = false
    for (b in ready.values) b.recycle()
    ready.clear()
  }

  companion object {
    private const val BATCH = 6
  }
}

/** A file's video frame times (µs), sorted (= showing order). Empty if unreadable. */
internal fun readFrameTimes(context: Context, uri: String): LongArray {
  val extractor = MediaExtractor()
  return try {
    setExtractorSource(context, extractor, uri)
    var track = -1
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)
      if (mime != null && mime.startsWith("video/")) {
        track = i
        break
      }
    }
    if (track < 0) return LongArray(0)
    extractor.selectTrack(track)
    val times = ArrayList<Long>()
    while (true) {
      val t = extractor.sampleTime
      if (t < 0) break
      times.add(t)
      if (!extractor.advance()) break
    }
    val out = times.toLongArray()
    out.sort()
    out
  } catch (e: Exception) {
    Log.w(TAG, "couldn't read the frame times of $uri", e)
    LongArray(0)
  } finally {
    extractor.release()
  }
}

internal fun setExtractorSource(context: Context, extractor: MediaExtractor, uri: String) {
  val parsed = Uri.parse(uri)
  if (parsed.scheme == null || parsed.scheme == "file") {
    extractor.setDataSource(parsed.path ?: uri)
  } else {
    extractor.setDataSource(context, parsed, null)
  }
}

// ---- Export only: texts + stickers ------------------------------------------------------------

/** One texts/stickers picture and when it shows (µs, output time). */
internal class OverlaySegment(val startUs: Long, val endUs: Long, val path: String)

/**
 * Texts and stickers over the finished frame: at each frame, the picture
 * of the stretch of time it's in (full frame, transparent around them), or
 * nothing. Pictures are read one at a time, when their stretch starts. The
 * pictures are drawn by the app's own text component (same fonts, styles
 * and places as the preview).
 *
 * They're decoded NOT premultiplied (see straightAlphaCopy).
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class SegmentOverlay(
  private val segments: List<OverlaySegment>,
  private val width: Int,
  private val height: Int,
) : BitmapOverlay() {
  private val empty: Bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
  private var currentIndex = -1
  private var current: Bitmap? = null

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    var index = -1
    for (i in segments.indices) {
      val s = segments[i]
      if (presentationTimeUs >= s.startUs - 500 && presentationTimeUs < s.endUs - 500) {
        index = i
        break
      }
    }
    if (index < 0) return empty
    if (index != currentIndex) {
      current = load(segments[index].path)
      currentIndex = index
      Log.d(TAG, "  texts/stickers picture ${index + 1}/${segments.size} from ${presentationTimeUs / 1000}ms")
    }
    return current ?: empty
  }

  private fun load(path: String): Bitmap? {
    val options = BitmapFactory.Options().apply {
      inPremultiplied = false
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val bitmap = BitmapFactory.decodeFile(path, options)
    if (bitmap == null) {
      Log.e(TAG, "couldn't read texts/stickers picture $path")
      return null
    }
    if (bitmap.width == width && bitmap.height == height) return bitmap
    // Drawn at its own pixel size, centred: it must be the frame's size.
    // (Not expected — the app draws it at that size.)
    Log.w(TAG, "texts/stickers picture ${bitmap.width}x${bitmap.height} → ${width}x$height")
    bitmap.recycle()
    val normal = BitmapFactory.decodeFile(path) ?: return null
    val scaled = Bitmap.createScaledBitmap(normal, width, height, true)
    if (scaled !== normal) normal.recycle()
    return straightAlphaCopy(scaled)
  }
}
