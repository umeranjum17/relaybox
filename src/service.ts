import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules, Platform} from 'react-native';
import {Queue, emptySettings, permissionFailure, validate, reassemble} from './core.ts';
import type {Settings, Sms, Transport, Vault} from './core.ts';

export const native = NativeModules.Relay as {
  seal(text: string): Promise<string>; open(text: string): Promise<string>;
  hasPassword(): Promise<boolean>; setPassword(text: string): Promise<void>;
  pending(): Promise<string>; ack(ids: string[]): Promise<void>;
  enabled(value: boolean): Promise<void>; wake(): Promise<void>; permission(): Promise<boolean>;
  issue(): Promise<string | null>; erase(): Promise<void>; complete(token: string, retry: boolean): void;
  send(settings: Settings, mail: {id: string; subject: string; body: string}): Promise<void>;
};
const transport: Transport = {send: (settings, mail) => native.send(settings, mail)};
const vault: Vault = {seal: value => native.seal(value), open: value => native.open(value)};
export const queue = new Queue({get: key => AsyncStorage.getItem(key), set: (key, value) => AsyncStorage.setItem(key, value)}, vault, transport);
let tail: Promise<unknown> = Promise.resolve();
// UI mutations and headless jobs share this one transaction lane.
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work); tail = next.catch(() => {}); return next;
}
export const settings = async (): Promise<Settings> => JSON.parse(await AsyncStorage.getItem('settings') || JSON.stringify(emptySettings));
export const save = (value: Settings) => serial(async () => {
  const error = validate(value); if (error) {throw new Error(error);}
  if (!(await native.hasPassword())) {throw new Error('Save an app password before enabling.');}
  await native.enabled(false);
  await AsyncStorage.setItem('settings', JSON.stringify(value));
  await native.enabled(value.enabled);
});
export const toggle = () => serial(async () => {
  const value = await settings(); value.enabled = !value.enabled;
  if (value.enabled && !(await native.permission())) {throw new Error(permissionFailure(false));}
  await AsyncStorage.setItem('settings', JSON.stringify(value)); await native.enabled(value.enabled);
});
export const remove = () => serial(async () => {
  await native.enabled(false); await AsyncStorage.multiRemove(['settings', 'queue']); await native.erase();
});
export const retry = () => serial(async () => {await queue.retry(); await native.wake();});
export const status = () => serial(async () => ({deliveries: await queue.list(),
  issue: permissionFailure(await native.permission()) || await native.issue()}));
export const flush = () => serial(async () => {
  const s = await settings();
  if (!s.enabled) {return false;}
  const incoming: Parameters<typeof reassemble>[0][] = JSON.parse(await native.pending());
  for (const event of incoming) {const m = reassemble(event); await queue.ingest(s, m); await native.ack([m.id]);}
  return queue.flush(s, async () => (await settings()).enabled);
});
export const syntheticTest = (s: Settings) => serial(async () => {
  const error = validate(s); if (error) {throw new Error(error);}
  const m: Sms = {id: `test-${Date.now()}`, sender: 'SYNTHETIC', timestamp: Date.now(), parts: 1,
    body: 'This is a synthetic Relaybox connection test. No phone messages are included.'};
  await queue.ingest(s, m, true);
  await queue.flush(s, async () => true, m.id);
  const item = (await queue.list()).find(x => x.id === m.id)!;
  if (item.status !== 'sent') {throw new Error(item.reason || 'Test not sent.');}
});
export async function headless({token}: {token: string}) {
  let pending = true;
  try {pending = await flush();} finally {native.complete(token, pending);}
}
export const available = Platform.OS === 'android';
