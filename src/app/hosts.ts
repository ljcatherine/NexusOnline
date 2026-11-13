// Devices, host-key pins and live SSH connections, shared by Overview, Terminal and Files.
// Connections stay open while the page is open and close when it is hidden for a minute
// or unloaded, like the iPhone app closing SSH when it goes to the background.
import { SshConnection } from './ssh';
import { me } from './lib';

export type Target = 'debian' | 'nixos';
export type Device = { name: string; target: Target; username: string };
export const TARGETS: Target[] = ['debian', 'nixos'];
export const TITLE: Record<Target, string> = { debian: 'Debian', nixos: 'NixOS' };

const USERS = 'nexus.devices', PINS = 'nexus.hostkeys';
const read = (k: string): Record<string, string> => { try { return JSON.parse(localStorage.getItem(k) ?? '{}') ?? {}; } catch { return {}; } };
const write = (k: string, v: Record<string, string>) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
export const validUser = (u: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(u);

export async function devices(): Promise<Device[]> {
  const configured: Device[] = (await me())?.devices ?? [];
  const local = read(USERS);
  return TARGETS.map(target => {
    const c = configured.find(d => d.target === target);
    return { name: c?.name ?? TITLE[target], target, username: validUser(local[target] ?? '') ? local[target] : c?.username ?? '' };
  });
}
export function setUsername(target: Target, username: string) {
  const all = read(USERS); all[target] = username; write(USERS, all);
  disconnect(target);
}

export const pins = () => read(PINS);
export function forgetPin(target: Target) { const all = read(PINS); delete all[target]; write(PINS, all); disconnect(target); }

/** First use: the owner confirms the fingerprint. Later: it must match exactly. */
async function checkHost(target: Target, fp: string, type: string) {
  const pinned = pins()[target];
  if (pinned) {
    if (pinned === fp) return true;
    throw new Error(`The ${TITLE[target]} relay host key has CHANGED (now ${fp}, pinned ${pinned}). The connection was refused. ` +
      'If you rotated the relay key on purpose, forget the old pin in Settings and connect again.');
  }
  const ok = confirm(`First connection to ${TITLE[target]} through the relay.\n\nHost key (${type}):\n${fp}\n\n` +
    'Only trust it if it matches the relay host key on the gateway (ssh-keygen -lf <relay host key>.pub). Trust and pin it?');
  if (ok) { const all = read(PINS); all[target] = fp; write(PINS, all); }
  return ok;
}

type State = { status: 'off' | 'connecting' | 'on' | 'error'; error?: string; conn?: SshConnection };
const state = new Map<Target, State>(TARGETS.map(t => [t, { status: 'off' }]));
const pending = new Map<Target, Promise<SshConnection>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(f => f());
export const hostState = (t: Target) => state.get(t)!;
export function onHostChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); }

export function connection(target: Target): Promise<SshConnection> {
  const s = state.get(target)!;
  if (s.conn && !s.conn.closed) return Promise.resolve(s.conn);
  if (pending.has(target)) return pending.get(target)!;
  const p = (async () => {
    const device = (await devices()).find(d => d.target === target)!;
    if (!validUser(device.username)) throw new Error(`Set the SSH username for ${TITLE[target]} first (Devices or Settings).`);
    state.set(target, { status: 'connecting' }); emit();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ssh/${target}`;
    const conn = await SshConnection.connect(url, device.username, (fp, type) => checkHost(target, fp, type));
    conn.onclose = reason => { if (state.get(target)?.conn === conn) { state.set(target, { status: reason === 'Disconnected.' ? 'off' : 'error', error: reason }); emit(); } };
    state.set(target, { status: 'on', conn }); emit();
    return conn;
  })().catch(e => { state.set(target, { status: 'error', error: (e as Error).message }); emit(); throw e; })
    .finally(() => pending.delete(target));
  pending.set(target, p);
  return p;
}

export function disconnect(target: Target) {
  const s = state.get(target)!;
  s.conn?.close();
  state.set(target, { status: 'off' }); emit();
}

let hiddenTimer = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) hiddenTimer = window.setTimeout(() => TARGETS.forEach(disconnect), 60_000);
});
addEventListener('pagehide', () => TARGETS.forEach(disconnect));

export type HostStats = { load: number[]; cpus: number; memTotal: number; memAvail: number; diskTotal: number; diskUsed: number; uptime: number };

/** One read-only command; every field is parsed defensively. */
export async function hostStats(target: Target): Promise<HostStats> {
  const conn = await connection(target);
  const out = await conn.exec("cat /proc/loadavg; nproc; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; df -kP / | tail -n 1; cat /proc/uptime", 8192);
  const lines = out.split('\n');
  const num = (s: string | undefined) => Number.parseFloat(s ?? '') || 0;
  const mem = (key: string) => num(lines.find(l => l.startsWith(key))?.split(/\s+/)[1]) * 1024;
  const df = (lines.find(l => l.startsWith('/') || / \/$/.test(l)) ?? '').trim().split(/\s+/);
  return {
    load: (lines[0] ?? '').split(' ').slice(0, 3).map(num), cpus: num(lines[1]) || 1,
    memTotal: mem('MemTotal:'), memAvail: mem('MemAvailable:'),
    diskTotal: num(df[1]) * 1024, diskUsed: num(df[2]) * 1024,
    uptime: num(lines.filter(Boolean).at(-1)?.split(' ')[0]),
  };
}
