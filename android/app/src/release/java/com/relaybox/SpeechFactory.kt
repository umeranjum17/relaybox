package com.relaybox

import android.content.Context

object SpeechFactory {
  const val debugAvailable = false
  fun create(context: Context, debug: Boolean, state: (String, String) -> Unit, result: (String?, String?) -> Unit): SpeechSession {
    require(!debug)
    return AndroidSpeech(context, state, result)
  }
}
