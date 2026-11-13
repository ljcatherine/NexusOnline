// Minimal SSH-2 client that runs in the browser, over the gateway's WebSocket relay
// (/api/v1/ssh/{debian|nixos}, subprotocol nexus-ssh-v1). Everything is WebCrypto:
// curve25519-sha256 key exchange, AES-GCM transport, Ed25519/ECDSA/RSA host keys.
// The relay is an SSH server that accepts the "none" method for its configured user
// and then connects to the host with its own pinned key, so no secret lives here.
// The host key is pinned on first use (after the owner confirms it) and a changed key is refused.

const enc = new TextEncoder();
const dec = new TextDecoder();
const CLIENT_VERSION = 'SSH-2.0-NexusOnline_1.0';

// ---------- wire encoding ----------
export class Writer {
  private parts: Uint8Array[] = [];
  byte(n: number) { this.parts.push(Uint8Array.of(n)); return this; }
  bool(b: boolean) { return this.byte(b ? 1 : 0); }
  u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); this.parts.push(b); return this; }
  u64(n: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); this.parts.push(b); return this; }
  raw(b: Uint8Array) { this.parts.push(b); return this; }
  str(s: string | Uint8Array) { const b = typeof s === 'string' ? enc.encode(s) : s; return this.u32(b.length).raw(b); }
  mpint(b: Uint8Array) {
    let i = 0; while (i < b.length && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v.length && v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return this.str(v);
  }
  out() { return concat(...this.parts); }
}

export class Reader {
  off = 0;
  constructor(public buf: Uint8Array) {}
  private need(n: number) { if (this.off + n > this.buf.length) throw new Error('SSH message is truncated.'); }
  byte() { this.need(1); return this.buf[this.off++]; }
  bool() { return this.byte() !== 0; }
  u32() { this.need(4); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getUint32(0); this.off += 4; return v; }
  u64() { this.need(8); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getBigUint64(0); this.off += 8; return Number(v); }
  bytes() { const n = this.u32(); this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  str() { return dec.decode(this.bytes()); }
  rest() { return this.buf.subarray(this.off); }
}

export function concat(...arrs: Uint8Array[]) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const sha = async (alg: string, data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, data));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- message numbers ----------
const M = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
};

const KEX = ['curve25519-sha256', 'curve25519-sha256@libssh.org'];
const HOSTKEY = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'];
const CIPHER = ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'];
const MAC = ['hmac-sha2-256']; // unused with GCM, but a name must be listed

function pick(ours: string[], theirs: string, what: string) {
  const list = theirs.split(',');
  const hit = ours.find(a => list.includes(a));
  if (!hit) throw new Error(`The server offers no supported ${what} (${theirs}).`);
  return hit;
}

// ---------- host keys ----------
export async function fingerprint(blob: Uint8Array) {
  return 'SHA256:' + b64(await sha('SHA-256', blob)).replace(/=+$/, '');
}

function fixed(n: Uint8Array, len: number) {
  let i = 0; while (i < n.length - len && n[i] === 0) i++;
  const v = n.subarray(i);
  if (v.length > len) throw new Error('Bad signature integer.');
  const out = new Uint8Array(len); out.set(v, len - v.length); return out;
}

async function verifyHostSignature(blob: Uint8Array, sigBlob: Uint8Array, data: Uint8Array) {
  const k = new Reader(blob), s = new Reader(sigBlob);
  const keyType = k.str(), sigType = s.str(), sig = s.bytes();
  if (keyType === 'ssh-ed25519' && sigType === 'ssh-ed25519') {
    const key = await crypto.subtle.importKey('raw', k.bytes(), { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data);
  }
  if (keyType === 'ecdsa-sha2-nistp256' && sigType === keyType) {
    k.str(); const q = k.bytes();
    const key = await crypto.subtle.importKey('raw', q, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const rs = new Reader(sig);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(fixed(rs.bytes(), 32), fixed(rs.bytes(), 32)), data);
  }
  if (keyType === 'ssh-rsa' && (sigType === 'rsa-sha2-256' || sigType === 'rsa-sha2-512')) {
    const strip = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
    const e = strip(k.bytes()), n = strip(k.bytes());
    const hash = sigType === 'rsa-sha2-256' ? 'SHA-256' : 'SHA-512';
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: b64url(n), e: b64url(e), ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  }
  throw new Error(`Unsupported host key signature ${sigType} for ${keyType}.`);
}

// ---------- AES-GCM transport (RFC 5647 as used by OpenSSH) ----------
class Gcm {
  private counter = 0n;
  constructor(private key: CryptoKey, private iv: Uint8Array) {}
  static async make(key: Uint8Array, iv: Uint8Array) {
    return new Gcm(await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']), iv.slice(0, 12));
  }
  private nonce() {
    const n = this.iv.slice();
    const dv = new DataView(n.buffer);
    dv.setBigUint64(4, (dv.getBigUint64(4) + this.counter) & 0xffffffffffffffffn);
    this.counter++;
    return n;
  }
  async seal(len: Uint8Array, body: Uint8Array) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: this.nonce(), additionalData: len }, this.key, body));
  }
  async open(len: Uint8Array, body: Uint8Array) {
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.nonce(), additionalData: len }, this.key, body)); }
    catch { throw new Error('SSH packet failed integrity check.'); }
  }
}

