package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.PixelCopy
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.widget.LinearLayout
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.transformer.CompositionPlayer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The editor's preview (native, engine v3).
 *
 * ONE Media3 player (CompositionPlayer) plays the whole edit as a single
 * timeline with its own clock: main video (cuts, speed, crop, turn, mirror,
 * opacity, canvas colour, gaps) and all the sound — built by
 * TimelineBuilder, the same code as the export. No JavaScript is involved
 * while it plays.
 *
 * PIP videos play on a second (silent) player into the PIP view
 * (VidsurgePipView, inside the app's PIP frame so its gestures stay as they
 * are). It's kept in step with the main clock here, at every screen frame.
 *
 * The app sends the timeline (setTimeline) whenever the edit changes. If
 * only live values changed (turn, mirror, opacity, volume, canvas colour —
 * e.g. while a slider moves), the running timeline just takes the new
 * values and redraws its frame; otherwise a new timeline is built at the
 * same position.
 *
 * Events: onTime (every ~50 ms while playing), onPlayback (playing /
 * waiting), onEnded, onError.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class, ExperimentalApi::class])
class VidsurgePreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val onTime by EventDispatcher()
  val onPlayback by EventDispatcher()
  val onEnded by EventDispatcher()
  val onError by EventDispatcher()

  private val surfaceView = SurfaceView(context)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var player: CompositionPlayer? = null
  private var prepared = false
  private var built: BuiltTimeline? = null
  private var structure = ""
  private val pip = PipSync(context)

  /** What the app asked for (the player may still be loading). */
  private var wantPlaying = false
  private var muted = false
  private var released = false
  private var lastTimeEventAt = 0L
  private var lastReportedPlaying: Boolean? = null
  private var redrawPending = false
  /** When the player last drew a frame (any thread). */
  @Volatile private var lastFrameDrawnAt = 0L
  /** The last timeline the app sent (to load it again after a player error). */
  private var lastJson: String? = null
  private var errorReloads = 0
  /** Where the preview was when it stopped after an error (ms). */
  private var lastPositionMs = 0L

  private val frameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (released) return
      onFrame()
      Choreographer.getInstance().postFrameCallback(this)
    }
  }
  private var frameLoopOn = false

  init {
    setBackgroundColor(Color.BLACK)
    orientation = VERTICAL
    addView(surfaceView, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // The video surface got a new size (fullscreen, canvas ratio): while
    // paused, the player doesn't draw by itself — the frame is drawn again
    // at the new size (after the player has taken the new size: posted).
    surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {}

      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        Log.d(TAG, "[preview] surface ${width}x$height")
        if (!wantPlaying) mainHandler.postDelayed({ requestRedraw() }, 50)
      }

      override fun surfaceDestroyed(holder: SurfaceHolder) {}
    })
    Log.d(TAG, "[preview] view created")
  }

  /**
   * React Native sizes this view but never measures the views inside it:
   * without this the video surface kept its first size (picture not fitting
   * after fullscreen / a canvas change until play made it measure again).
   */
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    surfaceView.measure(
      MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY),
    )
    surfaceView.layout(0, 0, w, h)
  }

  // ---- From the app ---------------------------------------------------------------

  fun setTimeline(json: String, positionMs: Double) {
    if (released) return
    // A new edit from the app: a later player error may reload once more.
    if (json != lastJson) errorReloads = 0
    lastJson = json
    val plan = JSONObject(json)
    pip.setClips(plan.optJSONArray("pip"))
    val key = TimelineBuilder.structureKey(plan)
    val current = built
    if (current != null && key == structure) {
      TimelineBuilder.applyLooks(current, plan)
      requestRedraw()
      return
    }
    val startedAt = SystemClock.uptimeMillis()
    val next = try {
      TimelineBuilder.build(context, plan, BuildMode.PREVIEW)
    } catch (e: Exception) {
      Log.e(TAG, "[preview] couldn't build the timeline", e)
      onError(mapOf("message" to "Couldn't load the preview: ${describeError(e)}"))
      return
    }
    built = next
    structure = key
    val p = ensurePlayer()
    val at = positionMs.roundToLong().coerceIn(0L, next.durationUs / 1000)
    try {
      p.setComposition(next.composition, at)
      if (!prepared) {
        p.prepare()
        prepared = true
      }
      p.volume = if (muted) 0f else 1f
      if (wantPlaying) p.play()
    } catch (e: Exception) {
      Log.e(TAG, "[preview] couldn't load the timeline", e)
      onError(mapOf("message" to "Couldn't load the preview: ${describeError(e)}"))
      return
    }
    pip.seek(at)
    // Paused: show the new timeline's frame right away (not only on play).
    if (!wantPlaying) mainHandler.postDelayed({ requestRedraw() }, 300)
    Log.d(TAG, "[preview] new timeline at ${at}ms, built in ${SystemClock.uptimeMillis() - startedAt}ms")
  }

  fun play() {
    // Remembered even before the first timeline arrives: setTimeline
    // starts playing then.
    wantPlaying = true
    if (player == null) {
      retryAfterError(lastPositionMs)
      return
    }
    val p = player ?: return
    if (p.playbackState == Player.STATE_ENDED) p.seekTo(0)
    p.play()
    Log.d(TAG, "[preview] play @ ${p.currentPosition}ms")
  }

  /** Pauses and returns where the picture stopped (ms). */
  fun pause(): Double {
    wantPlaying = false
    val p = player ?: return 0.0
    p.pause()
    val at = p.currentPosition
    pip.sync(at, false)
    Log.d(TAG, "[preview] pause @ ${at}ms")
    return at.toDouble()
  }

  fun seekTo(ms: Double) {
    val at = ms.roundToLong().coerceAtLeast(0L)
    if (player == null) {
      retryAfterError(at)
      return
    }
    val p = player ?: return
    p.seekTo(at)
    pip.seek(at)
  }

  fun setScrubbing(on: Boolean) {
    val p = player ?: return
    if (p.isScrubbingModeEnabled == on) return
    p.setScrubbingModeEnabled(on)
    // Leaving scrubbing mode must not start playback by itself.
    if (!on && !wantPlaying) p.pause()
    Log.d(TAG, "[preview] scrubbing ${if (on) "on" else "off"}")
  }

  fun setMuted(on: Boolean) {
    muted = on
    player?.volume = if (on) 0f else 1f
  }

  fun positionMs(): Double = (player?.currentPosition ?: 0L).toDouble()

  /** Saves what the main picture shows right now as a PNG (for "capture"). */
  fun capture(promise: Promise) {
    val w = surfaceView.width
    val h = surfaceView.height
    if (w <= 0 || h <= 0 || !surfaceView.holder.surface.isValid) {
      promise.reject("ERR_CAPTURE", "The preview isn't on screen", null)
      return
    }
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    PixelCopy.request(surfaceView, bitmap, { result ->
      if (result != PixelCopy.SUCCESS) {
        bitmap.recycle()
        promise.reject("ERR_CAPTURE", "Couldn't copy the preview ($result)", null)
        return@request
      }
      try {
        promise.resolve(savePng(context, bitmap, "preview"))
      } catch (e: Exception) {
        promise.reject("ERR_CAPTURE", "Couldn't save the preview picture", e)
      } finally {
        bitmap.recycle()
      }
    }, mainHandler)
  }

  fun release() {
    if (released) return
    released = true
    stopFrameLoop()
    try {
      player?.release()
    } catch (e: Exception) {
      Log.w(TAG, "[preview] release", e)
    }
    player = null
    pip.release()
    Log.d(TAG, "[preview] released")
  }

  // ---- Player --------------------------------------------------------------------

  private fun ensurePlayer(): CompositionPlayer {
    player?.let { return it }
    val p = CompositionPlayer.Builder(context)
      // Lets a paused frame be redrawn with new live values (sliders).
      .experimentalSetEnableReplayableCache(true)
      .build()
    p.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
          wantPlaying = false
          // Media3 keeps "play" on at the end: a later seek would start
          // playing by itself.
          player?.pause()
          val at = (built?.durationUs ?: 0L) / 1000
          Log.d(TAG, "[preview] reached the end (${at}ms)")
          onEnded(mapOf("time" to at / 1000.0))
        }
        reportPlayback()
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        reportPlayback()
      }

      override fun onPlayerError(error: PlaybackException) {
        Log.e(TAG, "[preview] player error (${error.errorCodeName})", error)
        wantPlaying = false
        onError(mapOf("message" to "${error.errorCodeName}: ${describeError(error)}"))
        // Media3 keeps a player in its error state for good: a new player,
        // the same edit loaded again where it was (once per edit).
        mainHandler.post { reloadAfterError() }
      }
    })
    // Every drawn frame (also a paused frame redrawn with new live values).
    p.setVideoFrameMetadataListener { _, _, _, _ ->
      lastFrameDrawnAt = SystemClock.uptimeMillis()
    }
    p.setVideoSurfaceView(surfaceView)
    player = p
    startFrameLoop()
    Log.d(TAG, "[preview] player created")
    return p
  }

  /** Tells the app whether time is really moving (playing) or waiting (loading). */
  private fun reportPlayback() {
    val p = player ?: return
    val moving = p.isPlaying
    if (lastReportedPlaying == moving) return
    lastReportedPlaying = moving
    onPlayback(
      mapOf(
        "playing" to moving,
        "waiting" to (wantPlaying && !moving),
        "time" to p.currentPosition / 1000.0,
      ),
    )
  }

  /**
   * A paused frame drawn again with the new live values (at most ~30 times
   * a second). If no frame came out shortly after, the same moment is shown
   * again with a seek (slower, always works).
   */
  private fun requestRedraw() {
    val p = player ?: return
    if (wantPlaying || redrawPending) return
    redrawPending = true
    mainHandler.postDelayed({
      redrawPending = false
      if (released || wantPlaying || player !== p) return@postDelayed
      val askedAt = SystemClock.uptimeMillis()
      try {
        p.experimentalRedrawLastFrame()
      } catch (e: Exception) {
        Log.w(TAG, "[preview] redraw not possible — showing the frame again", e)
        p.seekTo(p.currentPosition)
        return@postDelayed
      }
      mainHandler.postDelayed({
        if (released || wantPlaying || player !== p) return@postDelayed
        if (lastFrameDrawnAt < askedAt) {
          Log.d(TAG, "[preview] redraw didn't come — showing the frame again")
          p.seekTo(p.currentPosition)
        }
      }, 250)
    }, 33)
  }

  /**
   * The preview gave up after errors (no player): the user pressed play or
   * moved the playhead — load the last edit again there (a fresh try).
   */
  private fun retryAfterError(atMs: Long) {
    if (released) return
    val json = lastJson ?: return
    lastPositionMs = atMs
    errorReloads = 0
    Log.d(TAG, "[preview] trying the edit again @ ${atMs}ms (after an error)")
    setTimeline(json, atMs.toDouble())
  }

  /** After a player error: a new player, the last edit, where it was. */
  private fun reloadAfterError() {
    if (released) return
    val json = lastJson ?: return
    val at = player?.currentPosition ?: lastPositionMs
    lastPositionMs = at
    try {
      player?.release()
    } catch (e: Exception) {
      Log.w(TAG, "[preview] release after error", e)
    }
    player = null
    prepared = false
    built = null
    structure = ""
    lastReportedPlaying = null
    if (errorReloads >= 1) {
      Log.w(TAG, "[preview] not reloading again (it failed twice with this edit)")
      return
    }
    errorReloads++
    Log.d(TAG, "[preview] reloading the edit after an error @ ${at}ms")
    setTimeline(json, at.toDouble())
  }

  // ---- Every screen frame: PIP in step, time to the app ------------------------------

  private fun onFrame() {
    val p = player ?: return
    val at = p.currentPosition
    pip.sync(at, p.isPlaying)
    if (wantPlaying) {
      val now = SystemClock.uptimeMillis()
      if (now - lastTimeEventAt >= 50) {
        lastTimeEventAt = now
        onTime(mapOf("time" to at / 1000.0, "playing" to p.isPlaying))
      }
    }
  }

  private fun startFrameLoop() {
    if (frameLoopOn || released) return
    frameLoopOn = true
    Choreographer.getInstance().postFrameCallback(frameCallback)
  }

  private fun stopFrameLoop() {
    if (!frameLoopOn) return
    frameLoopOn = false
    Choreographer.getInstance().removeFrameCallback(frameCallback)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (player != null) startFrameLoop()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    stopFrameLoop()
  }
}

