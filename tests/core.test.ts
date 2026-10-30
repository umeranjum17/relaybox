import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {createServer, connect} from 'node:net';
import {once} from 'node:events';
import {Queue, emptySettings, matches, senderKey, reassemble, retryDelay, permissionFailure, validate, validateAgent, mailFor} from '../src/core.ts';
import type {Settings, Sms, Transport} from '../src/core.ts';

const s: Settings = {...emptySettings, senders: ['SAMPLE-BANK', '+15550100'], destination: 'you@example.com',
  username: 'sender@example.com', host: 'smtp.example.com', enabled: true, contains: 'code'};
const m: Sms = {id: 'synthetic-id', sender: 'sample-bank', timestamp: 1793329000000, parts: 1, body: 'Your code is 4321'};
test('exact case-folded alphanumeric and phone sender matching; unrelated senders excluded', () => {
  assert.equal(senderKey(' SAMPLE-BANK '), 'sample-bank');
  assert(matches(s, {...m, sender: ' Sample-Bank '}));
  assert(matches(s, {...m, sender: '+15550100'}));
  for (const sender of ['OTHER-SHOP', 'SAMPLE-BANK-EXTRA', '+155501000']) {assert(!matches(s, {...m, sender}));}
});
test('explicit all scope, safe default content filter, disabled rule and permission failures', () => {
  assert.equal(emptySettings.scope, 'filter'); assert.equal(emptySettings.enabled, false);
  assert(!matches({...s, contains: ''}, m)); assert(!matches({...s, enabled: false}, m));
  assert(!matches(s, {...m, body: 'a receipt'})); assert(matches({...s, scope: 'all'}, {...m, body: 'a receipt'}));
  assert(permissionFailure(false)?.includes('No new SMS')); assert.equal(permissionFailure(true), undefined);
  assert(validate({...s, destination: 'bad\r\nTo:other@example.com'}));
  assert(validate({...s, port: 25})); assert.equal(validate(s), undefined);
});
test('multipart reassembly feeds the real filter once with the full message', () => {
  const msg = reassemble({id: m.id, sender: m.sender, timestamp: m.timestamp, bodies: ['Your co', 'de is 4321']});
  assert.equal(msg.parts, 2); assert.equal(msg.body, m.body); assert(matches(s, msg));
  assert.throws(() => reassemble({id: '', sender: '', timestamp: 0, bodies: []}));
});
test('durable journal → local SMTP acceptance; restart, duplicate, retry/backoff, pause, terminal failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relaybox-queue-'));
  const key = randomBytes(32); let now = m.timestamp; let accept = false; const captured: string[] = [];
  // A real local socket, not a mock of Queue or the rule engine. Native TLS is proven separately on Android.
  const server = createServer(socket => {
    socket.write('220 localhost\r\n'); let input = ''; let data = false;
    socket.on('data', chunk => {
      input += chunk.toString(); let idx;
      while ((idx = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, idx); input = input.slice(idx + 2);
        if (data) {if (line === '.') {data = false; socket.write(accept ? '250 accepted\r\n' : '451 temporary unavailable\r\n');} else if (accept) {captured.push(line);} }
        else if (line === 'DATA') {data = true; socket.write('354 continue\r\n');}
        else if (line === 'QUIT') {socket.end('221 bye\r\n');} else {socket.write('250 ok\r\n');}
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const transport: Transport = {async send(settings, mail) {
    const socket = connect(port, '127.0.0.1'); socket.setTimeout(3000, () => socket.destroy());
    const replies: string[] = []; let wake: (() => void) | undefined;
    socket.on('data', b => {replies.push(...b.toString().trim().split('\r\n')); wake?.();});
    async function reply() {if (!replies.length) {await new Promise<void>(r => {wake = r;});} return replies.shift()!;}
    async function command(line: string) {socket.write(line + '\r\n'); return reply();}
    try {
      await reply(); await command('EHLO localhost'); await command(`MAIL FROM:<${settings.username}>`);
      await command(`RCPT TO:<${settings.destination}>`); await command('DATA');
      const response = await command(`To: ${settings.destination}\r\nSubject: ${mail.subject}\r\n\r\n${mail.body.replace(/\n/g, '\r\n')}\r\n.`);
      if (!response.startsWith('250')) {throw new Error(response);}
      await command('QUIT');
    } finally {socket.destroy();}
  }};
  const store = {async get(k: string) {try {return await readFile(join(dir, k), 'utf8');} catch {return null;}},
    async set(k: string, value: string) {await writeFile(join(dir, k), value);}};
  const vault = {async seal(value: string) {const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]).toString('base64');},
    async open(value: string) {const b = Buffer.from(value, 'base64'); const c = createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString();}};
  try {
    let q = new Queue(store, vault, transport, () => now);
    assert(await q.ingest(s, m)); assert(!await q.ingest(s, m));
    assert(!await q.ingest(s, {...m, id: 'unrelated', sender: 'OTHER-SHOP'}));
    assert(!(await store.get('queue'))!.includes(m.body));
    await q.flush(s); assert.equal((await q.list())[0].status, 'retrying');
    assert.equal((await q.list())[0].nextAt, now + 30_000);
    assert.equal((await q.list())[0].reason, '451 temporary unavailable');
    q = new Queue(store, vault, transport, () => now); // new instance reads the durable journal
    accept = true; await q.flush(s); assert.equal(captured.length, 0); // not due
    now += 30_000; await q.flush({...s, enabled: false}); assert.equal(captured.length, 0); // paused
    await q.flush(s); assert.equal((await q.list())[0].status, 'sent');
    assert(captured.join('\n').includes('To: you@example.com')); assert(captured.join('\n').includes(m.body));
    assert(captured.join('\n').includes('Sender: sample-bank')); assert(captured.join('\n').includes(new Date(m.timestamp).toISOString()));
    assert(!await q.ingest(s, m)); assert(!(await q.list())[0].payload);
    assert((await q.journal()).every(x => !x.payload)); // sent content removed from prior journal entries too
    const count = captured.length; await q.flush(s); assert.equal(captured.length, count);
    accept = false; await q.ingest(s, {...m, id: 'exhaustion'});
    for (let i = 1; i <= 5; i++) {await q.flush(s); now += retryDelay(i);}
    assert.equal((await q.list())[1].status, 'failed');
    await q.retry(); assert.equal((await q.list())[1].attempts, 0);
    // The second template uses this same encrypted journal and transport, without enabling SMS.
    const voice: Sms = {...m, id: 'voice-unique-id', sender: 'Talk to your agent', body: 'Synthetic edited planning prompt.',
      voice: {destination: 'agent@example.com', subject: 'Synthetic agent request'}};
    const paused = {...s, enabled: false};
    assert.equal(validateAgent({...paused, agentDestination: voice.voice!.destination, agentSubject: voice.voice!.subject}), undefined);
    assert(validateAgent({...paused, agentDestination: 'agent@example.com', agentSubject: 'bad\r\nBcc: other@example.com'}));
    await assert.rejects(() => q.ingest(paused, {...voice, body: ' '}));
    assert(await q.ingest(paused, voice)); assert(!await q.ingest(paused, voice));
    assert(!(await store.get('queue'))!.includes(voice.body));
    const before = captured.length; await q.flush(paused); // catcher still fails
    assert.equal((await q.list())[2].status, 'retrying'); assert.equal(captured.length, before);
    q = new Queue(store, vault, transport, () => now); now += 30_000; accept = true;
    await q.flush({...paused, agentDestination: 'changed@example.com', agentSubject: 'Changed'});
    assert.equal((await q.list())[1].status, 'retrying'); // paused SMS did not block voice behind it
    assert.equal((await q.list())[2].status, 'sent');
    const email = captured.slice(before).join('\n');
    assert(email.includes('To: agent@example.com')); assert(email.includes('Subject: Synthetic agent request'));
    assert(email.includes(`Message ID: ${voice.id}`)); assert(email.includes(new Date(voice.timestamp).toISOString()));
    assert(email.includes(voice.body)); assert(!email.includes('changed@example.com'));
    assert.equal(mailFor(voice).id, voice.id);
    assert((await q.journal()).filter(x => x.id === voice.id).every(x => !x.payload));
    const after = captured.length; await q.flush(paused); assert.equal(captured.length, after);
  } finally {server.close(); await rm(dir, {recursive: true, force: true});}
});
