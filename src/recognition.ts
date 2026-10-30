export type RecognitionPhase = {phase: 'listening' | 'processing'; engine: string};
export interface Recognition {
  readonly debugAvailable: boolean;
  requestPermission(): Promise<boolean>;
  openSettings(): Promise<void>;
  start(onPhase: (state: RecognitionPhase) => void, debug: boolean): Promise<string>;
  finish(): void;
  cancel(): void;
}
export async function recognize(input: Recognition, phase: (state: RecognitionPhase) => void, debug = false) {
  if (!debug && !(await input.requestPermission())) {
    throw new Error('Microphone access denied. Retry to allow it, or open app permissions in Settings. You can still type a prompt.');
  }
  const text = await input.start(phase, debug);
  if (!text.trim()) {throw new Error('No speech matched. Retry or type your prompt.');}
  return text;
}
