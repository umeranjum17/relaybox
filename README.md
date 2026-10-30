# Relaybox

A small personal automation app. **Today: Android incoming SMS → your own email.**
Select exact sender IDs, optionally require a phrase, review the scope, then enable.
There is no hosted service, analytics, mailbox integration, voice recording or generic workflow builder.

## Build & install

Prerequisites: Node **22.18+**, npm, JDK 17 or 21, Android SDK platform/build-tools 35,
NDK `27.1.12297006`, accepted SDK licenses and an authorized Android device.
The source uses React Native 0.79.7 with TypeScript; Android minimum is API 24.

```sh
git clone git@github.com:umeranjum17/relaybox.git
cd relaybox
npm ci
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME=/path/to/your/jdk
npm test
npx tsc --noEmit
cd android
./gradlew --no-daemon --max-workers=2 assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
cd ..
adb -s YOUR_SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s YOUR_SERIAL shell am start -n com.relaybox.app/com.relaybox.MainActivity
```

The debug APK contains its JavaScript bundle and works **without Metro**.
Package: `com.relaybox.app`; label: **Relaybox**. The two selected ABIs cover the tested
arm64 phone and x86_64 emulator. Omit the architecture argument for all template ABIs.
This is a debug-signed sideload, not a store-ready or hardened production release.
Never distribute a release signed with the template debug key.

## Setup: five small steps

1. **Template:** choose “Forward SMS to email”. “Talk to your agent” is visibly unavailable.
2. **Senders:** add/remove exact alphanumeric sender IDs or phone numbers. No prefilled sender.
   Grant incoming-SMS permission after reading the broad-access explanation. Android's permission
   dialog may say “send and view”; the app requests `RECEIVE_SMS`, not `READ_SMS` or `SEND_SMS`.
   No recent-sender listing or SMS-history read is performed.
3. **Email connection:** enter the destination, SMTP hostname, port, sending email/SMTP username,
   and a **provider-created app password**. Save the app password securely. Never enter a normal
   account password. This version requires an email-format SMTP username; providers with a separate
   non-email login name are not supported yet.
4. **Scope:** plain-text, case-insensitive content filtering is the default. Forwarding **all**
   selected-sender messages is off until deliberately switched on. Its warning includes one-time
   verification codes and account information. A blank filter cannot forward anything.
5. **Review:** check senders, destination, scope and connection. Send a clearly synthetic test
   through the real configured transport, then explicitly enable forwarding. A test does not enable
   the rule and does not flush other pending messages.

The status screen offers pause/resume, edit, delete, synthetic test and retry of exhausted failures.
Editing pauses first; pending deliveries use the newly saved connection on resumption.
Pause holds queued messages and ignores new SMS; an already-sending email can finish.
“Sent” means the SMTP server accepted the email, **not** that an inbox received it.

## Small architecture

- `src/core.ts`: typed `Template` registry (one entry), trigger → exact-sender/content filter →
  `Transport`; multipart assembly and durable queue state transitions. No native modules are mocked
  inside this engine. Sender matching trims and lowercases; phone formatting is otherwise exact.
- `src/service.ts`: one serialized lane shared by UI and headless work. One JSON settings value
  and a JSON event journal in AsyncStorage. No app-managed SQL schema or database dependency.
  Sent payloads are scrubbed from prior journal events; terminal metadata/dedupe lasts seven days.
- `SmsReceiver.kt`: Android's multipart broadcast → encrypted, atomically replaced private inbox.
  SHA-256 identity covers normalized sender, received timestamp, part count and full body.
  Acknowledgement removes inbox entries only after the JS journal write succeeds.
- `RelayWorker.kt`: persisted WorkManager jobs start the bundled headless JS task without an
  activity. A periodic 15-minute recovery sweep supplements immediate work. Jobs survive normal
  process death and reboot. Doze/manufacturer restrictions can delay them.
