package expo.modules.vidsurgeengine

import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.TextureView
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.views.ExpoView

/**
 * Where the PIP video is drawn: a TextureView (an ordinary view, so the
 * app's PIP frame can move, size, turn and fade it like before). The
 * preview (VidsurgePreviewView) plays the PIP clip into whichever PIP view
 * is on screen, in step with the main video.
 */
class VidsurgePipView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  val textureView = TextureView(context)

  init {
    setBackgroundColor(Color.TRANSPARENT)
    orientation = VERTICAL
    addView(textureView, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  /** React Native sizes this view but never measures the one inside it (see VidsurgePreviewView). */
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    textureView.measure(
      MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY),
    )
    textureView.layout(0, 0, w, h)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    PipViews.register(this)
    Log.d(TAG, "[preview] PIP view on screen")
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    PipViews.unregister(this)
  }

  /** Saves what the PIP shows right now as a PNG (for "capture"). */
  fun capture(promise: Promise) {
    val bitmap = textureView.bitmap
    if (bitmap == null) {
      promise.reject("ERR_CAPTURE", "The PIP isn't on screen", null)
      return
    }
    try {
      promise.resolve(savePng(context, bitmap, "pip"))
    } catch (e: Exception) {
      promise.reject("ERR_CAPTURE", "Couldn't save the PIP picture", e)
    } finally {
      bitmap.recycle()
    }
  }

  fun release() {
    PipViews.unregister(this)
  }
}
