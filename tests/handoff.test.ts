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

test('delete disclosure wraps its title and keeps both actions outside the scrolling body', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  assert(!app.includes('Alert.alert'));
  const modal = app.slice(app.indexOf('<Modal'), app.indexOf('</Modal>'));
  assert(modal.includes('accessibilityViewIsModal'));
  assert(modal.includes('persistentScrollbar'));
  assert(!/numberOfLines|adjustsFontSizeToFit|maxFontSizeMultiplier|allowFontScaling/.test(modal));
  assert(modal.indexOf('>Cancel</Text>') > modal.indexOf('</ScrollView>'));
  assert(modal.indexOf('>Delete</Text>') > modal.indexOf('</ScrollView>'));
  assert.match(modal, /onRequestClose=\{\(\) => setDeleteFrom\(null\)\}/);
  assert.match(modal, /onPress=\{\(\) => setDeleteFrom\(null\)\}/);
  assert(modal.includes('Delete rule and all local data?'));
  assert(modal.includes('Delete all local data?'));
  assert.match(app, /dialogBody: \{flexGrow: 0, flexShrink: 1, minHeight: 0\}/);
  assert.match(app, /dialogFooter: \{flexShrink: 0\}/);
  assert.equal((app.match(/await service\.remove\(\)/g) || []).length, 1);
});