- `RelayModule.kt`: Keystore AES-GCM credentials/payload encryption and the sole SMTP transport.
  Android mail library `1.6.8`; **mandatory STARTTLS on 587**, or implicit TLS on 465, with system
  certificate trust and hostname verification. Authentication is never attempted before TLS.

Retry statuses: **queued → sending → sent**, or **retrying → failed** after five attempts.
Backoff starts at 30 seconds, doubles, and is capped at 30 minutes; scheduling can run later.
Retries keep the same delivery ID. Redelivered identical broadcasts are deduplicated, but an
ambiguous SMTP acceptance/process crash can still cause duplicate email: no exactly-once promise.
Storage/receive failures are shown as an operational warning; SMTP failures appear on their delivery.

## Privacy & security

- No personal sender, address or credential defaults. Examples use reserved neutral values only.
- Passwords never enter AsyncStorage or logs. The native module does not return the saved password
  to JavaScript. Pending SMS bodies are encrypted at rest; briefly decrypted in memory to send.
  Backups are disabled. Unmatched incoming SMS is briefly encrypted while filtering, then discarded.
- Delivery history shows sender/time/status/errors, not SMS bodies. Sent bodies are removed;
  failed/queued bodies remain until delivered or explicitly deleted. Status metadata expires after
  seven days on journal writes. Very high message volume can hit AsyncStorage's size limits;
  this single-rule v1 is not a bulk gateway.
- Delete removes settings, queue, native inbox, credential and Keystore key. Also revoke the app
  password with the provider. Deletion cannot recall sent email. A rooted device or debug-authorized
  computer can inspect app memory; this is not protection from a compromised phone.
- Exact sender IDs are **not proof of sender authenticity**. Do not use forwarded SMS as an agent
  execution authorization mechanism. There is no inbound-email/agent execution feature here.
- Debug builds additionally allow **verified STARTTLS to `localhost:2525` only**, for local test
  catchers. The debug-only network configuration trusts the repository's public synthetic test CA
  for exactly `localhost`. Its private key is not in this repository. Release builds do not allow
  that port or include that trust anchor. No cleartext SMTP fallback exists.

## Android and distribution limits

SMS is not RCS. Only `SMS_RECEIVED` broadcasts are supported; chat/RCS and other apps' messages
are not captured. Android can specially restrict messages containing SMS-Retriever hashes.
`RECEIVE_SMS` is dangerous and hard-restricted; installer allowlisting and user consent are required.
Force-stop blocks reception until the app is opened again. Background/battery configuration is
explained in the app's About / Help screen. SIM selection and recent-sender listing are not included.

