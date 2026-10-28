package expo.modules.openbeemedia

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val EVENT = "onMediaChanged"
private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"

// Values of MediaCmd in app/src/core/proto.ts.
private const val CMD_TOGGLE = 0
private const val CMD_NEXT = 1
private const val CMD_PREV = 2
private const val CMD_VOL_UP = 3
private const val CMD_VOL_DOWN = 4

class OpenbeeMediaModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  // Written on the main thread, read by Functions on the JS thread.
  @Volatile private var controller: MediaController? = null
  private var sessionsListenerRegistered = false
  private var volumeReceiverRegistered = false

  // Application context, kept so stop() can still unregister after the React context is gone.
  private var appCtx: Context? = null
  private val ctx: Context
    get() = appCtx
      ?: (appContext.reactContext?.applicationContext ?: throw IllegalStateException("No React context"))
        .also { appCtx = it }
  private val sessionManager: MediaSessionManager?
    get() = ctx.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager
  private val audio: AudioManager
    get() = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val listenerComponent: ComponentName
    get() = ComponentName(ctx, MediaListenerService::class.java)

  private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
    attach(list?.firstOrNull())
  }

  private val controllerCallback = object : MediaController.Callback() {
    override fun onMetadataChanged(metadata: MediaMetadata?) = emit()
    override fun onPlaybackStateChanged(state: PlaybackState?) = emit()
    override fun onSessionDestroyed() = refresh()
  }

  private val volumeReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) = emit()
  }

  override fun definition() = ModuleDefinition {
    Name("OpenbeeMedia")

    Events(EVENT)

    OnCreate { start() }
    OnDestroy { stop() }
    // Access may have been granted while we were in the settings screen.
    OnActivityEntersForeground { start() }

    Function("isPermissionGranted") { isPermissionGranted() }

    Function("openPermissionSettings") {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
    }

    Function("getState") { snapshot() }

    Function("command") { cmd: Int -> runCommand(cmd) }
  }

  private fun isPermissionGranted(): Boolean {
    val enabled = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
      ?: return false
    return enabled.split(':').any {
      ComponentName.unflattenFromString(it)?.packageName == ctx.packageName
    }
  }

  /** Active sessions, most recently active first; empty without notification access. */
  private fun activeSessions(): List<MediaController> = try {
    sessionManager?.getActiveSessions(listenerComponent) ?: emptyList()
  } catch (e: SecurityException) {
    emptyList()
  }

  private fun start() {
    main.post {
      if (appCtx == null && appContext.reactContext == null) return@post
      if (!volumeReceiverRegistered) {
        val filter = IntentFilter(VOLUME_CHANGED_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          ctx.registerReceiver(volumeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
          ctx.registerReceiver(volumeReceiver, filter)
        }
        volumeReceiverRegistered = true
      }
      if (!sessionsListenerRegistered) {
        try {
          sessionManager?.addOnActiveSessionsChangedListener(sessionsListener, listenerComponent, main)
          sessionsListenerRegistered = true
        } catch (e: SecurityException) {
          // No notification access yet; start() runs again on foreground.
        }
      }
      refresh()
    }
  }

  private fun stop() {
    main.post {
      if (sessionsListenerRegistered) {
        sessionManager?.removeOnActiveSessionsChangedListener(sessionsListener)
        sessionsListenerRegistered = false
      }
      if (volumeReceiverRegistered) {
        ctx.unregisterReceiver(volumeReceiver)
        volumeReceiverRegistered = false
      }
      controller?.unregisterCallback(controllerCallback)
      controller = null
    }
  }

  private fun refresh() = attach(activeSessions().firstOrNull())

  private fun attach(next: MediaController?) {
    val prev = controller
    if (prev?.sessionToken != next?.sessionToken) {
      prev?.unregisterCallback(controllerCallback)
      next?.registerCallback(controllerCallback, main)
      controller = next
    }
    emit()
  }

  private fun volumePct(): Int? {
    val am = audio
    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    if (max <= 0) return null
    return am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100 / max
  }

  private fun snapshot(): Map<String, Any?> {
    val c = controller
    val meta = c?.metadata
    val ps = c?.playbackState?.state
    val state = when {
      c == null -> 0
      ps == PlaybackState.STATE_PLAYING || ps == PlaybackState.STATE_BUFFERING -> 1
      else -> 2 // PAUSED, STOPPED, or no playback state yet
    }
    val artist = meta?.getString(MediaMetadata.METADATA_KEY_ARTIST)
      ?: meta?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
    return mapOf(
      "state" to state,
      "title" to (meta?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""),
      "artist" to (artist ?: ""),
      "volumePct" to volumePct()
    )
  }

  private fun emit() {
    sendEvent(EVENT, snapshot())
  }

  private fun runCommand(cmd: Int) {
    val c = controller
    when (cmd) {
      CMD_TOGGLE -> toggle()
      CMD_NEXT -> c?.transportControls?.skipToNext()
      CMD_PREV -> c?.transportControls?.skipToPrevious()
      CMD_VOL_UP -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0)
      CMD_VOL_DOWN -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, 0)
      else -> Unit
    }
  }

  private fun toggle() {
    val c = controller
    if (c == null) {
      // No session: a media key resumes the last player.
      val am = audio
      am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY))
      am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY))
      return
    }
    val ps = c.playbackState?.state
    if (ps == PlaybackState.STATE_PLAYING || ps == PlaybackState.STATE_BUFFERING) {
      c.transportControls.pause()
    } else {
      c.transportControls.play()
    }
  }
}