// ---------- channels ----------
export class Channel {
  remoteId = -1;
  remoteWindow = 0;
  remoteMax = 32768;
  localWindow = 2 * 1024 * 1024;
  closed = false;
  ondata: (d: Uint8Array) => void = () => {};
  onstderr: (d: Uint8Array) => void = () => {};
  onclose: () => void = () => {};
  onexit: (code: number) => void = () => {};
  private queue: Uint8Array[] = [];
  private requests: ((ok: boolean) => void)[] = [];
  private drained: (() => void)[] = [];
  constructor(private conn: SshConnection, public id: number) {}

  /** Sends data, respecting the remote window. Resolves once it is handed to the socket. */
  write(data: Uint8Array | string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The channel is closed.'));
    this.queue.push(typeof data === 'string' ? enc.encode(data) : data);
    this.flush();
    return this.queue.length ? new Promise(r => this.drained.push(r)) : Promise.resolve();
  }
  flush() {
    while (this.queue.length && this.remoteWindow > 0) {
      const head = this.queue[0];
      const n = Math.min(head.length, this.remoteWindow, this.remoteMax - 64);
      this.conn.send(new Writer().byte(M.CHANNEL_DATA).u32(this.remoteId).str(head.subarray(0, n)).out());
      this.remoteWindow -= n;
      if (n === head.length) this.queue.shift(); else this.queue[0] = head.subarray(n);
    }
    if (!this.queue.length) this.drained.splice(0).forEach(r => r());
  }
  request(type: string, payload: Uint8Array = new Uint8Array(), wantReply = true): Promise<boolean> {
    this.conn.send(new Writer().byte(M.CHANNEL_REQUEST).u32(this.remoteId).str(type).bool(wantReply).raw(payload).out());
    return wantReply ? new Promise(r => this.requests.push(r)) : Promise.resolve(true);
  }
  pty(cols: number, rows: number) {
    return this.request('pty-req', new Writer().str('xterm-256color').u32(cols).u32(rows).u32(0).u32(0).str(Uint8Array.of(0)).out());
  }
  resize(cols: number, rows: number) {
    if (!this.closed) this.request('window-change', new Writer().u32(cols).u32(rows).u32(0).u32(0).out(), false);
  }
  close() {
    if (this.closed) return;
    this.conn.send(new Writer().byte(M.CHANNEL_CLOSE).u32(this.remoteId).out());
    this.end();
  }
  /** @internal */ end() {
    if (this.closed) return;
    this.closed = true;
    this.requests.splice(0).forEach(r => r(false));
    this.drained.splice(0).forEach(r => r());
    this.conn.channels.delete(this.id);
    this.onclose();
  }
  /** @internal */ handle(type: number, r: Reader) {
    switch (type) {
      case M.CHANNEL_WINDOW_ADJUST: this.remoteWindow += r.u32(); this.flush(); break;
      case M.CHANNEL_DATA: case M.CHANNEL_EXTENDED_DATA: {
        const stderr = type === M.CHANNEL_EXTENDED_DATA && r.u32() === 1;
        const d = r.bytes();
        this.localWindow -= d.length;
        if (this.localWindow < 1024 * 1024) {
          this.conn.send(new Writer().byte(M.CHANNEL_WINDOW_ADJUST).u32(this.remoteId).u32(2 * 1024 * 1024 - this.localWindow).out());
          this.localWindow = 2 * 1024 * 1024;
        }
        (stderr ? this.onstderr : this.ondata)(d);
        break;
      }
      case M.CHANNEL_EOF: break;
      case M.CHANNEL_CLOSE:
        if (!this.closed) this.conn.send(new Writer().byte(M.CHANNEL_CLOSE).u32(this.remoteId).out());
        this.end(); break;
      case M.CHANNEL_REQUEST: {
        const name = r.str(), want = r.bool();
        if (name === 'exit-status') this.onexit(r.u32());
        if (want) this.conn.send(new Writer().byte(M.CHANNEL_FAILURE).u32(this.remoteId).out());
        break;
      }
      case M.CHANNEL_SUCCESS: case M.CHANNEL_FAILURE: this.requests.shift()?.(type === M.CHANNEL_SUCCESS); break;
    }
  }
}

