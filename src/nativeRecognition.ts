import {Linking, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import type {Recognition, RecognitionPhase} from './recognition.ts';

const speech = NativeModules.RelaySpeech;
export const recognition: Recognition = {
  debugAvailable: Platform.OS === 'android' && !!speech?.debugAvailable,
  requestPermission: async () => Platform.OS === 'android' &&
    (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) === PermissionsAndroid.RESULTS.GRANTED,
  openSettings: () => Linking.openSettings(),
  async start(onPhase, debug) {
    if (!speech) {throw new Error('Speech recognition is unavailable on this platform.');}
    const listener = new NativeEventEmitter(speech).addListener('RelaySpeechState', (state: RecognitionPhase) => onPhase(state));
    try {return await speech.start(debug);} finally {listener.remove();}
  },
  finish: () => speech?.finish(),
  cancel: () => speech?.cancel(),
};
