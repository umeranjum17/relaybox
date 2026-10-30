import React, {useEffect, useRef, useState} from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';
import {recognize} from './recognition.ts';
import type {Recognition, RecognitionPhase} from './recognition.ts';

// Presentation accepts the shared recognizer interface, never an Android module.
export function VoicePanel({input, text, edit, send, busy, styles}: {
  input: Recognition; text: string; edit: (value: string) => void; send: () => void; busy: boolean;
  styles: typeof import('../App.tsx').styles;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening' | 'processing' | 'ready' | 'error'>('idle');
  const [engine, setEngine] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; input.cancel();};}, [input]);
  async function start() {
    if (running.current || busy) {return;}
    running.current = true; setPhase('starting'); setError(''); setEngine('');
    try {
      const result = await recognize(input, (s: RecognitionPhase) => {if (mounted.current) {setPhase(s.phase); setEngine(s.engine);}});
      if (mounted.current) {edit(result); setPhase('ready');}
    } catch (e) {
      if (mounted.current) {setPhase('error'); setError(e instanceof Error ? e.message : 'Recognition stopped. Retry.');}
    } finally {running.current = false;}
  }
  const active = phase === 'starting' || phase === 'listening' || phase === 'processing';
  function button(label: string, onPress: () => void, disabled = false, secondary = false) {
    return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
      style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text></Pressable>;
  }
  return <>
    <Text style={styles.body}>Speak a prompt, edit the transcript, then tap Send. Nothing is sent automatically.</Text>
    <Text style={styles.caption}>Microphone access is only for speech recognition. Relaybox stores no audio. On-device recognition is preferred; the system recognizer may use its provider’s network service if unavailable. Your unsent draft stays in memory only.</Text>
    <View accessibilityLiveRegion="polite" style={styles.card}>
      <Text style={styles.section}>{({idle: 'Ready when you are.', starting: 'Starting recognizer…', listening: 'Listening…', processing: 'Processing…', ready: 'Transcript ready — review before sending.', error: 'Try again.'})[phase]}</Text>
      {engine ? <Text style={styles.caption}>{engine}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
    {active ? <>{button('Finish speaking', () => input.finish(), phase !== 'listening' || busy)}{button('Cancel recognition', () => input.cancel(), busy, true)}</> :
      button(phase === 'error' ? 'Retry recognition' : 'Push to talk', start, busy)}
    {phase === 'error' ? button('Open app permissions', () => {input.openSettings().catch(() => setError('Open Android Settings, then Relaybox permissions.'));}, busy, true) : null}
    <Text style={styles.label}>Editable transcript</Text>
    <TextInput accessibilityLabel="Editable transcript" multiline textAlignVertical="top" value={text}
      editable={!active && !busy} onChangeText={edit} placeholder="Your prompt — speak or type here" placeholderTextColor="#66758a"
      style={[styles.input, {minHeight: 132, paddingVertical: 14}]} />
    {button('Clear transcript', () => {edit(''); setPhase('idle');}, !text || active || busy, true)}
    {button('Send prompt by email', send, !text.trim() || active || busy)}
  </>;
}
