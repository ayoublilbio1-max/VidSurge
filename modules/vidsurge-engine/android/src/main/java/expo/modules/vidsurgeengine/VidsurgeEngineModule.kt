package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.AlphaScale
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.Crop
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.ScaleAndRotateTransformation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

private const val TAG = "VidsurgeEngine"
private const val ENGINE_VERSION = 2

/**
 * VidSurge export engine (Android, Media3 Transformer).
 *
 * JS sends one JSON "plan" (see modules/vidsurge-engine/index.ts). The
 * engine builds a Media3 Composition from it:
 *   - the main video: each clip trimmed, sped up / slowed, cropped, turned /
 *     flipped, faded (Opacity) and fitted into the output frame. Its own
 *     sound is removed (all sound comes from the audio clips, like in the
 *     editor).
 *   - A plain video on black is ONE picture track (gaps = canvas colour).
 *     With PIP, lowered opacity or a canvas colour the picture is LAYERED
 *     by the compositor, top to bottom: an invisible "clock" (sets the
 *     output frame times), the PIP clips (placed / sized / turned), the
 *     main video, the canvas colour.
 *   - texts + stickers: pictures drawn by the app (one per stretch of
 *     time), laid over the finished frame.
 *   - one sequence per audio clip: silence until the clip starts, then the
 *     clip (trimmed, speed, volume). Media3 mixes the sequences together.
 * Progress is sent as "onProgress" events (0–1) every 250 ms.
 */
