package com.relaybox

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

interface SpeechSession {
  fun start()
  fun finish()
  fun cancel()
}

class AndroidSpeech(
  private val context: Context,
  private val state: (String, String) -> Unit,
  private val result: (String?, String?) -> Unit
) : SpeechSession, RecognitionListener {
  private var recognizer: SpeechRecognizer? = null
  private var engine = ""
  override fun start() {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      result(null, "Microphone access denied. Retry or allow Microphone in app Settings."); return
    }
    try {
      val local = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
      engine = if (local) "Android on-device SpeechRecognizer" else
        "Android SpeechRecognizer · ${Settings.Secure.getString(context.contentResolver, "voice_recognition_service") ?: "system default"}"
      if (!local && !SpeechRecognizer.isRecognitionAvailable(context)) {
        result(null, "No Android speech recognizer installed. Install or enable one in system settings, then Retry. You can still type."); return
      }
      recognizer = if (local) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
      recognizer!!.setRecognitionListener(this)
      state("processing", engine)
      recognizer!!.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      })
    } catch (_: Exception) { result(null, "Speech recognizer could not start. Retry or type your prompt.") }
  }
  override fun finish() { recognizer?.stopListening() }
  override fun cancel() { recognizer?.cancel(); recognizer?.destroy(); recognizer = null }
  override fun onReadyForSpeech(params: Bundle?) { state("listening", engine) }
  override fun onBeginningOfSpeech() {}
  override fun onEndOfSpeech() { state("processing", engine) }
  override fun onResults(results: Bundle?) {
    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
    if (text.isNullOrBlank()) result(null, "No speech matched. Retry or type your prompt.") else result(text, null)
  }
  override fun onError(error: Int) {
    val message = when (error) {
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech heard. Retry and speak after Listening appears."
      SpeechRecognizer.ERROR_NO_MATCH -> "No speech matched. Retry or type your prompt."
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone access denied. Retry or allow Microphone in app Settings."
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy. Retry in a moment."
      SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Recognition connection failed. Retry or type your prompt."
      else -> "Speech recognition stopped. Retry or type your prompt."
    }
    result(null, message)
  }
  override fun onRmsChanged(rmsdB: Float) {}
  override fun onBufferReceived(buffer: ByteArray?) {} // Never store or emit audio.
  override fun onPartialResults(partialResults: Bundle?) {}
  override fun onEvent(eventType: Int, params: Bundle?) {}
}

class SpeechModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val handler = Handler(Looper.getMainLooper())
  private var session: SpeechSession? = null
  private var pending: Promise? = null
  private var generation = 0
  private var deadline: Runnable? = null
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "RelaySpeech"
  override fun getConstants(): MutableMap<String, Any> = mutableMapOf("debugAvailable" to SpeechFactory.debugAvailable)
  @ReactMethod fun addListener(name: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
  private fun settle(text: String?, error: String?) {
    val p = pending ?: return
    pending = null; generation++
    deadline?.let { handler.removeCallbacks(it) }; deadline = null
    session?.cancel(); session = null
    if (error != null) p.reject("SPEECH", error) else p.resolve(text)
  }
  @ReactMethod fun start(debug: Boolean, p: Promise) { handler.post {
    if (pending != null) { p.reject("SPEECH", "Recognition already running."); return@post }
    pending = p
    val run = ++generation
    try {
      session = SpeechFactory.create(context, debug, { phase, engine ->
        if (run == generation) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("RelaySpeechState", Arguments.createMap().apply { putString("phase", phase); putString("engine", engine) })
      }, { text, error -> if (run == generation) settle(text, error) })
      deadline = Runnable { settle(null, "Recognition timed out. Retry or type your prompt.") }.also { handler.postDelayed(it, 45000) }
      session!!.start()
    } catch (_: Exception) { settle(null, "Recognition unavailable. Retry or type your prompt.") }
  } }
  @ReactMethod fun finish() { handler.post { try { session?.finish() } catch (_: Exception) { settle(null, "Recognition stopped. Retry.") } } }
  @ReactMethod fun cancel() { handler.post { settle(null, "Recording cancelled. Retry or type your prompt. Nothing was sent.") } }
  override fun onHostPause() { cancel() }
  override fun onHostResume() {}
  override fun onHostDestroy() { cancel() }
  override fun invalidate() { context.removeLifecycleEventListener(this); cancel(); super.invalidate() }
}
