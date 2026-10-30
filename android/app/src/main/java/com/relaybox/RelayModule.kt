package com.relaybox

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.work.*
import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Date
import java.util.Properties
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.mail.Session
import javax.mail.Message
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeMessage

/** Private encrypted spool bridges the broadcast transaction to the JS journal. No SMS database access. */
object RelayDisk {
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (store.getKey("relaybox", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder("relaybox", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      generateKey()
    }
  }
  @Synchronized fun seal(text: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }
  @Synchronized fun open(text: String): String {
    val bytes = Base64.decode(text, Base64.NO_WRAP)
    return Cipher.getInstance("AES/GCM/NoPadding").run {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
  }
  private fun file(c: Context) = File(c.noBackupFilesDir, "sms-spool")
  @Synchronized fun pending(c: Context): JSONArray = if (file(c).exists()) JSONArray(open(file(c).readText())) else JSONArray()
  @Synchronized fun save(c: Context, messages: JSONArray) {
    val f = file(c)
    val temp = File(c.noBackupFilesDir, "sms-spool.tmp")
    java.io.FileOutputStream(temp).use { it.write(seal(messages.toString()).toByteArray()); it.fd.sync() }
    check(temp.renameTo(f)) { "Unable to persist incoming SMS" }
  }
  @Synchronized fun clear(c: Context) { check(!file(c).exists() || file(c).delete()) { "Unable to clear local SMS data" } }
  @Synchronized fun add(c: Context, sms: JSONObject) { save(c, pending(c).put(sms)) }
  @Synchronized fun ack(c: Context, ids: Set<String>) {
    val old = pending(c); val next = JSONArray()
    for (i in 0 until old.length()) { if (old.getJSONObject(i).getString("id") !in ids) next.put(old.getJSONObject(i)) }
    save(c, next)
  }
  fun prefs(c: Context) = c.getSharedPreferences("relay-state", Context.MODE_PRIVATE)
  fun issue(c: Context, text: String) { prefs(c).edit().putString("issue", text).commit() }
  fun digest(sender: String, timestamp: Long, count: Int, body: String): String = MessageDigest.getInstance("SHA-256")
    .digest("${sender.trim().lowercase(java.util.Locale.ROOT)}\u0000$timestamp\u0000$count\u0000$body".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

object RelaySchedule {
  fun wake(c: Context) {
    val request = OneTimeWorkRequestBuilder<RelayWorker>().setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
    WorkManager.getInstance(c).enqueueUniqueWork("relaybox-inbox", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
  }
  fun heartbeat(c: Context, enabled: Boolean) {
    if (enabled) {
      WorkManager.getInstance(c).enqueueUniquePeriodicWork("relaybox-heartbeat", ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<RelayWorker>(15, TimeUnit.MINUTES).build())
      wake(c)
    } else WorkManager.getInstance(c).cancelUniqueWork("relaybox-heartbeat")
  }
}

class RelayPackage : ReactPackage {
  override fun createNativeModules(c: ReactApplicationContext) = listOf(RelayModule(c))
  override fun createViewManagers(c: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
class RelayModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val io = Executors.newSingleThreadExecutor()
  override fun getName() = "Relay"
  private fun run(p: Promise, work: () -> Any?) { io.execute { try { p.resolve(work()) } catch (_: Exception) { p.reject("STORAGE", "Secure local storage failed. Your rule has not been changed; retry or delete local data.") } } }
  @ReactMethod fun seal(text: String, p: Promise) = run(p) { RelayDisk.seal(text) }
  @ReactMethod fun open(text: String, p: Promise) = run(p) { RelayDisk.open(text) }
  @ReactMethod fun hasPassword(p: Promise) = run(p) {
    RelayDisk.prefs(context).contains("password")
  }
  @ReactMethod fun setPassword(text: String, p: Promise) = run(p) {
    check(RelayDisk.prefs(context).edit().putString("password", RelayDisk.seal(text)).commit()); null
  }
  @ReactMethod fun pending(p: Promise) = run(p) { RelayDisk.pending(context).toString() }
  @ReactMethod fun ack(ids: ReadableArray, p: Promise) = run(p) { RelayDisk.ack(context, ids.toArrayList().map { it as String }.toSet()); null }
  @ReactMethod fun enabled(enabled: Boolean, p: Promise) = run(p) {
    check(RelayDisk.prefs(context).edit().putBoolean("enabled", enabled).commit()); RelaySchedule.heartbeat(context, enabled); null
  }
  @ReactMethod fun wake(p: Promise) = run(p) { RelaySchedule.wake(context); null }
  @ReactMethod fun permission(p: Promise) { p.resolve(context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED) }
  @ReactMethod fun issue(p: Promise) { p.resolve(RelayDisk.prefs(context).getString("issue", null)) }
  @ReactMethod fun complete(token: String, retry: Boolean) { RelayWorker.finish(token, retry) }
  @ReactMethod fun erase(p: Promise) = run(p) {
    check(RelayDisk.prefs(context).edit().clear().commit()); RelayDisk.clear(context);
    WorkManager.getInstance(context).cancelUniqueWork("relaybox-heartbeat");
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("relaybox") }; null
  }
  @ReactMethod fun send(config: ReadableMap, mail: ReadableMap, p: Promise) {
    io.execute {
      var password = ""
      val body = mail.getString("body") ?: ""
      try {
        val host = config.getString("host") ?: ""
        val port = config.getInt("port")
        require(host.matches(Regex("[a-zA-Z0-9.-]+"))) { "Invalid SMTP hostname" }
        require(port == 587 || port == 465 || (BuildConfig.DEBUG && host == "localhost" && port == 2525)) { "Use SMTP TLS port 587 or 465" }
        val username = config.getString("username") ?: ""
        val destination = config.getString("destination") ?: ""
        require(!username.contains('\n') && !username.contains('\r') && !destination.contains('\n') && !destination.contains('\r')) { "Invalid email headers" }
        password = RelayDisk.prefs(context).getString("password", null)?.let { RelayDisk.open(it) } ?: error("Set an app password first")
        val props = Properties().apply {
          setProperty("mail.smtp.auth", "true")
          setProperty("mail.smtp.connectiontimeout", "15000"); setProperty("mail.smtp.timeout", "15000"); setProperty("mail.smtp.writetimeout", "15000")
          setProperty("mail.smtp.ssl.checkserveridentity", "true")
          setProperty("mail.smtp.ssl.protocols", "TLSv1.2 TLSv1.3")
          setProperty("mail.smtp.ssl.enable", (port == 465).toString())
          setProperty("mail.smtp.starttls.enable", (port != 465).toString())
          setProperty("mail.smtp.starttls.required", (port != 465).toString())
        }
        val session = Session.getInstance(props) // debug intentionally never enabled
        val msg = MimeMessage(session).apply {
          setFrom(InternetAddress(username, true)); setRecipients(Message.RecipientType.TO, InternetAddress.parse(destination, true))
          setSubject(mail.getString("subject"), "UTF-8"); setText(body, "UTF-8")
          sentDate = Date(); setHeader("X-Relaybox-Id", mail.getString("id")); saveChanges()
        }
        session.getTransport("smtp").use { transport ->
          transport.connect(host, port, username, password)
          transport.sendMessage(msg, msg.allRecipients)
        }
        p.resolve(null)
      } catch (e: Exception) {
        var reason = "${e.javaClass.simpleName}: ${e.message ?: "SMTP connection failed"}"
        for (secret in listOf(password, body).filter { it.isNotEmpty() }) reason = reason.replace(secret, "[redacted]")
        p.reject("SMTP", reason.take(600))
      }
    }
  }
}
