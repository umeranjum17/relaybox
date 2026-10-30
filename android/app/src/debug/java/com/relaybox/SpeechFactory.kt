package com.relaybox

import android.content.Context
import android.os.Handler
import android.os.Looper

/** Compiled only into debug. No fixture transcript or implementation exists in release. */
object SpeechFactory {
  const val debugAvailable = true
  fun create(context: Context, debug: Boolean, state: (String, String) -> Unit, result: (String?, String?) -> Unit): SpeechSession {
    if (!debug) return AndroidSpeech(context, state, result)
    return object : SpeechSession {
      private val handler = Handler(Looper.getMainLooper())
      private val ready = Runnable { state("listening", "DEBUG transcript substitute · no microphone") }
      private val done = Runnable { result("Synthetic planning prompt.", null) }
      override fun start() { handler.post(ready) }
      override fun finish() {
        handler.removeCallbacks(ready)
        state("processing", "DEBUG transcript substitute · no microphone")
        handler.postDelayed(done, 700)
      }
      override fun cancel() { handler.removeCallbacks(ready); handler.removeCallbacks(done) }
    }
  }
}