// Media3's editing APIs are marked "unstable" (may change between versions).
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class VidsurgeEngineModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var transformer: Transformer? = null
  private var pending: Promise? = null
  private var progressRunnable: Runnable? = null
  private var tempFiles: MutableList<File> = mutableListOf()

  override fun definition() = ModuleDefinition {
    Name("VidsurgeEngine")

    Events("onProgress")

    // Which engine this app build has (JS checks it: a new JS bundle on an
    // old app build can't export what only the new engine knows).
    // 1 = v0.17 (main video + audio), 2 = v0.18 (+ texts, stickers, PIP,
    // opacity, canvas colour).
    Function("version") { ENGINE_VERSION }

    AsyncFunction("exportVideo") { planJson: String, promise: Promise ->
      if (transformer != null) {
        promise.reject("ERR_BUSY", "An export is already running", null)
        return@AsyncFunction
      }
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "No Android context", null)
        return@AsyncFunction
      }
      try {
        startExport(context, JSONObject(planJson), promise)
      } catch (e: Exception) {
        Log.e(TAG, "export setup failed", e)
        cleanUp()
        promise.reject("ERR_SETUP", e.message ?: "Export setup failed", e)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelExport") {
      val t = transformer ?: return@AsyncFunction false
      Log.d(TAG, "cancel requested")
      t.cancel()
      val p = pending
      cleanUp()
      p?.reject("ERR_CANCELLED", "Export cancelled", null)
      true
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      mainHandler.post {
        transformer?.cancel()
        cleanUp()
      }
    }
  }

  // ---- Building the composition ------------------------------------------

  /** A PIP clip's place over the main video (for the compositor). */
  private class PipSpan(val startUs: Long, val endUs: Long, val settings: OverlaySettings)

  private fun startExport(context: Context, plan: JSONObject, promise: Promise) {
    val width = plan.getInt("width")
    val height = plan.getInt("height")
    val fps = plan.getDouble("fps").toFloat()
    val bitrate = plan.getInt("videoBitrate")
    val background = parseColor(plan.optString("background", "#000000"))
    val outputPath = plan.getString("outputPath").removePrefix("file://")
    val crop = plan.optJSONObject("crop")
    val duration = plan.optDouble("duration", 0.0)
    val video = plan.getJSONArray("video")
    val pip = plan.optJSONArray("pip") ?: JSONArray()
    val overlays = plan.optJSONArray("overlays") ?: JSONArray()

    // Only a plain video on black can be written as one picture track. PIP,
    // lowered opacity or a canvas colour need the compositor: the layers
    // (background colour, main video, PIP) are drawn over each other.
    var anyOpacity = false
    for (i in 0 until video.length()) {
      val item = video.getJSONObject(i)
      if (item.getString("type") == "clip" && item.optDouble("opacity", 1.0) < 0.999) anyOpacity = true
    }
    val blackBackground = (background and 0xFFFFFF) == 0
    val composite = pip.length() > 0 || anyOpacity || !blackBackground

    Log.d(
      TAG,
      "export ${width}x$height @${fps}fps ${bitrate / 1000}kbps, ${duration}s, " +
        "${video.length()} video item(s), ${pip.length()} PIP, ${overlays.length()} text/sticker picture(s), " +
        (if (composite) "layered (compositor)" else "single track") + " → $outputPath",
    )

    // The output frame: every main-video picture is fitted whole inside it.
    val presentation = Presentation.createForWidthAndHeight(
      width, height, Presentation.LAYOUT_SCALE_TO_FIT,
    )

    // ---- Main video track ----
    // Gaps: the canvas colour (single track) or see-through (layered — the
    // background layer shows).
    val videoItems = mutableListOf<EditedMediaItem>()
    for (i in 0 until video.length()) {
      val item = video.getJSONObject(i)
      when (item.getString("type")) {
        "gap" -> {
          val ms = (item.getDouble("duration") * 1000).toLong()
          if (ms <= 0) continue
          if (composite) {
            videoItems.add(stillItem(transparentStill(context, width, height), ms, fps))
          } else {
            val still = colorStill(context, background, width / 8, height / 8)
            videoItems.add(stillItem(still, ms, fps, listOf(presentation)))
          }
          Log.d(TAG, "  video gap ${ms}ms")
        }
        "clip" -> {
          val uri = item.getString("uri")
          val trimInMs = (item.getDouble("trimIn") * 1000).toLong()
          val trimOutMs = (item.getDouble("trimOut") * 1000).toLong()
          val speed = item.optDouble("speed", 1.0).toFloat()
          val rotate = item.optDouble("rotate", 0.0).toFloat()
          val flip = item.optBoolean("flipX", false)
          val opacity = item.optDouble("opacity", 1.0).toFloat()

          val effects = mutableListOf<Effect>()
          if (crop != null) {
            // Normalized crop (0–1, top-left origin) → Media3's -1..1, y up.
            val x = crop.getDouble("x").toFloat()
            val y = crop.getDouble("y").toFloat()
            val w = crop.getDouble("w").toFloat()
            val h = crop.getDouble("h").toFloat()
            effects.add(Crop(-1f + 2f * x, -1f + 2f * (x + w), 1f - 2f * (y + h), 1f - 2f * y))
          }
          if (rotate != 0f || flip) {
            effects.add(
              ScaleAndRotateTransformation.Builder()
                // Media3 turns counter-clockwise; the editor turns clockwise.
                .setRotationDegrees(-rotate)
                .setScale(if (flip) -1f else 1f, 1f)
                .build(),
            )
          }
          if (speed != 1f) effects.add(SpeedChangeEffect(speed))
          effects.add(FrameDropEffect.createDefaultFrameDropEffect(fps))
          effects.add(presentation)
          if (composite && opacity < 0.999f) effects.add(AlphaScale(maxOf(0f, opacity)))

          videoItems.add(
            EditedMediaItem.Builder(clippedItem(uri, trimInMs, trimOutMs))
              .setRemoveAudio(true)
              .setEffects(Effects(listOf(), effects))
              .build(),
          )
          Log.d(TAG, "  video clip ${trimInMs}–${trimOutMs}ms x$speed rot $rotate flip $flip opacity $opacity")
        }
      }
    }
    if (videoItems.isEmpty()) throw IllegalArgumentException("Nothing to export")

    val sequences = mutableListOf<EditedMediaItemSequence>()
    var pipIndex = -1
    val pipSpans = mutableListOf<PipSpan>()

    if (!composite) {
      sequences.add(trackSequence(C.TRACK_TYPE_VIDEO, videoItems))
    } else {
      val totalMs = maxOf(1L, (duration * 1000).toLong())
      // The compositor draws the FIRST video sequence on top and takes the
      // output frames' times from it. So sequence 0 is an invisible "clock":
      // a see-through picture for the whole video at the export frame rate.
      // Below it: PIP, then the main video, then the canvas colour.
      sequences.add(
        trackSequence(
          C.TRACK_TYPE_VIDEO,
          listOf(stillItem(transparentStill(context, width, height), totalMs, fps)),
        ),
      )

      if (pip.length() > 0) {
        val pipItems = mutableListOf<EditedMediaItem>()
        var cursorMs = 0L
        for (i in 0 until pip.length()) {
          val p = pip.getJSONObject(i)
          var startMs = (p.getDouble("start") * 1000).toLong()
          val trimInMs = (p.getDouble("trimIn") * 1000).toLong()
          val trimOutMs = (p.getDouble("trimOut") * 1000).toLong()
          val speed = p.optDouble("speed", 1.0).toFloat().let { if (it > 0f) it else 1f }
          val lengthMs = ((trimOutMs - trimInMs) / speed).toLong()
          if (lengthMs <= 0) continue
          if (startMs < cursorMs) {
            Log.w(TAG, "  PIP $i overlaps the one before — skipped")
            continue
          }
          if (startMs - cursorMs >= 10) {
            pipItems.add(stillItem(transparentStill(context, width, height), startMs - cursorMs, fps))
          } else {
            startMs = cursorMs // a gap too short for a picture: starts right after
          }
          val pw = maxOf(2, Math.round(p.getDouble("w")).toInt())
          val ph = maxOf(2, Math.round(p.getDouble("h")).toInt())
          val opacity = p.optDouble("opacity", 1.0).toFloat()
          val effects = mutableListOf<Effect>()
          if (p.getString("kind") == "video") {
            if (speed != 1f) effects.add(SpeedChangeEffect(speed))
            effects.add(FrameDropEffect.createDefaultFrameDropEffect(fps))
          }
          // Its size in the frame; the picture fills it (like the preview's
          // "cover").
          effects.add(Presentation.createForWidthAndHeight(pw, ph, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))
          if (opacity < 0.999f) effects.add(AlphaScale(maxOf(0f, opacity)))

          if (p.getString("kind") == "video") {
            pipItems.add(
              EditedMediaItem.Builder(clippedItem(p.getString("uri"), trimInMs, trimOutMs))
                .setRemoveAudio(true)
                .setEffects(Effects(listOf(), effects))
                .build(),
            )
          } else {
            val mediaItem = MediaItem.Builder()
              .setUri(Uri.parse(p.getString("uri")))
              .setMimeType(imageMimeType(p.getString("uri")))
              .setImageDurationMs(lengthMs)
              .build()
            pipItems.add(
              EditedMediaItem.Builder(mediaItem)
                .setFrameRate(fps.toInt())
                .setEffects(Effects(listOf(), effects))
                .build(),
            )
          }

          // Where it goes: its centre (as -1..1, y up) and its turn.
          val ax = (2f * p.getDouble("cx").toFloat() / width - 1f).coerceIn(-1f, 1f)
          val ay = (1f - 2f * p.getDouble("cy").toFloat() / height).coerceIn(-1f, 1f)
          val rotation = p.optDouble("rotation", 0.0).toFloat()
          val settings = StaticOverlaySettings.Builder()
            .setBackgroundFrameAnchor(ax, ay)
            // The compositor turns counter-clockwise; the editor clockwise.
            .setRotationDegrees(-rotation)
            .build()
          pipSpans.add(PipSpan(startMs * 1000, (startMs + lengthMs) * 1000, settings))
          cursorMs = startMs + lengthMs
          Log.d(
            TAG,
            "  PIP ${p.getString("kind")} @${startMs}ms ${lengthMs}ms ${pw}x$ph at ${"%.3f".format(ax)},${"%.3f".format(ay)} rot $rotation opacity $opacity",
          )
        }
        if (pipItems.isNotEmpty()) {
          // See-through until the end (a sequence that stops early would
          // keep showing its last picture).
          if (totalMs - cursorMs >= 10) {
            pipItems.add(stillItem(transparentStill(context, width, height), totalMs - cursorMs, fps))
          }
          pipIndex = sequences.size
          sequences.add(trackSequence(C.TRACK_TYPE_VIDEO, pipItems))
        }
      }

      sequences.add(trackSequence(C.TRACK_TYPE_VIDEO, videoItems))

      sequences.add(
        trackSequence(
          C.TRACK_TYPE_VIDEO,
          listOf(stillItem(colorStill(context, background, width, height), totalMs, fps)),
        ),
      )
      Log.d(TAG, "  layers: clock, ${if (pipIndex >= 0) "PIP, " else ""}main video, background $background")
    }

    // ---- Audio clips: one sequence each, silence until it starts ----
    val audio = plan.optJSONArray("audio")
    if (audio != null) {
      for (i in 0 until audio.length()) {
        val a = audio.getJSONObject(i)
        val volume = a.optDouble("volume", 1.0).toFloat()
        if (volume <= 0f) continue
        val start = a.getDouble("start")
        val trimInMs = (a.getDouble("trimIn") * 1000).toLong()
        val trimOutMs = (a.getDouble("trimOut") * 1000).toLong()
        val speed = a.optDouble("speed", 1.0).toFloat()

        val items = mutableListOf<EditedMediaItem>()
        if (start > 0.001) {
          val silence = silenceWav(context, start)
          items.add(
            EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(silence))).build(),
          )
        }
        val processors = mutableListOf<AudioProcessor>()
        if (speed != 1f) {
          processors.add(SonicAudioProcessor().apply { setSpeed(speed); setPitch(1f) })
        }
        if (volume != 1f) {
          processors.add(
            ChannelMixingAudioProcessor().apply {
              putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(volume))
              putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(volume))
            },
          )
        }
        items.add(
          EditedMediaItem.Builder(clippedItem(a.getString("uri"), trimInMs, trimOutMs))
            .setRemoveVideo(true)
            .setEffects(Effects(processors, listOf()))
            .build(),
        )
        sequences.add(trackSequence(C.TRACK_TYPE_AUDIO, items))
        Log.d(TAG, "  audio @${start}s ${trimInMs}–${trimOutMs}ms x$speed vol $volume")
      }
    }

    val builder = Composition.Builder(sequences)

    // ---- Texts + stickers: pictures laid over the finished frame ----
    val overlaySegments = mutableListOf<OverlaySegment>()
    for (i in 0 until overlays.length()) {
      val o = overlays.getJSONObject(i)
      overlaySegments.add(
        OverlaySegment(
          (o.getDouble("start") * 1_000_000).toLong(),
          (o.getDouble("end") * 1_000_000).toLong(),
          o.getString("uri").removePrefix("file://"),
        ),
      )
      Log.d(TAG, "  texts/stickers ${o.getDouble("start")}–${o.getDouble("end")}s")
    }
    if (overlaySegments.isNotEmpty()) {
      val overlay = SegmentOverlay(overlaySegments, width, height)
      builder.setEffects(Effects(listOf(), listOf<Effect>(OverlayEffect(listOf<TextureOverlay>(overlay)))))
    }

    if (composite) {
      val spans = pipSpans.toList()
      val pipInput = pipIndex
      val plain: OverlaySettings = StaticOverlaySettings.Builder().build()
      builder.setVideoCompositorSettings(
        object : VideoCompositorSettings {
          override fun getOutputSize(inputSizes: List<Size>): Size = Size(width, height)

          override fun getOverlaySettings(inputId: Int, presentationTimeUs: Long): OverlaySettings {
            if (inputId == pipInput) {
              for (s in spans) {
                if (presentationTimeUs >= s.startUs - 1000 && presentationTimeUs < s.endUs) return s.settings
              }
            }
            return plain
          }
        },
      )
    }

    val composition = builder.build()

    // ---- Transformer ----
    val encoderFactory = DefaultEncoderFactory.Builder(context)
      .setRequestedVideoEncoderSettings(
        VideoEncoderSettings.Builder().setBitrate(bitrate).build(),
      )
      .setEnableFallback(true)
      .build()

    File(outputPath).parentFile?.mkdirs()
    File(outputPath).delete()

    val t = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setEncoderFactory(encoderFactory)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          Log.d(TAG, "done: ${exportResult.durationMs}ms, ${exportResult.fileSizeBytes} bytes")
          val p = pending
          cleanUp()
          p?.resolve(
            mapOf(
              "uri" to "file://$outputPath",
              "durationMs" to exportResult.durationMs.toDouble(),
              "sizeBytes" to exportResult.fileSizeBytes.toDouble(),
            ),
          )
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          Log.e(TAG, "export failed (${exportException.errorCodeName})", exportException)
          val p = pending
          cleanUp()
          p?.reject(
            "ERR_EXPORT",
            "${exportException.errorCodeName}: ${exportException.message}",
            exportException,
          )
        }
      })
      .build()

    transformer = t
    pending = promise
    t.start(composition, outputPath)
    startProgress(t)
  }

  /** A photo's MIME type from its file name (Media3 needs it to see it's a picture). */
  private fun imageMimeType(uri: String): String =
    when (uri.substringBefore('?').substringAfterLast('/').substringAfterLast('.', "").lowercase()) {
      "png" -> MimeTypes.IMAGE_PNG
      "webp" -> MimeTypes.IMAGE_WEBP
      "heic" -> MimeTypes.IMAGE_HEIC
      "heif" -> MimeTypes.IMAGE_HEIF
      "bmp" -> MimeTypes.IMAGE_BMP
      "avif" -> MimeTypes.IMAGE_AVIF
      else -> MimeTypes.IMAGE_JPEG
    }

  /** A trimmed piece of a media file. */
  private fun clippedItem(uri: String, trimInMs: Long, trimOutMs: Long): MediaItem =
    MediaItem.Builder()
      .setUri(Uri.parse(uri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(trimInMs)
          .setEndPositionMs(trimOutMs)
          .build(),
      )
      .build()

  /** A still picture shown for `ms` at the export frame rate. */
  private fun stillItem(file: File, ms: Long, fps: Float, effects: List<Effect> = listOf()): EditedMediaItem {
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.fromFile(file))
      .setImageDurationMs(ms)
      .build()
    return EditedMediaItem.Builder(mediaItem)
      .setFrameRate(maxOf(1, fps.toInt()))
      .setEffects(Effects(listOf(), effects))
      .build()
  }

  // Media3 1.9: a sequence is built for the track types it carries (video
  // or audio). The old no-argument / list builders are gone or deprecated.
  private fun trackSequence(trackType: Int, items: List<EditedMediaItem>): EditedMediaItemSequence =
    EditedMediaItemSequence.Builder(setOf(trackType)).addItems(items).build()

  // ---- Progress --------------------------------------------------------------

  private fun startProgress(t: Transformer) {
    val holder = ProgressHolder()
    val runnable = object : Runnable {
      override fun run() {
        if (transformer !== t) return
        if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          sendEvent("onProgress", mapOf("progress" to holder.progress / 100.0))
        }
        mainHandler.postDelayed(this, 250)
      }
    }
    progressRunnable = runnable
    mainHandler.post(runnable)
  }

  private fun cleanUp() {
    progressRunnable?.let { mainHandler.removeCallbacks(it) }
    progressRunnable = null
    transformer = null
    pending = null
    for (f in tempFiles) f.delete()
    tempFiles = mutableListOf()
    transparentFile = null
  }

  // ---- Helper files ----------------------------------------------------------

  private fun parseColor(hex: String): Int =
    try {
      Color.parseColor(hex)
    } catch (e: Exception) {
      Color.BLACK
    }

  /** A still picture in one colour, w × h px (PNG, deleted after). */
  private fun colorStill(context: Context, color: Int, w: Int, h: Int): File {
    val bitmap = Bitmap.createBitmap(maxOf(2, w), maxOf(2, h), Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(color)
    val file = File(context.cacheDir, "vidsurge-still-${System.nanoTime()}.png")
    FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bitmap.recycle()
    tempFiles.add(file)
    return file
  }

  // One see-through picture, reused by every clock / gap in an export.
  private var transparentFile: File? = null

  /** A fully see-through still the size of the output frame. */
  private fun transparentStill(context: Context, width: Int, height: Int): File {
    transparentFile?.let { if (it.exists()) return it }
    val f = colorStill(context, Color.TRANSPARENT, width, height)
    transparentFile = f
    return f
  }

  /** Silent 44.1 kHz stereo WAV, `seconds` long (audio clips' start offset). */
  private fun silenceWav(context: Context, seconds: Double): File {
    val sampleRate = 44100
    val channels = 2
    val frames = (seconds * sampleRate).toLong()
    val dataBytes = frames * channels * 2
    val file = File(context.cacheDir, "vidsurge-silence-${System.nanoTime()}.wav")
    RandomAccessFile(file, "rw").use { f ->
      fun int32(v: Long) {
        f.write((v and 0xff).toInt()); f.write(((v shr 8) and 0xff).toInt())
        f.write(((v shr 16) and 0xff).toInt()); f.write(((v shr 24) and 0xff).toInt())
      }
      fun int16(v: Int) {
        f.write(v and 0xff); f.write((v shr 8) and 0xff)
      }
      f.writeBytes("RIFF"); int32(36 + dataBytes); f.writeBytes("WAVE")
      f.writeBytes("fmt "); int32(16); int16(1); int16(channels)
      int32(sampleRate.toLong()); int32((sampleRate * channels * 2).toLong())
      int16(channels * 2); int16(16)
      f.writeBytes("data"); int32(dataBytes)
      f.setLength(44 + dataBytes) // the rest is zeros = silence
    }
    tempFiles.add(file)
    return file
  }
}