/** Saves a bitmap as PNG in the cache; returns its file:// uri. */
internal fun savePng(context: Context, bitmap: Bitmap, name: String): String {
  val file = File(context.cacheDir, "vidsurge-$name-${System.currentTimeMillis()}.png")
  FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
  return "file://${file.absolutePath}"
}

// ---- PIP ------------------------------------------------------------------------------------

/** The PIP view on screen (the app shows one PIP at a time). */
internal object PipViews {
  private var current: WeakReference<VidsurgePipView>? = null

  fun register(view: VidsurgePipView) {
    current = WeakReference(view)
  }

  fun unregister(view: VidsurgePipView) {
    if (current?.get() === view) current = null
  }

  fun textureView(): TextureView? = current?.get()?.textureView
}

/** One PIP video clip (timeline ms; source = the clipped part of the file). */
private class PipClip(
  val id: String,
  val uri: String,
  val startMs: Long,
  val endMs: Long,
  val trimInUs: Long,
  val trimOutUs: Long,
  val speed: Float,
)

/**
 * Plays the PIP video under the playhead on its own silent player, into the
 * PIP view, in step with the main clock:
 *   - loaded (and parked on its first frame) up to 2 s before it begins,
 *   - while the main video plays: playing at the clip's speed, nudged a
 *     little faster / slower to stay within a few frames; jumped only when
 *     far off,
 *   - while paused / scrubbing: shows exactly the frame of the playhead.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
private class PipSync(context: Context) {
  private val exo: ExoPlayer = ExoPlayer.Builder(context).build().apply {
    volume = 0f
    repeatMode = Player.REPEAT_MODE_OFF
  }
  private var clips: List<PipClip> = emptyList()
  private var loaded: PipClip? = null
  private var attached: TextureView? = null
  private var lastSeekTarget = -1L
  private var lastJumpAt = 0L
  private var rate = 1f

  fun setClips(arr: JSONArray?) {
    val list = mutableListOf<PipClip>()
    if (arr != null) {
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        if (o.optString("kind", "video") != "video") continue
        val speed = o.optDouble("speed", 1.0).toFloat().let { if (it > 0f) it else 1f }
        val trimIn = (o.getDouble("trimIn") * 1_000_000).roundToLong()
        val trimOut = (o.getDouble("trimOut") * 1_000_000).roundToLong()
        if (trimOut <= trimIn) continue
        val startMs = (o.getDouble("start") * 1000).roundToLong()
        list.add(
          PipClip(
            o.optString("id", "pip-$i"),
            o.getString("uri"),
            startMs,
            startMs + ((trimOut - trimIn) / 1000 / speed).roundToLong(),
            trimIn,
            trimOut,
            speed,
          ),
        )
      }
    }
    clips = list.sortedBy { it.startMs }
    val l = loaded
    // The loaded clip changed (trimmed, moved, deleted): load it again.
    if (l != null && clips.none { it.id == l.id && it.uri == l.uri && it.trimInUs == l.trimInUs && it.trimOutUs == l.trimOutUs && it.startMs == l.startMs && it.speed == l.speed }) {
      loaded = null
      lastSeekTarget = -1
    }
  }

  /** The playhead jumped: the PIP follows on the next frame. */
  fun seek(atMs: Long) {
    lastSeekTarget = -1
    sync(atMs, false)
  }

  fun sync(atMs: Long, mainPlaying: Boolean) {
    // Draw into the PIP view that's on screen now.
    val view = PipViews.textureView()
    if (view !== attached) {
      if (view != null) exo.setVideoTextureView(view) else exo.clearVideoSurface()
      attached = view
    }

    val clip = clips.firstOrNull { atMs >= it.startMs && atMs < it.endMs }
      ?: clips.firstOrNull { it.startMs > atMs && it.startMs - atMs <= 2000 }
    if (clip == null) {
      if (exo.playWhenReady) exo.pause()
      return
    }
    if (loaded?.id != clip.id) {
      exo.setMediaItem(TimelineBuilder.clippedItem(clip.uri, clip.trimInUs, clip.trimOutUs))
      exo.prepare()
      exo.playWhenReady = false
      loaded = clip
      lastSeekTarget = -1
      rate = 1f
      exo.playbackParameters = PlaybackParameters(clip.speed)
      Log.d(TAG, "[preview] PIP ${clip.id} loaded (${clip.startMs}–${clip.endMs}ms)")
    }
    val inside = atMs >= clip.startMs && atMs < clip.endMs
    val wantedMs = if (inside) ((atMs - clip.startMs) * clip.speed).roundToLong() else 0L

    if (mainPlaying && inside) {
      val now = SystemClock.uptimeMillis()
      if (!exo.playWhenReady) {
        exo.seekTo(wantedMs)
        rate = 1f
        exo.playbackParameters = PlaybackParameters(clip.speed)
        exo.play()
        lastJumpAt = now
        return
      }
      if (exo.playbackState != Player.STATE_READY) return
      val drift = exo.currentPosition - wantedMs // + = PIP ahead
      if (abs(drift) > 300 && now - lastJumpAt > 1000) {
        // Far off (it was still loading): jump, a little ahead.
        exo.seekTo(wantedMs + 120)
        lastJumpAt = now
        Log.d(TAG, "[preview] PIP ${clip.id} off by ${drift}ms — jumped")
        return
      }
      // Close: play up to 8% faster / slower until in step.
      val fix = (1f - drift / 1000f).coerceIn(0.92f, 1.08f)
      if (abs(fix - rate) > 0.01f) {
        rate = fix
        exo.playbackParameters = PlaybackParameters(clip.speed * fix)
      }
    } else {
      if (exo.playWhenReady) exo.pause()
      if (rate != 1f) {
        rate = 1f
        exo.playbackParameters = PlaybackParameters(clip.speed)
      }
      // Paused / scrubbing: the exact frame (one seek per new position).
      if (wantedMs != lastSeekTarget) {
        lastSeekTarget = wantedMs
        exo.seekTo(wantedMs)
      }
    }
  }

  fun release() {
    try {
      exo.release()
    } catch (e: Exception) {
      Log.w(TAG, "[preview] PIP release", e)
    }
  }
}
