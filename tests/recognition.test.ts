import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recognize} from '../src/recognition.ts';
import type {Recognition, RecognitionPhase} from '../src/recognition.ts';

test('substitutable recognition: permission, listening, processing, no-match, silence, cancellation and retry', async () => {
  let permission = false; let starts = 0; let outcome = 'Synthetic planning prompt.';
  const phases: string[] = [];
  const input: Recognition = {debugAvailable: false,
    async requestPermission() {return permission;}, async openSettings() {}, finish() {}, cancel() {},
    async start(update: (value: RecognitionPhase) => void) {
      starts++; update({phase: 'listening', engine: 'Test recognizer'}); update({phase: 'processing', engine: 'Test recognizer'});
      if (outcome === 'silence' || outcome === 'cancelled') {throw new Error(outcome);}
      return outcome;
    }};
  await assert.rejects(() => recognize(input, () => {}), /Microphone access denied/); assert.equal(starts, 0);
  permission = true;
  assert.equal(await recognize(input, s => phases.push(s.phase)), outcome);
  assert.deepEqual(phases, ['listening', 'processing']);
  for (const value of ['', 'silence', 'cancelled']) {
    outcome = value; await assert.rejects(() => recognize(input, () => {}));
    outcome = 'Synthetic retry prompt.'; assert.equal(await recognize(input, () => {}), outcome);
  }
  // Fixture lives in the debug source set, not in the production recognizer or release factory.
  const release = await readFile(new URL('../android/app/src/release/java/com/relaybox/SpeechFactory.kt', import.meta.url), 'utf8');
  assert(release.includes('debugAvailable = false')); assert(release.includes('require(!debug)'));
  assert(!release.includes('Synthetic planning prompt.'));
});