/** One texts/stickers picture and when it shows (µs, output time). */
private class OverlaySegment(val startUs: Long, val endUs: Long, val path: String)

/**
 * Texts and stickers over the finished frame: at each frame, the picture
 * of the stretch of time it's in (full frame, transparent around them), or
 * nothing. Pictures are read one at a time, when their stretch starts.
 *
 * They're decoded NOT premultiplied: Media3 uploads the bitmap's pixels
 * as they are and blends them as straight alpha — a normal (premultiplied)
 * bitmap would make soft edges, glows and see-through texts too dark.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
private class SegmentOverlay(
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
    // (Not expected — the app draws it at that size.) Resized from a normal
    // copy, then its pixels are put back un-premultiplied.
    Log.w(TAG, "texts/stickers picture ${bitmap.width}x${bitmap.height} → ${width}x$height")
    bitmap.recycle()
    val normal = BitmapFactory.decodeFile(path) ?: return null
    val scaled = Bitmap.createScaledBitmap(normal, width, height, true)
    if (scaled !== normal) normal.recycle()
    val pixels = IntArray(width * height)
    scaled.getPixels(pixels, 0, width, 0, 0, width, height) // straight ARGB
    scaled.recycle()
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    out.isPremultiplied = false
    out.setPixels(pixels, 0, width, 0, 0, width, height)
    return out
  }
}
