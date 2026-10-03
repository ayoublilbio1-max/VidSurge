package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Crop
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Who the timeline is built for: the preview player or the export. */
internal enum class BuildMode { PREVIEW, EXPORT }

/** A built timeline and the live values its effects read (see Layers.kt). */
internal class BuiltTimeline(
  val composition: Composition,
  /** Main-video clip id → its turn / mirror / opacity. */
  val looks: Map<String, ClipLook>,
  val canvas: CanvasLook,
  /** Audio clip id → its volume. */
  val gains: Map<String, LiveGainProcessor>,
  val durationUs: Long,
)

/** What a media file is: picture size (upright), length, whether it has sound. */
internal class MediaInfo(val width: Int, val height: Int, val durationUs: Long, val hasAudio: Boolean)

/**
 * Builds a Media3 timeline (Composition) from the app's plan — the SAME
 * code for the preview (CompositionPlayer) and the export (Transformer), so
 * both show the same thing:
 *   - main video: one picture track. Each clip trimmed, sped up / slowed,
 *     cropped (canvas crop), fitted into the frame, turned / mirrored
 *     (LiveTransform) and laid under the canvas colour layer (CanvasLayer:
 *     bars + opacity). Gaps = the canvas colour.
 *   - sound: the audio clips, packed into as few tracks as possible
 *     (clips that don't overlap share one), silence between them; each with
 *     its speed (pitch kept) and volume (LiveGainProcessor, 0–200%).
 * PIP and texts are added by the caller (preview: native PIP view + the
 * app's texts; export: overlays).
 *
 * Speed: the preview player needs EditedMediaItem.setSpeed; the export
 * uses it for sound too, but a muted video with setSpeed would wait forever
 * for sound in Transformer — so the export's video uses SpeedChangeEffect.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal object TimelineBuilder {
  private val probes = ConcurrentHashMap<String, MediaInfo>()

  /**
   * @param topEffects effects over the whole finished picture (export: PIP
   *   and texts overlays). The preview has none.
   */
  fun build(
    context: Context,
    plan: JSONObject,
    mode: BuildMode,
    topEffects: List<Effect> = listOf(),
  ): BuiltTimeline {
    val width = plan.getInt("width")
    val height = plan.getInt("height")
    val fps = plan.optDouble("fps", 30.0).toFloat().let { if (it > 0f) it else 30f }
    val canvas = CanvasLook(parseColor(plan.optString("background", "#000000")))
    val crop = plan.optJSONObject("crop")
    val duration = plan.optDouble("duration", 0.0)
    val video = plan.optJSONArray("video") ?: JSONArray()
    val audio = plan.optJSONArray("audio") ?: JSONArray()

    val presentation = Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT)

    // The canvas crop (normalized 0–1, top-left origin) → Media3's -1..1, y up.
    var cropW = 1f
    var cropH = 1f
    var cropEffect: Crop? = null
    if (crop != null) {
      val x = crop.getDouble("x").toFloat()
      val y = crop.getDouble("y").toFloat()
      cropW = crop.getDouble("w").toFloat()
      cropH = crop.getDouble("h").toFloat()
      cropEffect = Crop(-1f + 2f * x, -1f + 2f * (x + cropW), 1f - 2f * (y + cropH), 1f - 2f * y)
    }

    // ---- Main video ----
    val looks = HashMap<String, ClipLook>()
    val videoItems = mutableListOf<EditedMediaItem>()
    var mainUs = 0L
    for (i in 0 until video.length()) {
      val item = video.getJSONObject(i)
      when (item.getString("type")) {
        "gap" -> {
          val ms = (item.getDouble("duration") * 1000).roundToLong()
          if (ms <= 0) continue
          videoItems.add(gapItem(context, ms, fps, presentation, canvas, width, height))
          mainUs += ms * 1000
        }
        "clip" -> {
          val id = item.optString("id", "clip-$i")
          val uri = item.getString("uri")
          val (trimInUs, trimOutUs) = clipRangeUs(item.getDouble("trimIn"), item.getDouble("trimOut"), mode)
          if (trimOutUs <= trimInUs) continue
          val speed = item.optDouble("speed", 1.0).toFloat().let { if (it > 0f) it else 1f }
          val look = ClipLook(
            item.optDouble("rotate", 0.0).toFloat(),
            item.optBoolean("flipX", false),
            item.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f),
          )
          looks[id] = look
          val info = probe(context, uri)
          // The clip's content size once fitted into the frame (as Media3's
          // Crop → Presentation(fit) make it).
          var cw = width.toFloat()
          var ch = height.toFloat()
          if (info != null && info.width > 0 && info.height > 0) {
            val srcW = max(1f, (info.width * cropW).roundToInt().toFloat())
            val srcH = max(1f, (info.height * cropH).roundToInt().toFloat())
            val s = min(width / srcW, height / srcH)
            cw = srcW * s
            ch = srcH * s
          }

          val effects = mutableListOf<Effect>()
          cropEffect?.let { effects.add(it) }
          if (mode == BuildMode.EXPORT) {
            if (speed != 1f) effects.add(SpeedChangeEffect(speed))
            effects.add(FrameDropEffect.createDefaultFrameDropEffect(fps))
          }
          effects.add(presentation)
          effects.add(LiveTransform(look, cw, ch, width.toFloat(), height.toFloat()))
          effects.add(
            OverlayEffect(listOf<TextureOverlay>(CanvasLayer(look, canvas, cw, ch, width, height))),
          )

          val builder = EditedMediaItem.Builder(clippedItem(uri, trimInUs, trimOutUs))
            .setRemoveAudio(true)
            .setEffects(Effects(listOf(), effects))
            .setDurationUs(sourceDurationUs(info, item, trimOutUs))
          if (mode == BuildMode.PREVIEW && speed != 1f) builder.setSpeed(ConstantSpeed(speed))
          videoItems.add(builder.build())
          mainUs += ((trimOutUs - trimInUs) / speed).roundToLong()
          Log.d(
            TAG,
            "  [$mode] video $id ${trimInUs / 1000}–${trimOutUs / 1000}ms x$speed, rotate ${look.rotate}" +
              "${if (look.flip) " mirrored" else ""}, opacity ${look.opacity}, fitted ${cw.roundToInt()}x${ch.roundToInt()}" +
              (if (info == null) " (size unknown)" else " from ${info.width}x${info.height}"),
          )
        }
      }
    }
    // The picture track lasts the whole edit (the preview's clock and the
    // export's length come from it).
    val totalUs = max((duration * 1_000_000).roundToLong(), mainUs)
    if (totalUs - mainUs >= 10_000) {
      videoItems.add(gapItem(context, (totalUs - mainUs) / 1000, fps, presentation, canvas, width, height))
    }
    if (videoItems.isEmpty()) {
      videoItems.add(gapItem(context, max(100L, totalUs / 1000), fps, presentation, canvas, width, height))
    }
    val sequences = mutableListOf(trackSequence(C.TRACK_TYPE_VIDEO, videoItems))

    // ---- Sound: clips packed into tracks (no overlaps inside a track) ----
    val gains = HashMap<String, LiveGainProcessor>()
    class Lane(var cursorUs: Long, val items: MutableList<EditedMediaItem>)
    val lanes = mutableListOf<Lane>()
    val clips = (0 until audio.length()).map { audio.getJSONObject(it) }
      .sortedBy { it.optDouble("start", 0.0) }
    for (a in clips) {
      val id = a.optString("id", "audio-${gains.size}")
      val uri = a.getString("uri")
      val startUs = (a.getDouble("start") * 1_000_000).roundToLong()
      val (trimInUs, trimOutUs) = clipRangeUs(a.getDouble("trimIn"), a.getDouble("trimOut"), mode)
      if (trimOutUs <= trimInUs) continue
      val speed = a.optDouble("speed", 1.0).toFloat().let { if (it > 0f) it else 1f }
      val volume = a.optDouble("volume", 1.0).toFloat().coerceIn(0f, 2f)
      val info = probe(context, uri)
      // A video recorded without sound still has an audio clip in the editor
      // (silent there). Media3 would stop on a file with no sound track, so
      // such a clip is left out.
      if (info != null && !info.hasAudio) {
        Log.d(TAG, "  [$mode] audio $id skipped — the file has no sound track")
        continue
      }
      val lengthUs = ((trimOutUs - trimInUs) / speed).roundToLong()
      val lane = lanes.firstOrNull { it.cursorUs <= startUs + 1000 }
        ?: Lane(0L, mutableListOf()).also { lanes.add(it) }
      val gapUs = startUs - lane.cursorUs
      if (gapUs >= 10_000) {
        lane.items.add(silenceItem(context, gapUs))
        lane.cursorUs += gapUs
      }
      val gain = LiveGainProcessor(volume)
      gains[id] = gain
      val processors = mutableListOf<AudioProcessor>()
      if (speed != 1f) {
        // setSpeed changes the pitch with the speed (like a tape); this puts
        // the pitch back where it was, like the editor's players did.
        processors.add(SonicAudioProcessor().apply { setPitch(1f / speed) })
      }
      processors.add(gain)
      val builder = EditedMediaItem.Builder(clippedItem(uri, trimInUs, trimOutUs))
        .setRemoveVideo(true)
        .setEffects(Effects(processors, listOf()))
        .setDurationUs(sourceDurationUs(info, a, trimOutUs))
      if (speed != 1f) builder.setSpeed(ConstantSpeed(speed))
      lane.items.add(builder.build())
      lane.cursorUs += lengthUs
      Log.d(TAG, "  [$mode] audio $id @${startUs / 1000}ms ${trimInUs / 1000}–${trimOutUs / 1000}ms x$speed vol $volume (track ${lanes.indexOf(lane) + 1})")
    }
    for (lane in lanes) sequences.add(trackSequence(C.TRACK_TYPE_AUDIO, lane.items))

    Log.d(
      TAG,
      "[$mode] timeline ${width}x$height, ${totalUs / 1000}ms: ${videoItems.size} picture item(s), " +
        "${gains.size} sound clip(s) on ${lanes.size} sound track(s), canvas ${"#%06X".format(canvas.color and 0xFFFFFF)}",
    )
    val composition = Composition.Builder(sequences)
      .apply { if (topEffects.isNotEmpty()) setEffects(Effects(listOf(), topEffects)) }
      .build()
    return BuiltTimeline(composition, looks, canvas, gains, totalUs)
  }

  /**
   * The plan without what the preview can change live (turn, mirror,
   * opacity, volume, canvas colour) and without PIP (drawn by its own view).
   * Two plans with the same key need no new timeline — only new looks.
   */
  fun structureKey(plan: JSONObject): String {
    val copy = JSONObject(plan.toString())
    copy.remove("background")
    copy.remove("pip")
    copy.remove("overlays")
    copy.optJSONArray("video")?.let { arr ->
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        o.remove("rotate")
        o.remove("flipX")
        o.remove("opacity")
      }
    }
    copy.optJSONArray("audio")?.let { arr ->
      for (i in 0 until arr.length()) arr.getJSONObject(i).remove("volume")
    }
    return copy.toString()
  }

  /** Puts a plan's live values into an already built timeline. */
  fun applyLooks(built: BuiltTimeline, plan: JSONObject) {
    built.canvas.color = parseColor(plan.optString("background", "#000000"))
    plan.optJSONArray("video")?.let { arr ->
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        if (o.optString("type") != "clip") continue
        val look = built.looks[o.optString("id")] ?: continue
        look.rotate = o.optDouble("rotate", 0.0).toFloat()
        look.flip = o.optBoolean("flipX", false)
        look.opacity = o.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f)
      }
    }
    plan.optJSONArray("audio")?.let { arr ->
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        built.gains[o.optString("id")]?.gain = o.optDouble("volume", 1.0).toFloat().coerceIn(0f, 2f)
      }
    }
  }

  /**
   * A clip's source range (seconds) in µs. In the preview its start is put
   * on a 10 ms grid: Media3's preview player gives every clip a silent sound
   * track (44.1 kHz) whose first sample is rounded DOWN to its sample grid —
   * a clip starting off that grid (e.g. split at 4.1134 s) gets a sample a
   * few µs before its start, and Media3's own check stops the player
   * ("AudioGraphInput.onMediaItemChanged" — the "couldn't play this part"
   * error). Every multiple of 10 ms is exactly on the 44.1 kHz grid.
   * The start moves down to the grid and the end by the same amount, so the
   * clip keeps its exact length (nothing drifts along the timeline) and never
   * ends past the file; the picture moves by under 10 ms (not visible).
   * The export keeps exact times.
   */
  private fun clipRangeUs(inSeconds: Double, outSeconds: Double, mode: BuildMode): Pair<Long, Long> {
    val inUs = (inSeconds * 1_000_000).roundToLong()
    val outUs = (outSeconds * 1_000_000).roundToLong()
    if (mode != BuildMode.PREVIEW) return Pair(inUs, outUs)
    val snappedIn = (inUs / 10_000) * 10_000
    return Pair(snappedIn, outUs - (inUs - snappedIn))
  }

  // ---- Items -------------------------------------------------------------------

  private fun gapItem(
    context: Context,
    ms: Long,
    fps: Float,
    presentation: Presentation,
    canvas: CanvasLook,
    width: Int,
    height: Int,
  ): EditedMediaItem {
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.fromFile(blackStill(context)))
      .setMimeType(MimeTypes.IMAGE_PNG)
      .setImageDurationMs(max(1L, ms))
      .build()
    val effects = listOf<Effect>(
      presentation,
      OverlayEffect(listOf<TextureOverlay>(CanvasLayer(null, canvas, width.toFloat(), height.toFloat(), width, height))),
    )
    return EditedMediaItem.Builder(mediaItem)
      .setFrameRate(max(1, fps.roundToInt()))
      .setEffects(Effects(listOf(), effects))
      .build()
  }

  private fun silenceItem(context: Context, durationUs: Long): EditedMediaItem {
    val file = silenceWav(context, durationUs)
    return EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(file)))
      .setDurationUs(max(1L, durationUs))
      .build()
  }

  /** A trimmed piece of a media file. */
  fun clippedItem(uri: String, trimInUs: Long, trimOutUs: Long): MediaItem =
    MediaItem.Builder()
      .setUri(Uri.parse(uri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionUs(trimInUs)
          .setEndPositionUs(trimOutUs)
          .build(),
      )
      .build()

  // Media3 1.9: a sequence is built for the track types it carries.
  private fun trackSequence(trackType: Int, items: List<EditedMediaItem>): EditedMediaItemSequence =
    EditedMediaItemSequence.Builder(setOf(trackType)).addItems(items).build()

  /** The whole file's length (Media3 needs it), never shorter than the trim end. */
  private fun sourceDurationUs(info: MediaInfo?, item: JSONObject, trimOutUs: Long): Long {
    val fromFile = info?.durationUs ?: 0L
    val fromApp = (item.optDouble("sourceDuration", 0.0) * 1_000_000).roundToLong()
    return max(trimOutUs, if (fromFile > 0) fromFile else fromApp).coerceAtLeast(1L)
  }

  // ---- Files ---------------------------------------------------------------------

  /** Size (upright), length and sound of a file — read once per file. */
  fun probe(context: Context, uri: String): MediaInfo? {
    probes[uri]?.let { return it }
    val extractor = MediaExtractor()
    return try {
      setExtractorSource(context, extractor, uri)
      var w = 0
      var h = 0
      var rotation = 0
      var durationUs = 0L
      var hasAudio = false
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
        if (f.containsKey(MediaFormat.KEY_DURATION)) durationUs = max(durationUs, f.getLong(MediaFormat.KEY_DURATION))
        if (mime.startsWith("audio/")) hasAudio = true
        if (mime.startsWith("video/") && w == 0) {
          w = f.getInteger(MediaFormat.KEY_WIDTH)
          h = f.getInteger(MediaFormat.KEY_HEIGHT)
          if (f.containsKey(MediaFormat.KEY_ROTATION)) rotation = f.getInteger(MediaFormat.KEY_ROTATION)
        }
      }
      val turned = rotation % 180 != 0
      val info = MediaInfo(if (turned) h else w, if (turned) w else h, durationUs, hasAudio)
      probes[uri] = info
      info
    } catch (e: Exception) {
      Log.w(TAG, "couldn't read $uri", e)
      null
    } finally {
      extractor.release()
    }
  }

  private fun folder(context: Context): File =
    File(context.cacheDir, "vidsurge-timeline").apply { mkdirs() }

  /** A tiny black picture (gaps: the canvas colour is laid over it). */
  private fun blackStill(context: Context): File {
    val file = File(folder(context), "black-16.png")
    if (file.exists() && file.length() > 0) return file
    val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(Color.BLACK)
    FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bitmap.recycle()
    return file
  }

  /** Silent 44.1 kHz mono WAV, durationUs long — one file per length, kept. */
  private fun silenceWav(context: Context, durationUs: Long): File {
    val sampleRate = 44100
    val frames = durationUs * sampleRate / 1_000_000
    val file = File(folder(context), "silence-$frames.wav")
    if (file.exists() && file.length() == 44 + frames * 2) return file
    val dataBytes = frames * 2
    RandomAccessFile(file, "rw").use { f ->
      fun int32(v: Long) {
        f.write((v and 0xff).toInt()); f.write(((v shr 8) and 0xff).toInt())
        f.write(((v shr 16) and 0xff).toInt()); f.write(((v shr 24) and 0xff).toInt())
      }
      fun int16(v: Int) {
        f.write(v and 0xff); f.write((v shr 8) and 0xff)
      }
      f.setLength(0)
      f.writeBytes("RIFF"); int32(36 + dataBytes); f.writeBytes("WAVE")
      f.writeBytes("fmt "); int32(16); int16(1); int16(1)
      int32(sampleRate.toLong()); int32((sampleRate * 2).toLong())
      int16(2); int16(16)
      f.writeBytes("data"); int32(dataBytes)
      f.setLength(44 + dataBytes) // the rest is zeros = silence
    }
    return file
  }

  /** Deletes the kept silence / still files (the app calls it at start). */
  fun clearFiles(context: Context) {
    folder(context).listFiles()?.forEach { it.delete() }
  }

  fun parseColor(hex: String): Int =
    try {
      Color.parseColor(hex)
    } catch (e: Exception) {
      Color.BLACK
    }
}

/** One speed for the whole clip. */
internal class ConstantSpeed(private val speed: Float) : SpeedProvider {
  override fun getSpeed(timeUs: Long): Float = speed

  override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET

  // Media3 compares speed providers (an item's audio and video effects must
  // carry the same one): equal speeds are the same provider.
  override fun equals(other: Any?): Boolean = other is ConstantSpeed && other.speed == speed

  override fun hashCode(): Int = speed.hashCode()
}