// ---------- connection ----------
export type HostKeyCheck = (fingerprint: string, keyType: string) => Promise<boolean>;

export class SshConnection {
  channels = new Map<number, Channel>();
  closed = false;
  onclose: (reason: string) => void = () => {};
  private ws!: WebSocket;
  private inbuf = new Uint8Array(0);
  private waiters: (() => void)[] = [];
  private sendCipher: Gcm | null = null;
  private recvCipher: Gcm | null = null;
  private nextChannel = 0;
  private pendingOpen = new Map<number, [(c: Channel) => void, (e: Error) => void]>();
  private failure = '';
  private sendChain = Promise.resolve();

  /** Opens the tunnel, runs key exchange, checks the host key and authenticates as `user`. */
  static async connect(url: string, user: string, checkHost: HostKeyCheck): Promise<SshConnection> {
    const c = new SshConnection();
    await c.open(url);
    try { await c.handshake(user, checkHost); } catch (e) { c.shutdown((e as Error).message); throw e; }
    c.pump();
    return c;
  }

  private open(url: string) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, 'nexus-ssh-v1');
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => ws.protocol === 'nexus-ssh-v1' ? resolve() : (ws.close(), reject(new Error('The relay did not accept the SSH protocol.')));
      ws.onerror = () => reject(new Error('The SSH relay is unreachable. Check that you are signed in and the gateway is up.'));
      ws.onmessage = e => { this.inbuf = concat(this.inbuf, new Uint8Array(e.data as ArrayBuffer)); this.waiters.splice(0).forEach(w => w()); };
      ws.onclose = () => this.shutdown(this.failure || 'The connection closed.');
    });
  }

  private async need(n: number) {
    while (this.inbuf.length < n) {
      if (this.closed) throw new Error(this.failure || 'The connection closed.');
      await new Promise<void>(r => this.waiters.push(r));
    }
  }
  private take(n: number) { const v = this.inbuf.slice(0, n); this.inbuf = this.inbuf.subarray(n); return v; }

  private async readLine() {
    for (;;) {
      const i = this.inbuf.indexOf(10);
      if (i >= 0) return dec.decode(this.take(i + 1)).replace(/\r?\n$/, '');
      if (this.inbuf.length > 8192) throw new Error('The server sent no SSH version.');
      await this.need(this.inbuf.length + 1);
    }
  }

  private async readPacket(): Promise<Uint8Array> {
    await this.need(4);
    const lenBytes = this.inbuf.slice(0, 4);
    const len = new DataView(lenBytes.buffer).getUint32(0);
    if (len < 5 || len > 256 * 1024) throw new Error('SSH packet has a bad length.');
    const tag = this.recvCipher ? 16 : 0;
    await this.need(4 + len + tag);
    this.take(4);
    const body = this.recvCipher ? await this.recvCipher.open(lenBytes, this.take(len + tag)) : this.take(len);
    const pad = body[0];
    if (pad < 4 || pad >= len) throw new Error('SSH packet has bad padding.');
    return body.subarray(1, len - pad);
  }

  /** Queues a packet; encryption is async, so sends are chained to keep order and nonces in step. */
  send(payload: Uint8Array) {
    this.sendChain = this.sendChain.then(() => this.writePacket(payload)).catch(e => this.shutdown((e as Error).message));
    return this.sendChain;
  }
  private async writePacket(payload: Uint8Array) {
    if (this.closed) return;
    const block = this.sendCipher ? 16 : 8;
    const lenField = this.sendCipher ? 0 : 4; // GCM: length is not part of the padded block
    let pad = block - ((lenField + 1 + payload.length) % block);
    if (pad < 4) pad += block;
    const body = concat(Uint8Array.of(pad), payload, crypto.getRandomValues(new Uint8Array(pad)));
    const len = new Writer().u32(body.length).out();
    this.ws.send(concat(len, this.sendCipher ? await this.sendCipher.seal(len, body) : body));
  }

  private async expect(type: number) {
    for (;;) {
      const p = await this.readPacket();
      if (p[0] === M.IGNORE || p[0] === M.DEBUG || p[0] === M.EXT_INFO || p[0] === M.USERAUTH_BANNER) continue;
      if (p[0] === M.DISCONNECT) { const r = new Reader(p.subarray(1)); r.u32(); throw new Error(`The server disconnected: ${r.str()}`); }
      if (p[0] !== type) throw new Error(`Unexpected SSH message ${p[0]} (wanted ${type}).`);
      return p;
    }
  }

  private async handshake(user: string, checkHost: HostKeyCheck) {
    this.ws.send(enc.encode(CLIENT_VERSION + '\r\n'));
    let serverVersion = '';
    for (let i = 0; i < 50 && !serverVersion.startsWith('SSH-'); i++) serverVersion = await this.readLine();
    if (!serverVersion.startsWith('SSH-2.0-')) throw new Error('The relay is not an SSH-2 server.');

    const ourKexinit = new Writer().byte(M.KEXINIT).raw(crypto.getRandomValues(new Uint8Array(16)))
      .str(KEX.join(',')).str(HOSTKEY.join(',')).str(CIPHER.join(',')).str(CIPHER.join(','))
      .str(MAC.join(',')).str(MAC.join(',')).str('none').str('none').str('').str('').bool(false).u32(0).out();
    this.send(ourKexinit);
    const theirKexinit = await this.expect(M.KEXINIT);
    const r = new Reader(theirKexinit.subarray(17));
    const names = Array.from({ length: 10 }, () => r.str());
    pick(KEX, names[0], 'key exchange');
    const hostAlg = pick(HOSTKEY, names[1], 'host key type');
    const c2s = pick(CIPHER, names[2], 'cipher'), s2c = pick(CIPHER, names[3], 'cipher');
    if (!names[6].split(',').includes('none') || !names[7].split(',').includes('none')) throw new Error('The server requires compression.');
    if (r.bool()) throw new Error('The server guessed a key exchange packet, which is not supported.');

    const eph = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    const qc = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    this.send(new Writer().byte(M.KEX_ECDH_INIT).str(qc).out());
    const reply = new Reader((await this.expect(M.KEX_ECDH_REPLY)).subarray(1));
    const hostBlob = reply.bytes(), qs = reply.bytes(), sig = reply.bytes();
    if (qs.length !== 32) throw new Error('Bad key exchange reply.');
    const peer = await crypto.subtle.importKey('raw', qs, { name: 'X25519' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, eph.privateKey, 256));
    if (shared.every(b => b === 0)) throw new Error('Bad key exchange result.');
    const K = new Writer().mpint(shared).out();
    const H = await sha('SHA-256', concat(new Writer().str(CLIENT_VERSION).str(serverVersion).str(ourKexinit).str(theirKexinit)
      .str(hostBlob).str(qc).str(qs).out(), K));

    const hostType = new Reader(hostBlob).str();
    if (hostType !== (hostAlg.startsWith('rsa-') ? 'ssh-rsa' : hostAlg)) throw new Error('Host key type does not match what was negotiated.');
    if (!await verifyHostSignature(hostBlob, sig, H)) throw new Error('The host key signature is invalid. The connection was stopped.');
    if (!await checkHost(await fingerprint(hostBlob), hostType)) throw new Error('Host key not trusted. The connection was stopped.');

    const derive = async (letter: string, len: number) => {
      let out = await sha('SHA-256', concat(K, H, enc.encode(letter), H));
      while (out.length < len) out = concat(out, await sha('SHA-256', concat(K, H, out)));
      return out.subarray(0, len);
    };
    const keyLen = (c: string) => c.startsWith('aes256') ? 32 : 16;
    this.send(new Writer().byte(M.NEWKEYS).out());
    const nextSend = await Gcm.make(await derive('C', keyLen(c2s)), await derive('A', 12));
    const nextRecv = await Gcm.make(await derive('D', keyLen(s2c)), await derive('B', 12));
    await this.sendChain;
    this.sendCipher = nextSend;
    await this.expect(M.NEWKEYS);
    this.recvCipher = nextRecv;

    this.send(new Writer().byte(M.SERVICE_REQUEST).str('ssh-userauth').out());
    await this.expect(M.SERVICE_ACCEPT);
    this.send(new Writer().byte(M.USERAUTH_REQUEST).str(user).str('ssh-connection').str('none').out());
    const auth = await this.readAuthResult();
    if (!auth) throw new Error(`The relay refused user “${user}”. Check the username for this device.`);
  }

  private async readAuthResult() {
    for (;;) {
      const p = await this.readPacket();
      if (p[0] === M.USERAUTH_SUCCESS) return true;
      if (p[0] === M.USERAUTH_FAILURE) return false;
      if (p[0] === M.DISCONNECT) { const r = new Reader(p.subarray(1)); r.u32(); throw new Error(`The server disconnected: ${r.str()}`); }
    }
  }

  private async pump() {
    try {
      for (;;) {
        const p = await this.readPacket();
        const r = new Reader(p.subarray(1));
        switch (p[0]) {
          case M.IGNORE: case M.DEBUG: case M.UNIMPLEMENTED: case M.EXT_INFO: break;
          case M.DISCONNECT: r.u32(); this.failure = `The server disconnected: ${r.str()}`; this.ws.close(); return;
          // shortcut: no re-key support; OpenSSH/x/crypto re-key after ~1 GB, upgrade if large transfers need it.
          case M.KEXINIT: throw new Error('The server asked to re-key, which Nexus Online does not support yet. Reconnect to continue.');
          case M.GLOBAL_REQUEST: { r.str(); if (r.bool()) this.send(Uint8Array.of(M.REQUEST_FAILURE)); break; }
          case M.CHANNEL_OPEN: {
            r.str(); const sender = r.u32();
            this.send(new Writer().byte(M.CHANNEL_OPEN_FAILURE).u32(sender).u32(1).str('not accepted').str('').out());
            break;
          }
          case M.CHANNEL_OPEN_CONFIRMATION: {
            const id = r.u32(), ch = this.channels.get(id), waiter = this.pendingOpen.get(id);
            if (!ch || !waiter) break;
            ch.remoteId = r.u32(); ch.remoteWindow = r.u32(); ch.remoteMax = r.u32();
            this.pendingOpen.delete(id); waiter[0](ch); break;
          }
          case M.CHANNEL_OPEN_FAILURE: {
            const id = r.u32(); r.u32(); const why = r.str();
            this.channels.delete(id); this.pendingOpen.get(id)?.[1](new Error(`The server refused the session: ${why}`)); this.pendingOpen.delete(id); break;
          }
          default:
            if (p[0] >= M.CHANNEL_WINDOW_ADJUST && p[0] <= M.CHANNEL_FAILURE) this.channels.get(r.u32())?.handle(p[0], r);
        }
      }
    } catch (e) {
      this.shutdown((e as Error).message);
    }
  }

  /** Opens a session channel. */
  session(): Promise<Channel> {
    if (this.closed) return Promise.reject(new Error(this.failure || 'Not connected.'));
    const ch = new Channel(this, this.nextChannel++);
    this.channels.set(ch.id, ch);
    this.send(new Writer().byte(M.CHANNEL_OPEN).str('session').u32(ch.id).u32(ch.localWindow).u32(32768).out());
    return new Promise((resolve, reject) => this.pendingOpen.set(ch.id, [resolve, reject]));
  }

  /** Runs one command and returns its stdout (bounded). */
  async exec(command: string, limit = 64 * 1024): Promise<string> {
    const ch = await this.session();
    const parts: Uint8Array[] = []; let size = 0;
    const done = new Promise<void>(r => { ch.onclose = r; });
    ch.ondata = d => { if (size < limit) { parts.push(d); size += d.length; } };
    if (!await ch.request('exec', new Writer().str(command).out())) { ch.close(); throw new Error('The server refused to run the command.'); }
    await done;
    return dec.decode(concat(...parts)).slice(0, limit);
  }

  close() { this.failure ||= 'Disconnected.'; this.shutdown(this.failure); }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.failure ||= reason;
    this.waiters.splice(0).forEach(w => w());
    for (const [, [, reject]] of this.pendingOpen) reject(new Error(reason));
    this.pendingOpen.clear();
    [...this.channels.values()].forEach(c => c.end());
    try { this.ws.close(); } catch { /* already closed */ }
    this.onclose(reason);
  }
}
