package com.relaybox

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RelayWorker(c: Context, p: WorkerParameters) : Worker(c, p) {
  class Completion { val latch = CountDownLatch(1); var retry = true }
  companion object {
    private val running = ConcurrentHashMap<String, Completion>()
    fun finish(token: String, retry: Boolean) { running[token]?.let { it.retry = retry; it.latch.countDown() } }
  }
  override fun doWork(): Result {
    if (!RelayDisk.prefs(applicationContext).getBoolean("enabled", false) &&
      !RelayDisk.prefs(applicationContext).getBoolean("voicePending", false)) return Result.success()
    val token = UUID.randomUUID().toString()
    val completion = Completion(); running[token] = completion
    val handler = Handler(Looper.getMainLooper())
    val manager = (applicationContext as MainApplication).reactNativeHost.reactInstanceManager
    var listener: ReactInstanceEventListener? = null
    fun start(context: ReactContext) {
      if (isStopped || !running.containsKey(token)) return
      val args = Arguments.createMap().apply { putString("token", token) }
      HeadlessJsTaskContext.getInstance(context).startTask(HeadlessJsTaskConfig("RelayboxFlush", args, 110_000, true))
    }
    handler.post {
      try {
        val context = manager.currentReactContext
        if (context != null) start(context) else {
          listener = object : ReactInstanceEventListener {
            override fun onReactContextInitialized(ctx: ReactContext) {
              listener?.let { manager.removeReactInstanceEventListener(it) }; start(ctx)
            }
          }
          manager.addReactInstanceEventListener(listener!!)
          if (!manager.hasStartedCreatingInitialContext()) manager.createReactContextInBackground()
        }
      } catch (_: Exception) { completion.latch.countDown() }
    }
    try {
      if (!completion.latch.await(115, TimeUnit.SECONDS)) {
        RelayDisk.issue(applicationContext, "Background delivery timed out. Pending messages will retry.")
        return Result.retry()
      }
      return if (completion.retry) Result.retry() else Result.success()
    } finally {
      running.remove(token)
      handler.post { listener?.let { manager.removeReactInstanceEventListener(it) } }
    }
  }
}
