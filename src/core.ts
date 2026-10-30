export type Settings = {
  senders: string[]; destination: string; host: string; port: number; username: string;
  scope: 'filter' | 'all'; contains: string; enabled: boolean;
  agentDestination?: string; agentSubject?: string;
};
export const emptySettings: Settings = {
  senders: [], destination: '', host: '', port: 587, username: '',
  scope: 'filter', contains: '', enabled: false,
};
export type Sms = {id: string; sender: string; timestamp: number; parts: number; body: string;
  voice?: {destination: string; subject: string}};
export function reassemble(event: {id: string; sender: string; timestamp: number; bodies: string[]}): Sms {
  if (!event.bodies.length) {throw new Error('An SMS broadcast has no parts.');}
  return {id: event.id, sender: event.sender, timestamp: event.timestamp, parts: event.bodies.length, body: event.bodies.join('')};
}
export type Status = 'queued' | 'sending' | 'sent' | 'failed' | 'retrying';
export type Delivery = {
  id: string; sender: string; timestamp: number; parts: number; payload?: string;
  status: Status; attempts: number; nextAt: number; reason?: string; test?: boolean; voice?: boolean;
};
export type Mail = {id: string; subject: string; body: string};
export interface Transport { send(settings: Settings, mail: Mail): Promise<void> }
export const senderKey = (s: string) => s.trim().toLowerCase();
export const matches = (s: Settings, m: Sms) => s.enabled &&
  s.senders.some(sender => senderKey(sender) === senderKey(m.sender)) &&
  (s.scope === 'all' || (!!s.contains.trim() && m.body.toLowerCase().includes(s.contains.trim().toLowerCase())));
export type Template = {id: 'ForwardSmsToEmail' | 'TalkToAgent'; title: string};
export const templates: Template[] = [{id: 'ForwardSmsToEmail', title: 'Forward SMS to email'},
  {id: 'TalkToAgent', title: 'Talk to your agent'}];
export function validate(s: Settings): string | undefined {
  if (!s.senders.length || s.senders.some(x => !x.trim() || /[\r\n]/.test(x))) {return 'Add at least one valid sender ID.';}
  if (s.scope === 'filter' && !s.contains.trim()) {return 'Enter the text that a message must contain.';}
  return validateConnection(s);
}
export function validateAgent(s: Settings): string | undefined {
  if (!s.agentSubject?.trim() || /[\r\n]/.test(s.agentSubject) || s.agentSubject.length > 200) {return 'Enter a subject of 1–200 characters on one line.';}
  return validateConnection({...s, destination: s.agentDestination || ''});
}
export function validateConnection(s: Settings): string | undefined {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.destination)) {return 'Enter a valid destination email.';}
  if (!/^[a-z\d.-]+$/i.test(s.host) || !s.host) {return 'Enter the SMTP hostname, without a URL or path.';}
  if (s.port !== 587 && s.port !== 465 && !(s.host === 'localhost' && s.port === 2525)) {return 'Use 587 (STARTTLS) or 465 (TLS). Local TLS testing may use localhost:2525.';}
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.username)) {return 'Enter the sending email address used as your SMTP username.';}
}
export function mailFor(m: Sms, test = false): Mail {
  if (m.voice) {return {id: m.id, subject: m.voice.subject,
    body: `Message ID: ${m.id}\nCreated: ${new Date(m.timestamp).toISOString()}\n\n${m.body}`};}
  return {id: m.id, subject: `Relaybox${test ? ' synthetic test' : ''} · ${m.sender.replace(/[\r\n]/g, '')}`,
    body: `${test ? 'SYNTHETIC TEST — not a received SMS\n\n' : ''}Sender: ${m.sender}\nReceived: ${new Date(m.timestamp).toISOString()}\n\n${m.body}`};
}
export const retryDelay = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 30 * 60_000);
export const permissionFailure = (granted: boolean) => granted ? undefined : 'SMS permission is not granted. No new SMS can be received. Open setup to grant it.';

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
export interface Vault {seal(value: string): Promise<string>; open(value: string): Promise<string>}
// ponytail: one serialized rule and a JSON journal; use indexed storage only if volume warrants it.
export class Queue {
  private store: Store; private vault: Vault; private transport: Transport; private now: () => number;
  constructor(store: Store, vault: Vault, transport: Transport, now = Date.now) {
    this.store = store; this.vault = vault; this.transport = transport; this.now = now;
  }
  async journal(): Promise<Delivery[]> {return JSON.parse(await this.store.get('queue') || '[]');}
  async list(): Promise<Delivery[]> {
    const latest = new Map<string, Delivery>();
    for (const event of await this.journal()) {latest.set(event.id, event);}
    return [...latest.values()];
  }
  async append(event: Delivery) {
    const history = await this.journal();
    // Remove expired metadata on writes; pending payloads are never silently expired.
    const cutoff = this.now() - 7 * 86400_000;
    await this.store.set('queue', JSON.stringify([...history.filter(x => x.timestamp >= cutoff || x.payload).map(x => x.id === event.id && !event.payload ? {...x, payload: undefined} : x), event]));
  }
  async ingest(s: Settings, m: Sms, test = false) {
    if (!m.voice && !test && !matches(s, m)) {return false;}
    if (m.voice) {
      const error = validateAgent({...s, agentDestination: m.voice.destination, agentSubject: m.voice.subject});
      if (error) {throw new Error(error);}
      if (!m.body.trim()) {throw new Error('Enter a prompt before sending.');}
    }
    if ((await this.list()).some(x => x.id === m.id)) {return false;}
    await this.append({id: m.id, sender: m.sender, timestamp: m.timestamp, parts: m.parts,
      payload: await this.vault.seal(JSON.stringify(m)), status: 'queued', attempts: 0, nextAt: this.now(), test, voice: !!m.voice});
    return true;
  }
  async flush(s: Settings, active: (entry: Delivery) => Promise<boolean> = async entry => !!entry.voice || s.enabled, onlyId?: string) {
    for (let entry of await this.list()) {
      if ((onlyId && entry.id !== onlyId) || !entry.payload || entry.status === 'failed' || entry.nextAt > this.now()) {continue;}
      if (!(await active(entry))) {continue;}
      entry = {...entry, status: 'sending', attempts: entry.attempts + 1, reason: undefined};
      await this.append(entry);
      try {
        const m: Sms = JSON.parse(await this.vault.open(entry.payload!));
        await this.transport.send(m.voice ? {...s, destination: m.voice.destination} : s, mailFor(m, entry.test));
        await this.append({...entry, status: 'sent', payload: undefined});
      } catch (error) {
        await this.append({...entry, status: entry.attempts >= 5 ? 'failed' : 'retrying',
          reason: error instanceof Error ? error.message : 'Transport failed', nextAt: this.now() + retryDelay(entry.attempts)});
      }
    }
    return (await this.list()).some(x => x.payload && x.status !== 'failed' && (x.voice || s.enabled));
  }
  async retry() {
    for (const x of await this.list()) {
      if (x.payload && x.status === 'failed') {await this.append({...x, status: 'retrying', attempts: 0, nextAt: this.now(), reason: undefined});}
    }
  }
}
