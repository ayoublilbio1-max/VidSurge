package expo.modules.vidsurgeengine

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.Effect
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
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
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

private const val ENGINE_VERSION = 3

/** At most this many PIP clips are drawn into an export (each is a texture in one GL pass). */
private const val MAX_PIP_OVERLAYS = 12

/**
 * VidSurge engine (Android, Media3) — engine v3.
 *
 *   - VidsurgePreviewView / VidsurgePipView: the editor's native preview
 *     (see VidsurgePreviewView.kt).
 *   - exportVideo: writes the edit to an .mp4. The timeline is built by the
 *     SAME code as the preview (TimelineBuilder), on ONE picture track
 *     (the path that works on every phone); over it: the PIP clips
 *     (pictures read from their files), then the texts + stickers (pictures
 *     drawn by the app's own text component).
 *
 * The JSON "plan" is described in modules/vidsurge-engine/index.ts.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class, ExperimentalApi::class])
class VidsurgeEngineModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var transformer: Transformer? = null
  private var pending: Promise? = null
  private var progressRunnable: Runnable? = null
  private var pipOverlays: MutableList<PipOverlay> = mutableListOf()

  override fun definition() = ModuleDefinition {
    Name("VidsurgeEngine")

    Events("onProgress")

    OnCreate {
      // Silence / still files from the last session.
      appContext.reactContext?.let { TimelineBuilder.clearFiles(it) }
    }

    // Which engine this app build has (JS checks it: a new JS bundle on an
    // old app build can't use what only the new engine has).
    // 1 = v0.17 (main video + audio), 2 = v0.18 (+ texts, stickers),
    // 3 = native preview + everything on one track.
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
        promise.reject("ERR_SETUP", "Export setup failed: ${describeError(e)}", e)
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

    // Timeline thumbnails: the exact frame at each time (ms), `height` px
    // tall. Runs on Expo's background queue (never blocks the screen).
    AsyncFunction("thumbnails") { uri: String, timesMs: List<Double>, height: Int ->
      val context = appContext.reactContext ?: throw IllegalStateException("No Android context")
      Thumbnails.make(context, uri, timesMs, height)
    }

    View(VidsurgePreviewView::class) {
      Events("onTime", "onPlayback", "onEnded", "onError")
      AsyncFunction("setTimeline") { view: VidsurgePreviewView, json: String, positionMs: Double ->
        view.setTimeline(json, positionMs)
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("play") { view: VidsurgePreviewView ->
        view.play()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("pause") { view: VidsurgePreviewView ->
        view.pause()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("seekTo") { view: VidsurgePreviewView, ms: Double ->
        view.seekTo(ms)
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("setScrubbing") { view: VidsurgePreviewView, on: Boolean ->
        view.setScrubbing(on)
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("setMuted") { view: VidsurgePreviewView, on: Boolean ->
        view.setMuted(on)
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("getPosition") { view: VidsurgePreviewView ->
        view.positionMs()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("capture") { view: VidsurgePreviewView, promise: Promise ->
        view.capture(promise)
      }.runOnQueue(Queues.MAIN)
      OnViewDestroys { view: VidsurgePreviewView ->
        view.release()
      }
    }

    View(VidsurgePipView::class) {
      AsyncFunction("capture") { view: VidsurgePipView, promise: Promise ->
        view.capture(promise)
      }.runOnQueue(Queues.MAIN)
      OnViewDestroys { view: VidsurgePipView ->
        view.release()
      }
    }

    OnDestroy {
      mainHandler.post {
        transformer?.cancel()
        cleanUp()
      }
    }
  }

  // ---- Export ------------------------------------------------------------------------

  private fun startExport(context: Context, plan: JSONObject, promise: Promise) {
    val width = plan.getInt("width")
    val height = plan.getInt("height")
    val bitrate = plan.getInt("videoBitrate")
    val outputPath = plan.getString("outputPath").removePrefix("file://")
    val pip = plan.optJSONArray("pip") ?: JSONArray()
    val overlays = plan.optJSONArray("overlays") ?: JSONArray()

    Log.d(
      TAG,
      "export v$ENGINE_VERSION ${width}x$height @${plan.optDouble("fps", 30.0)}fps ${bitrate / 1000}kbps, " +
        "${plan.optDouble("duration", 0.0)}s, ${pip.length()} PIP, ${overlays.length()} text/sticker picture(s) → $outputPath",
    )

    // ---- Over the whole video: PIP clips, then texts + stickers on top ----
    val topLayers = mutableListOf<TextureOverlay>()
    for (i in 0 until pip.length()) {
      val p = pip.getJSONObject(i)
      if (pipOverlays.size >= MAX_PIP_OVERLAYS) {
        Log.w(TAG, "  PIP $i left out — more than $MAX_PIP_OVERLAYS PIP clips")
        continue
      }
      val startUs = (p.getDouble("start") * 1_000_000).roundToLong()
      val trimInUs = (p.getDouble("trimIn") * 1_000_000).roundToLong()
      val trimOutUs = (p.getDouble("trimOut") * 1_000_000).roundToLong()
      val speed = p.optDouble("speed", 1.0).toFloat().let { if (it > 0f) it else 1f }
      val lengthUs = ((trimOutUs - trimInUs) / speed).roundToLong()
      if (lengthUs <= 0) continue
      val pw = max(2, p.getDouble("w").roundToInt())
      val ph = max(2, p.getDouble("h").roundToInt())
      val opacity = p.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f)
      val rotation = p.optDouble("rotation", 0.0).toFloat()

      // Where it goes: its centre (as -1..1, y up), its turn, its opacity.
      // The picture is made exactly pw × ph px, so it's drawn at that size.
      val ax = (2f * p.getDouble("cx").toFloat() / width - 1f).coerceIn(-1f, 1f)
      val ay = (1f - 2f * p.getDouble("cy").toFloat() / height).coerceIn(-1f, 1f)
      val settings = StaticOverlaySettings.Builder()
        .setBackgroundFrameAnchor(ax, ay)
        // Media3 turns counter-clockwise; the editor turns clockwise.
        .setRotationDegrees(-rotation)
        .setAlphaScale(opacity)
        .build()

      val uri = p.getString("uri")
      val overlay: PipOverlay =
        if (p.getString("kind") == "video") {
          VideoPipOverlay(context, uri, startUs, startUs + lengthUs, trimInUs, speed, pw, ph, settings)
        } else {
          ImagePipOverlay(context, uri, startUs, startUs + lengthUs, pw, ph, settings)
        }
      pipOverlays.add(overlay)
      topLayers.add(overlay)
      Log.d(
        TAG,
        "  PIP ${p.getString("kind")} @${startUs / 1000}ms ${lengthUs / 1000}ms ${pw}x$ph at " +
          "${"%.3f".format(ax)},${"%.3f".format(ay)} rot $rotation opacity $opacity",
      )
    }

    val segments = mutableListOf<OverlaySegment>()
    for (i in 0 until overlays.length()) {
      val o = overlays.getJSONObject(i)
      segments.add(
        OverlaySegment(
          (o.getDouble("start") * 1_000_000).roundToLong(),
          (o.getDouble("end") * 1_000_000).roundToLong(),
          o.getString("uri").removePrefix("file://"),
        ),
      )
    }
    if (segments.isNotEmpty()) topLayers.add(SegmentOverlay(segments, width, height))

    val topEffects = if (topLayers.isNotEmpty()) listOf<Effect>(OverlayEffect(topLayers)) else listOf()
    val composition = TimelineBuilder.build(context, plan, BuildMode.EXPORT, topEffects).composition

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
          // The whole cause chain + where it broke: the app shows / logs it.
          p?.reject(
            "ERR_EXPORT",
            "${exportException.errorCodeName}: ${describeError(exportException)}",
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
    for (o in pipOverlays) o.closeSource()
    pipOverlays = mutableListOf()
  }
}