Play distribution is **not assumed permitted**. Restricted SMS access generally requires a default
handler role or an approved exception and declaration. Cross-device synchronization/device automation
exceptions require review; personal use is not a blanket exemption. This lane does no store work.
Policy/reference check: 30 October 2026:
[SMS permission policy](https://support.google.com/googleplay/android-developer/answer/10208820),
[Android permission reference](https://developer.android.com/reference/android/Manifest.permission#RECEIVE_SMS),
[SMS broadcast contract](https://developer.android.com/reference/android/provider/Telephony.Sms.Intents).

iOS project scaffolding is retained, but **not built or tested**. Shared UI marks SMS unavailable on
iOS; no SMS-native implementation or parity claim is made.

## Verification

`npm test` is one small Node test runner: real sender/filter/multipart/permission logic, encrypted
file-backed journal reconstruction, deduplication, pause, retry/backoff/exhaustion and acceptance by a
small local SMTP socket server. This host journey does **not** substitute for Android TLS proof.
`npx tsc --noEmit` checks application and test sources. No production mailbox was used for
acceptance; every configured address and injected SMS was synthetic.

### This APK's proof matrix — 30 October 2026

The retained APK was built from implementation commit `880217f4c650699a90a2b893a588cdea10ffb0ad`.
The subsequent README update changes documentation only, not application/build sources.

| Check | Physical phone | Task-owned emulator | Host runner |
| --- | --- | --- | --- |
| Install and launch the same APK | Passed; installed hash verified | Passed; installed hash verified | — |
| Permission prompt, denial, then allow | Captured in earlier final-APK session | Permission granted for journey | Permission failure logic passed |
| Five-step setup, review, explicit all-message choice | **Incomplete**; final driver stopped at sender entry | Passed through real UI | Validation/filter defaults passed |
| Synthetic test through real verified STARTTLS | **Not completed** | Passed against loopback catcher | Separate plain local-socket queue journey passed |
| Incoming SMS → correct destination, sender/time/body MIME | Not tested | Passed with activity backgrounded | Mail formatting passed |
| Unrelated sender / content filter | Not tested | Both excluded without email | Passed |
| Duplicate / multipart | Not tested | Same-second identical injections produced one email; three-part SMS produced one complete email | Queue dedupe and reassembly passed |
| Retry / reboot persistence | Not tested | Visible 451 failure; recovered after reboot without reopening activity | Backoff, reconstruction and exhaustion passed |
| Pause / resume / edit / delete / re-onboard | Not tested | Passed | Queue pause/retry passed |

The final physical-phone attempt used its existing large text/density unchanged. The driver
stopped on an immediate IME-visibility assertion after typing the neutral sender; a later dump
showed the keyboard hidden. This is a harness limitation, not established as an app defect.
No phone test email was sent and no rule was enabled. Full physical-phone onboarding/TLS delivery
remains a follow-up; emulator proof is not relabelled as phone proof. No real provider, implicit
TLS/465, prolonged battery restrictions, iOS or speech/ingestion workflow was tested.

Handoff artifact: `evidence/relaybox-debug.apk`, **118,421,873 bytes**; SHA-256:

```text
8877ae6e4f12f5cf13fcf0c28e84a0e409a506d91635002b7df0f9e30a616a19
```

Evidence is retained outside this repository under the task handoff directory
`data/new-app-phone-automations-v1-apk-sms-to-0b/evidence/`: `final-report.md`,
`clean-clone.log`, `clean-build.log`, `clean-final-build.log`, `final-npm-test.log`,
`final-typecheck.log`, `installed-final-hashes.txt`, `native-final-checks.jsonl`,
final-step screenshots and synthetic MIME `mail-3.eml` through `mail-8.eml`.
`mail-1.eml` and `mail-2.eml` predate the final header fix and are **not** final-APK proof.
The clone's initial build executed all 78 tasks; its final-header rebuild succeeded with four
executed and 74 up-to-date. Fresh host checks: four tests passed, none skipped; typecheck exit 0.
Screenshots were visually reviewed; an early transient SMS notification overlay was replaced
for retry-status proof by the settled `emulator-5586-final-13-retrying-settled.png` capture.

For local Android testing, bind a tiny STARTTLS catcher to host `127.0.0.1:2525` and use:

```sh
adb -s YOUR_SERIAL reverse tcp:2525 tcp:2525
# In onboarding: localhost / 2525, neutral synthetic accounts and password.
# To use your own catcher key, regenerate the localhost-only test CA and rebuild.
adb -s YOUR_EMULATOR emu sms send SAMPLE-BANK 'Your code is 4321'
adb -s YOUR_EMULATOR emu sms send OTHER-SHOP 'Unrelated synthetic message'
```

The catcher must support TLS and authentication. Do not point the test at a public mailbox or
remove TLS checks. Reverse mappings are transient and must be restored after emulator reboot.

## Next (not implemented)

Talk-to-agent with editable transcripts and explicit send; separately authorized email ingestion;
OAuth; iOS-appropriate workflows; release signing, dependency/toolchain refresh and CI; broader
provider support. No backend will be deployed without separate approval.

---
Apache-2.0 · [@umership](https://github.com/umership)
