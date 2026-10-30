package com.relaybox

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.Executors

class SmsReceiver : BroadcastReceiver() {
  companion object { private val io = Executors.newSingleThreadExecutor() }
  override fun onReceive(c: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION || !RelayDisk.prefs(c).getBoolean("enabled", false)) return
    val pending = goAsync()
    io.execute {
      try {
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        require(parts.isNotEmpty()) { "Empty SMS broadcast" }
        val sender = parts.first().originatingAddress ?: error("Missing sender")
        require(parts.all { it.originatingAddress == sender }) { "Mixed senders in SMS broadcast" }
        val time = parts.first().timestampMillis
        val body = parts.joinToString("") { it.messageBody ?: "" }
        RelayDisk.add(c, JSONObject().put("id", RelayDisk.digest(sender, time, parts.size, body))
          .put("sender", sender).put("timestamp", time).put("bodies", JSONArray(parts.map { it.messageBody ?: "" })))
        RelaySchedule.wake(c)
      } catch (_: Exception) {
        RelayDisk.issue(c, "An incoming SMS could not be queued. Check available storage and reopen Relaybox.")
      } finally { pending.finish() }
    }
  }
}
