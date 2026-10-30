import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('captain sideload excludes the transcript substitute at both UI and native boundaries', async () => {
  const ui = await readFile(new URL('../src/VoicePanel.tsx', import.meta.url), 'utf8');
  const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  assert(!ui.includes('Use DEBUG transcript substitute'));
  assert(!ui.includes('setDebug'));
  assert.match(gradle, /sideload \{[^\n]*java\.srcDir "src\/release\/java"/);
  assert(!/sideload \{[^\n]*java\.srcDir "src\/debug\/java"/.test(gradle));
});
