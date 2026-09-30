package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Crop
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.ScaleAndRotateTransformation
import androidx.media3.effect.SpeedChangeEffect
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
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

private const val TAG = "VidsurgeEngine"

/**
 * VidSurge export engine (Android, Media3 Transformer).
 *
 * JS sends one JSON "plan" (see modules/vidsurge-engine/index.ts): the
 * output size / fps / bitrate, the main video track as a list of clips and
 * gaps, and the audio clips with their start times. The engine builds a
 * Media3 Composition from it:
 *   - sequence 0: the main video — each clip trimmed, sped up / slowed,
 *     cropped, turned / flipped and fitted into the output frame; gaps are
 *     a still picture in the canvas colour. Its own sound is removed (all
 *     sound comes from the audio clips, like in the editor).
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

  private fun startExport(context: Context, plan: JSONObject, promise: Promise) {
    val width = plan.getInt("width")
    val height = plan.getInt("height")
    val fps = plan.getDouble("fps").toFloat()
    val bitrate = plan.getInt("videoBitrate")
    val background = parseColor(plan.optString("background", "#000000"))
    val outputPath = plan.getString("outputPath").removePrefix("file://")
    val crop = plan.optJSONObject("crop")

    Log.d(TAG, "export ${width}x$height @${fps}fps ${bitrate / 1000}kbps → $outputPath")

    // The output frame: every picture is fitted whole inside it.
    val presentation = Presentation.createForWidthAndHeight(
      width, height, Presentation.LAYOUT_SCALE_TO_FIT,
    )

    // ---- Main video track ----
    val videoItems = mutableListOf<EditedMediaItem>()
    val video = plan.getJSONArray("video")
    for (i in 0 until video.length()) {
      val item = video.getJSONObject(i)
      when (item.getString("type")) {
        "gap" -> {
          val ms = (item.getDouble("duration") * 1000).toLong()
          if (ms <= 0) continue
          val still = colorStill(context, background, width, height)
          val mediaItem = MediaItem.Builder()
            .setUri(Uri.fromFile(still))
            .setImageDurationMs(ms)
            .build()
          videoItems.add(
            EditedMediaItem.Builder(mediaItem)
              .setFrameRate(fps.toInt())
              .setEffects(Effects(listOf(), listOf<Effect>(presentation)))
              .build(),
          )
          Log.d(TAG, "  video gap ${ms}ms")
        }
        "clip" -> {
          val uri = item.getString("uri")
          val trimInMs = (item.getDouble("trimIn") * 1000).toLong()
          val trimOutMs = (item.getDouble("trimOut") * 1000).toLong()
          val speed = item.optDouble("speed", 1.0).toFloat()
          val rotate = item.optDouble("rotate", 0.0).toFloat()
          val flip = item.optBoolean("flipX", false)

          val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(uri))
            .setClippingConfiguration(
              MediaItem.ClippingConfiguration.Builder()
                .setStartPositionMs(trimInMs)
                .setEndPositionMs(trimOutMs)
                .build(),
            )
            .build()

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

          videoItems.add(
            EditedMediaItem.Builder(mediaItem)
              .setRemoveAudio(true)
              .setEffects(Effects(listOf(), effects))
              .build(),
          )
          Log.d(TAG, "  video clip ${trimInMs}–${trimOutMs}ms x$speed rot $rotate flip $flip")
        }
      }
    }
    if (videoItems.isEmpty()) throw IllegalArgumentException("Nothing to export")

    val sequences = mutableListOf<EditedMediaItemSequence>()
    sequences.add(trackSequence(C.TRACK_TYPE_VIDEO, videoItems))

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
        val mediaItem = MediaItem.Builder()
          .setUri(Uri.parse(a.getString("uri")))
          .setClippingConfiguration(
            MediaItem.ClippingConfiguration.Builder()
              .setStartPositionMs(trimInMs)
              .setEndPositionMs(trimOutMs)
              .build(),
          )
          .build()
        items.add(
          EditedMediaItem.Builder(mediaItem)
            .setRemoveVideo(true)
            .setEffects(Effects(processors, listOf()))
            .build(),
        )
        sequences.add(trackSequence(C.TRACK_TYPE_AUDIO, items))
        Log.d(TAG, "  audio @${start}s ${trimInMs}–${trimOutMs}ms x$speed vol $volume")
      }
    }

    val composition = Composition.Builder(sequences).build()

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
  }

  // ---- Helper files ----------------------------------------------------------

  private fun parseColor(hex: String): Int =
    try {
      Color.parseColor(hex)
    } catch (e: Exception) {
      Color.BLACK
    }

  /** A small still picture in the canvas colour, the output's shape. */
  private fun colorStill(context: Context, color: Int, width: Int, height: Int): File {
    val w = maxOf(2, width / 8)
    val h = maxOf(2, height / 8)
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(color)
    val file = File(context.cacheDir, "vidsurge-gap-${System.nanoTime()}.png")
    FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bitmap.recycle()
    tempFiles.add(file)
    return file
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
