import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Keyboard, KeyboardAvoidingView, Modal, PermissionsAndroid, Platform,
  Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, useColorScheme, View} from 'react-native';
import {emptySettings, senderKey, validate} from './src/core.ts';
import type {Delivery, Settings} from './src/core.ts';
import * as service from './src/service.ts';
import {VoicePanel} from './src/VoicePanel.tsx';
import {recognition} from './src/nativeRecognition.ts';

const steps = ['Template', 'Senders', 'Email connection', 'Message scope', 'Review'];
export default function App() {
  const [rule, setRule] = useState<Settings>({...emptySettings});
  const [step, setStep] = useState(0);
  const [screen, setScreen] = useState<'setup' | 'status' | 'help' | 'voice'>('setup');
  const [previous, setPrevious] = useState<'setup' | 'status' | 'voice'>('setup');
  const [voiceSetup, setVoiceSetup] = useState(false);
  const [deleteFrom, setDeleteFrom] = useState<'voice' | 'sms' | null>(null);
  const dark = useColorScheme() === 'dark';
  const [transcript, setTranscript] = useState('');
  const actionLock = useRef(false);
  const [sender, setSender] = useState('');
  const [password, setPassword] = useState('');
  const [savedPassword, setSavedPassword] = useState(false);
  const [permission, setPermission] = useState(false);
  const [items, setItems] = useState<Delivery[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const patch = (value: Partial<Settings>) => setRule(s => ({...s, ...value}));
  async function refresh() {
    if (!service.available) {return;}
    const data = await service.status(); setItems(data.deliveries.reverse()); setIssue(data.issue);
    setPermission(await service.native.permission());
  }
  async function act(fn: () => Promise<void>) {
    if (actionLock.current) {return;}
    actionLock.current = true; setBusy(true); setNotice('');
    try {await fn(); await refresh();} catch (e) {setNotice(e instanceof Error ? e.message : 'Action failed. Please retry.');}
    finally {actionLock.current = false; setBusy(false);}
  }
  useEffect(() => {
    if (!service.available) {setLoaded(true); return;}
    (async () => {
      try {
        const s = await service.settings(); setRule(s);
        if (s.senders.length) {setScreen('status');} else if (s.agentDestination) {setScreen('voice');}
        setSavedPassword(await service.native.hasPassword());
        await refresh(); await service.native.enabled(s.enabled); await service.flush(); await refresh();
      } catch {setNotice('Local data could not be loaded. Delivery has not been confirmed. Reopen the app or delete local data.');}
      setLoaded(true);
    })();
    const timer = setInterval(() => {refresh().catch(() => setNotice('Could not read delivery status.'));}, 2500);
    const sub = AppState.addEventListener('change', state => {if (state === 'active') {service.flush().then(refresh).catch(() => setNotice('Background delivery needs attention.'));}});
    return () => {clearInterval(timer); sub.remove();};
  }, []);
  function field(label: string, value: string, onChange: (v: string) => void, hint = '', secret = false, numeric = false) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput
      accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={hint} placeholderTextColor="#66758a"
      autoCapitalize="none" autoCorrect={false} secureTextEntry={secret} keyboardType={numeric ? 'number-pad' : 'default'}
      style={styles.input} /></View>;
  }
  function button(label: string, fn: () => void, secondary = false, disabled = false) {
    return <Pressable accessibilityRole="button" accessibilityState={{disabled: disabled || busy}}
      disabled={disabled || busy} onPress={fn} style={[styles.button, secondary && styles.secondary, (disabled || busy) && styles.disabled]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text></Pressable>;
  }
  function history() {
    return <><Text style={styles.section}>Delivery status</Text><Text style={styles.caption}>No message bodies are shown here. “Sent” means accepted by your SMTP server, not confirmed in the destination inbox.</Text>
      {!items.length ? <Text style={styles.body}>No deliveries yet.</Text> : items.map(x => <View key={x.id} style={styles.card}><Text style={styles.label}>{x.test ? 'Synthetic test' : x.sender} · {x.status.toUpperCase()}</Text><Text style={styles.caption}>{new Date(x.timestamp).toLocaleString()} · {x.parts} part(s) · attempts {x.attempts}</Text>{x.reason ? <Text style={styles.error}>{x.reason}</Text> : null}{x.status === 'retrying' ? <Text style={styles.caption}>Next attempt after {new Date(x.nextAt).toLocaleTimeString()}</Text> : null}</View>)}
      {items.some(x => x.status === 'failed') ? button('Retry failed deliveries', () => act(async () => {await service.retry(); await service.flush();}), true) : null}</>;
  }
  const chooseTemplates = () => {setVoiceSetup(false); setScreen('setup'); setStep(0); setNotice('');};
  function deleteLocalData() {
    setDeleteFrom(null);
    act(async () => {await service.remove(); setRule({...emptySettings}); setTranscript(''); setSavedPassword(false); setItems([]); chooseTemplates();});
  }
  const test = () => act(async () => {await service.syntheticTest(rule); setNotice('Test sent ✓ The configured SMTP server accepted the synthetic email.');});
  if (!loaded) {return <View style={styles.loading}><ActivityIndicator color="#087b70" /><Text>Opening Relaybox…</Text></View>;}
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <StatusBar barStyle="dark-content" backgroundColor="#f5f7fa" />
    <ScrollView key={`${screen}-${step}`} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => {if (screen !== 'help') {setPrevious(screen); setScreen('help');} else {setScreen(previous);}}} style={[styles.help, styles.headerHelp]}>
          <Text style={styles.link}>{screen === 'help' ? 'Close help' : 'About / Help'}</Text></Pressable>
        <Text style={styles.brand}>Relaybox<Text style={styles.dot}> ●</Text></Text>
      </View>
      {!service.available && screen !== 'help' ? <><Text style={styles.title}>Android templates</Text><View style={styles.card}><Text style={styles.section}>Forward SMS to email</Text><Text style={styles.body}>Unavailable on iOS. Incoming SMS access requires Android.</Text></View><View style={styles.card}><Text style={styles.section}>Talk to your agent</Text><Text style={styles.body}>Unavailable on iOS. Speech recognition is implemented for Android only.</Text></View></> : null}
      {screen === 'help' ? <>
        <Text style={styles.eyebrow}>ABOUT / HELP</Text><Text android_hyphenationFrequency="normal" style={styles.title}>Small rules. Clear boundaries.</Text>
        <Text style={styles.section}>What works today</Text><Text style={styles.body}>Forward selected incoming Android SMS to an email address you configure. Nothing uses a Relaybox server. Talk to your agent lets you speak or type, review an editable transcript, then explicitly send it by email. No agent-side ingestion is included.</Text>
        <Text style={styles.section}>SMS is not RCS</Text><Text style={styles.body}>Only carrier SMS broadcasts are received. Chat messages sent over RCS, and messages inside other apps, are not captured. We do not detect RCS or read your message history.</Text>
        <Text style={styles.section}>Personal sideload, not a store release</Text><Text style={styles.body}>This is a debug APK installed outside an app store. Store SMS permissions are restricted and distribution has not been approved. Use only on your own device and accounts.</Text>
        <Text style={styles.section}>Email security</Text><Text style={styles.body}>Use a provider-created app password, never your normal account password. SMTP requires verified TLS: STARTTLS on 587 or implicit TLS on 465. No OAuth or relay is provided. Sending usernames must be email addresses. Disconnect by deleting the rule; revoke the app password with your provider too.</Text>
        <Text style={styles.section}>Privacy & retention</Text><Text style={styles.body}>Incoming SMS is briefly encrypted on-device while rules are checked. Unmatched messages are discarded. Pending bodies and the app password are encrypted with an Android Keystore key. Sent bodies are removed; status and deduplication metadata are kept for seven days. No analytics, message-body logs or stored audio. Unsent transcripts stay in memory; explicitly sent prompts share the encrypted queue and body-scrubbing policy. On-device speech is preferred; the Android recognizer may use its provider’s network service when unavailable.</Text>
        <Text style={styles.section}>Background delivery</Text><Text style={styles.body}>Retries survive ordinary process exits and reboots. Delivery can be delayed by Doze, battery limits or manufacturer settings. Allow background use in system app settings if needed. Force-stopping Relaybox prevents reception until you open it again. An interrupted SMTP acknowledgement can cause a duplicate; delivery is not exactly once.</Text>
        <Text style={styles.section}>Pause, edit & delete</Text><Text style={styles.body}>Pausing ignores new SMS and holds queued messages. An email already sending may finish. Editing pauses first; pending messages use the saved connection when resumed. Delete removes settings, credentials and local delivery history, but cannot recall email already sent.</Text>
        {button('Back to Relaybox', () => setScreen(previous))}
      </> : service.available && screen === 'setup' ? <>
        <Text style={styles.eyebrow}>{voiceSetup ? 'TALK TO YOUR AGENT · EMAIL CONNECTION' : `STEP ${step + 1} OF 5 · ${steps[step].toUpperCase()}`}</Text>
        <View style={styles.progress}>{steps.map((x, i) => <View key={x} style={[styles.segment, i <= step && styles.segmentOn]} />)}</View>
        {step === 0 ? <><Text android_hyphenationFrequency="normal" style={styles.title}>A useful little automation.</Text><Text style={styles.body}>Choose a ready-to-use workflow. You decide what moves, and where it goes.</Text>
          <View style={styles.card}><Text style={styles.section}>Forward SMS to email</Text><Text style={styles.body}>Selected senders. Your inbox. A clear delivery trail.</Text><Text style={styles.badge}>AVAILABLE ON ANDROID</Text></View>
          <View style={styles.card}><Text style={styles.section}>Talk to your agent</Text><Text style={styles.body}>Speak. Review and edit. Send only when you choose.</Text>{button('Talk to your agent', () => {setScreen('voice'); setNotice('');})}</View>
          {rule.senders.length ? button('SMS delivery status', () => setScreen('status'), true) : null}
          {button('Set up SMS forwarding', () => setStep(1))}</> : null}
        {step === 1 ? <><Text android_hyphenationFrequency="normal" style={styles.title}>Who should we listen for?</Text><Text style={styles.body}>Add exact sender IDs, including names or phone numbers. Matching ignores letter case and surrounding spaces.</Text>
          {field('Sender ID', sender, setSender, 'e.g. SAMPLE-BANK')}{button('Add sender', () => {if (sender.trim() && !rule.senders.some(x => senderKey(x) === senderKey(sender))) {patch({senders: [...rule.senders, sender.trim()]}); setSender('');}}, true, !sender.trim())}
          {rule.senders.map(x => <View key={x} style={styles.sender}><Text style={styles.senderText}>{x}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Remove ${x}`} onPress={() => patch({senders: rule.senders.filter(y => y !== x)})} style={styles.help}><Text style={styles.link}>Remove</Text></Pressable></View>)}
          <View style={styles.warning}><Text style={styles.body}>Android grants access to all incoming SMS, even though your rule only forwards selected senders. We do not request message history. “Show recent senders” needs broader access and is not used.</Text></View>
          {!permission ? button('Grant incoming SMS access', () => act(async () => {
            const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS);
            const ok = result === PermissionsAndroid.RESULTS.GRANTED; setPermission(ok);
            if (!ok) {throw new Error('SMS access was denied. No SMS can be received. Allow it in Android app permissions, then return here.');}
          }), true) : <Text style={styles.success}>✓ Incoming SMS access granted</Text>}
          {button('Continue to email', () => setStep(2), false, !permission || !rule.senders.length)}</> : null}
        {step === 2 ? <><Text android_hyphenationFrequency="normal" style={styles.title}>Connect your own email.</Text><Text style={styles.body}>Messages go only through the server and destination you enter. Use your provider’s SMTP settings.</Text>
          {field('Destination email', voiceSetup ? rule.agentDestination || '' : rule.destination, v => patch(voiceSetup ? {agentDestination: v.trim()} : {destination: v.trim()}), 'you@example.com')}
          {voiceSetup ? field('Email subject', rule.agentSubject || '', v => patch({agentSubject: v}), 'A short subject for your agent') : null}
          {field('SMTP host', rule.host, v => patch({host: v.trim()}), 'smtp.example.com')}
          {field('SMTP port', String(rule.port || ''), v => patch({port: Number(v)}), '587', false, true)}
          <Text style={styles.caption}>587: required STARTTLS · 465: implicit TLS</Text>
          {field('Sending email / SMTP username', rule.username, v => patch({username: v.trim()}), 'sender@example.com')}
          <Text style={styles.body}>Create an app password with your email provider. Never enter your normal account password. It is protected on this device with Android Keystore.</Text>
          {field('App password', password, setPassword, savedPassword ? 'Already saved securely' : 'Provider-created app password', true)}
          {button(savedPassword ? 'Replace saved app password' : 'Save app password', () => act(async () => {if (!password) {throw new Error('Enter an app password.');} await service.native.setPassword(password); setPassword(''); setSavedPassword(true); setNotice('App password saved securely.');}), true, !password)}
          {voiceSetup ? button('Save agent email connection', () => act(async () => {await service.saveAgent(rule); setVoiceSetup(false); setScreen('voice'); setNotice('Connection saved. Review your prompt before tapping Send.');}), false, !savedPassword || !!password) : button('Continue to message scope', () => {setNotice(''); setStep(3);}, false, !savedPassword || !!password || !rule.destination || !rule.host || !rule.username)}</> : null}
        {step === 3 ? <><Text android_hyphenationFrequency="normal" style={styles.title}>Choose what gets forwarded.</Text><Text style={styles.body}>A content filter is selected by default. It only applies to the sender IDs you added.</Text>
          <View style={styles.card}><Text style={styles.section}>Forward all selected-sender messages</Text><Text style={styles.body}>Warning: this includes one-time verification codes and account information. Turn this on only if you deliberately want every message from these senders emailed.</Text>
            <Switch accessibilityLabel="Forward all messages, including verification codes" value={rule.scope === 'all'} onValueChange={all => patch({scope: all ? 'all' : 'filter'})} trackColor={{true: '#087b70'}} /></View>
          {rule.scope === 'filter' ? field('Only messages containing', rule.contains, v => patch({contains: v}), 'A word or phrase') : <Text style={styles.success}>All messages explicitly selected</Text>}
          <Text style={styles.caption}>The filter is plain text, case-insensitive. Empty filters do not forward anything.</Text>
          {button('Review rule', () => {const error = validate(rule); if (error) {setNotice(error);} else {setNotice(''); setStep(4);}}, false, rule.scope === 'filter' && !rule.contains.trim())}</> : null}
        {step === 4 ? <><Text android_hyphenationFrequency="normal" style={styles.title}>Your rule. Your choice.</Text><View style={styles.card}>
          <Text style={styles.label}>FROM THESE SENDERS</Text><Text style={styles.body}>{rule.senders.join(', ')}</Text>
          <Text style={styles.label}>TO THIS EMAIL</Text><Text style={styles.body}>{rule.destination}</Text>
          <Text style={styles.label}>MESSAGE SCOPE</Text><Text style={styles.body}>{rule.scope === 'all' ? 'All messages, including verification codes and account information' : `Contains “${rule.contains}” (case-insensitive)`}</Text>
          <Text style={styles.label}>CONNECTION</Text><Text style={styles.body}>{rule.host}:{rule.port} · {rule.port === 465 ? 'TLS' : 'required STARTTLS'}</Text></View>
          <Text style={styles.body}>When enabled, matching incoming SMS is queued on this phone and emailed with its sender, received time and full body. Unrelated senders are excluded. No rule runs until you enable it below.</Text>
          {button('Send synthetic test email', test, true)}
          {button('Enable forwarding', () => act(async () => {if (!(await service.native.permission())) {throw new Error('SMS permission is missing. Go back to Senders to grant it.');} const next = {...rule, enabled: true}; await service.save(next); setRule(next); setScreen('status');}), false, !permission)}</> : null}
        {step > 0 ? button('Back', () => {setNotice(''); if (voiceSetup) {setVoiceSetup(false); setScreen('voice');} else {setStep(step - 1);}}, true) : null}
      </> : service.available && screen === 'voice' ? <>
        <Text style={styles.eyebrow}>TALK TO YOUR AGENT</Text><Text android_hyphenationFrequency="normal" style={styles.title}>Your words. Your next move.</Text>
        <VoicePanel input={recognition} text={transcript} edit={setTranscript} busy={busy} styles={styles} send={() => act(async () => {
          const delivery = await service.sendPrompt(transcript); setTranscript('');
          setNotice(delivery.status === 'sent' ? 'Prompt sent ✓ Accepted by your SMTP server.' : 'Prompt queued. Delivery is not confirmed; check delivery status below. Do not send it again.');
        })} />
        <View style={styles.card}><Text style={styles.label}>EMAIL CONNECTION</Text><Text style={styles.body}>{rule.agentDestination || 'Not configured yet'}</Text><Text style={styles.caption}>Subject: {rule.agentSubject || 'Not configured yet'}</Text><Text style={styles.caption}>Uses the same SMTP connection and saved app password as SMS. Destination and subject are captured when you tap Send; retries keep that envelope.</Text></View>
        {button('Configure agent email', () => {setVoiceSetup(true); setStep(2); setScreen('setup'); setNotice('');}, true)}
        {button('Choose template', chooseTemplates, true)}
        {button('Delete rule & local data', () => {Keyboard.dismiss(); setDeleteFrom('voice');}, true)}
        {history()}
      </> : service.available && screen === 'status' ? <>
        <Text style={styles.eyebrow}>FORWARD SMS TO EMAIL</Text><Text android_hyphenationFrequency="normal" style={styles.title}>{rule.enabled ? 'Your rule is on.' : 'Forwarding is paused.'}</Text>
        <View style={styles.card}><Text style={styles.section}>{rule.senders.join(', ')}</Text><Text style={styles.body}>→ {rule.destination}</Text><Text style={styles.caption}>{rule.scope === 'all' ? 'All selected-sender messages, including codes' : `Contains: ${rule.contains}`}</Text></View>
        {issue ? <View style={styles.warning}><Text style={styles.body}>{issue}</Text></View> : null}
        {button(rule.enabled ? 'Pause forwarding' : 'Resume forwarding', () => act(async () => {await service.toggle(); setRule(await service.settings());}))}
        {button('Send synthetic test email', test, true)}
        <View style={styles.actions}>{button('Edit rule', () => act(async () => {if (rule.enabled) {await service.toggle();} setRule(await service.settings()); setScreen('setup'); setStep(1);}), true)}
          {button('Delete rule & local data', () => {Keyboard.dismiss(); setDeleteFrom('sms');}, true)}</View>
        {button('Choose template', chooseTemplates, true)}
        {history()}
      </> : null}
      {busy ? <ActivityIndicator style={styles.busy} color="#087b70" accessibilityLabel="Working" /> : null}
      {notice ? <View accessibilityLiveRegion="polite" style={styles.warning}><Text selectable style={styles.body}>{notice}</Text></View> : null}
      <Text style={styles.footer}>LOCAL FIRST · ONLY YOUR CONNECTION</Text>
    </ScrollView>
    <Modal visible={deleteFrom !== null} transparent animationType="fade" onRequestClose={() => setDeleteFrom(null)}>
      <View style={styles.dialogBackdrop}>
        <View accessibilityViewIsModal style={[styles.card, styles.dialogSheet, dark && styles.dialogDark]}>
          <Text accessibilityRole="header" style={[styles.section, styles.dialogTitle, dark && styles.dialogLightText]}>{deleteFrom === 'voice' ? 'Delete all local data?' : 'Delete rule and all local data?'}</Text>
          <ScrollView style={styles.dialogBody} contentContainerStyle={styles.dialogBodyContent} persistentScrollbar>
            <Text style={[styles.body, dark && styles.dialogLightText]}>{deleteFrom === 'voice' ? 'This also deletes SMS settings, queued messages and the saved app password. Sent email cannot be recalled.' : 'Queued messages, delivery history and the saved app password will be removed. Emails already sent cannot be recalled.'}</Text>
          </ScrollView>
          <View style={styles.dialogFooter}>
            <Pressable accessibilityRole="button" onPress={() => setDeleteFrom(null)} style={[styles.button, styles.secondary, dark && styles.dialogSecondaryDark]}><Text style={[styles.buttonText, styles.secondaryText, dark && styles.dialogLightText]}>Cancel</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{disabled: busy}} disabled={busy} onPress={deleteLocalData} style={[styles.button, styles.danger, busy && styles.disabled]}><Text style={styles.buttonText}>Delete</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </KeyboardAvoidingView>;
}
export const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#f5f7fa', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 24 : 48, paddingBottom: 24},
  loading: {flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16},
  header: {alignItems: 'flex-start', marginBottom: 16}, headerHelp: {alignSelf: 'flex-end'},
  brand: {fontSize: 24, fontWeight: '800', color: '#102436', letterSpacing: -0.8}, dot: {color: '#087b70', fontSize: 16},
  help: {paddingVertical: 12, paddingHorizontal: 4}, link: {color: '#086b63', fontWeight: '700', fontSize: 14},
  content: {padding: 16, paddingBottom: 36, flexGrow: 1}, eyebrow: {fontSize: 12, color: '#436071', fontWeight: '800', letterSpacing: 1.1, marginBottom: 16},
  progress: {flexDirection: 'row', gap: 6, marginBottom: 26}, segment: {height: 4, backgroundColor: '#dce4e9', flex: 1, borderRadius: 3}, segmentOn: {backgroundColor: '#087b70'},
  title: {fontSize: 32, lineHeight: 39, fontWeight: '800', color: '#102436', marginBottom: 16},
  body: {fontSize: 16, lineHeight: 24, color: '#354c5e', marginBottom: 12}, section: {fontSize: 19, fontWeight: '700', color: '#102436', marginBottom: 10, marginTop: 4},
  card: {backgroundColor: '#fff', borderColor: '#dce4e9', borderWidth: 1, borderRadius: 18, padding: 12, marginVertical: 8},
  badge: {fontSize: 11, fontWeight: '800', color: '#087b70', letterSpacing: 1}, label: {fontSize: 14, fontWeight: '700', color: '#243d50', marginBottom: 8},
  field: {marginVertical: 8}, input: {minHeight: 52, backgroundColor: '#fff', borderColor: '#b5c4ce', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, color: '#102436', fontSize: 16},
  button: {minHeight: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: '#087b70', borderRadius: 12, padding: 14, marginVertical: 6},
  buttonText: {fontSize: 16, fontWeight: '700', color: '#fff', textAlign: 'center'}, secondary: {backgroundColor: '#e6eeef'}, secondaryText: {color: '#15574f'}, disabled: {opacity: 0.45},
  warning: {backgroundColor: '#fff1d6', borderRadius: 14, padding: 16, marginVertical: 12}, success: {color: '#086b63', fontWeight: '700', marginVertical: 12},
  caption: {color: '#526779', fontSize: 13, lineHeight: 20, marginBottom: 8}, sender: {alignItems: 'flex-start', gap: 4}, senderText: {fontSize: 17, color: '#102436', alignSelf: 'stretch'},
  actions: {marginTop: 8}, error: {color: '#923c24', fontSize: 14, lineHeight: 21}, busy: {margin: 16}, footer: {fontSize: 10, color: '#526779', textAlign: 'center', letterSpacing: 1.5, marginTop: 32},
  dialogBackdrop: {flex: 1, justifyContent: 'center', padding: 16, backgroundColor: 'rgba(16,36,54,0.6)'},
  dialogSheet: {maxHeight: '100%', marginVertical: 0, padding: 16, backgroundColor: '#f5f7fa'},
  dialogTitle: {flexShrink: 0}, dialogBody: {flexGrow: 0, flexShrink: 1, minHeight: 0}, dialogBodyContent: {paddingRight: 8}, dialogFooter: {flexShrink: 0},
  dialogDark: {backgroundColor: '#102436', borderColor: '#526779'}, dialogLightText: {color: '#f5f7fa'}, dialogSecondaryDark: {backgroundColor: '#243d50'}, danger: {backgroundColor: '#923c24'},
});
