// SFTP version 3 over an SSH session channel (draft-ietf-secsh-filexfer-02), as OpenSSH speaks it.
import { Channel, SshConnection, Reader, Writer, concat } from './ssh';

const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
};
const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3 };
export const OPEN = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 };
const CHUNK = 32 * 1024, IN_FLIGHT = 16;

export type Attrs = { size?: number; uid?: number; gid?: number; mode?: number; mtime?: number };
export type Entry = { name: string; longname: string; attrs: Attrs };
export const isDir = (a: Attrs) => ((a.mode ?? 0) & 0o170000) === 0o040000;
export const isLink = (a: Attrs) => ((a.mode ?? 0) & 0o170000) === 0o120000;

export class SftpError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

function readAttrs(r: Reader): Attrs {
  const flags = r.u32(), a: Attrs = {};
  if (flags & 1) a.size = r.u64();
  if (flags & 2) { a.uid = r.u32(); a.gid = r.u32(); }
  if (flags & 4) a.mode = r.u32();
  if (flags & 8) { r.u32(); a.mtime = r.u32(); }
  if (flags & 0x80000000) for (let n = r.u32(); n > 0; n--) { r.bytes(); r.bytes(); }
  return a;
}
const writeAttrs = (w: Writer, a: Attrs = {}) => a.mode === undefined ? w.u32(0) : w.u32(4).u32(a.mode);

export class Sftp {
  private buf = new Uint8Array(0);
  private nextId = 1;
  private pending = new Map<number, [(r: [number, Reader]) => void, (e: Error) => void]>();

  private constructor(private ch: Channel) {}

  static async open(conn: SshConnection): Promise<Sftp> {
    const ch = await conn.session();
    if (!await ch.request('subsystem', new Writer().str('sftp').out())) { ch.close(); throw new Error('The server has no SFTP subsystem.'); }
    const s = new Sftp(ch);
    const version = new Promise<void>((resolve, reject) => s.pending.set(0, [() => resolve(), reject]));
    ch.ondata = d => s.onData(d);
    ch.onclose = () => { for (const [, [, rej]] of s.pending) rej(new Error('The SFTP session closed.')); s.pending.clear(); };
    await ch.write(concat(new Writer().u32(5).byte(T.INIT).u32(3).out()));
    await version;
    return s;
  }

  get closed() { return this.ch.closed; }
  close() { this.ch.close(); }

  private onData(d: Uint8Array) {
    this.buf = concat(this.buf, d);
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0);
      if (len > 512 * 1024) { this.ch.close(); return; }
      if (this.buf.length < 4 + len) return;
      const r = new Reader(this.buf.slice(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      const type = r.byte();
      const id = type === T.VERSION ? 0 : r.u32();
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.[0]([type, r]);
    }
  }

  private call(type: number, body: (w: Writer) => Writer): Promise<[number, Reader]> {
    if (this.ch.closed) return Promise.reject(new Error('The SFTP session closed.'));
    const id = this.nextId++;
    const payload = body(new Writer().byte(type).u32(id)).out();
    const p = new Promise<[number, Reader]>((res, rej) => this.pending.set(id, [res, rej]));
    this.ch.write(concat(new Writer().u32(payload.length).out(), payload)).catch(() => {});
    return p;
  }

  private static status(type: number, r: Reader, path = ''): never | void {
    if (type !== T.STATUS) throw new Error(`Unexpected SFTP reply ${type}.`);
    const code = r.u32(), msg = r.str();
    if (code === FX.OK) return;
    const where = path ? ` (${path})` : '';
    if (code === FX.NO_SUCH_FILE) throw new SftpError(code, `No such file or folder${where}.`);
    if (code === FX.PERMISSION_DENIED) throw new SftpError(code, `Permission denied${where}.`);
    throw new SftpError(code, `${msg || 'SFTP error'}${where}.`);
  }
  private async handle(type: number, path: string, body: (w: Writer) => Writer) {
    const [t, r] = await this.call(type, body);
    if (t === T.HANDLE) return r.bytes();
    Sftp.status(t, r, path); throw new Error('No handle.');
  }
  private async ok(type: number, path: string, body: (w: Writer) => Writer) {
    const [t, r] = await this.call(type, body); Sftp.status(t, r, path);
  }

  async realpath(path: string) {
    const [t, r] = await this.call(T.REALPATH, w => w.str(path));
    if (t !== T.NAME) Sftp.status(t, r, path);
    r.u32(); return r.str();
  }
  async stat(path: string): Promise<Attrs> {
    const [t, r] = await this.call(T.STAT, w => w.str(path));
    if (t !== T.ATTRS) Sftp.status(t, r, path);
    return readAttrs(r);
  }
  async lstat(path: string): Promise<Attrs> {
    const [t, r] = await this.call(T.LSTAT, w => w.str(path));
    if (t !== T.ATTRS) Sftp.status(t, r, path);
    return readAttrs(r);
  }
  async exists(path: string) {
    try { await this.stat(path); return true; } catch (e) { if (e instanceof SftpError && e.code === FX.NO_SUCH_FILE) return false; throw e; }
  }
  async list(path: string): Promise<Entry[]> {
    const h = await this.handle(T.OPENDIR, path, w => w.str(path));
    const out: Entry[] = [];
    try {
      for (;;) {
        const [t, r] = await this.call(T.READDIR, w => w.str(h));
        if (t === T.STATUS) { const code = new Reader(r.rest()).u32(); if (code === FX.EOF) break; Sftp.status(t, r, path); }
        if (t !== T.NAME) throw new Error('Unexpected SFTP reply.');
        for (let n = r.u32(); n > 0; n--) {
          const name = r.str(), longname = r.str(), attrs = readAttrs(r);
          if (name !== '.' && name !== '..') out.push({ name, longname, attrs });
        }
        if (out.length > 20_000) break;
      }
    } finally { this.ok(T.CLOSE, path, w => w.str(h)).catch(() => {}); }
    return out;
  }
  mkdir(path: string) { return this.ok(T.MKDIR, path, w => writeAttrs(w.str(path), { mode: 0o755 })); }
  rmdir(path: string) { return this.ok(T.RMDIR, path, w => w.str(path)); }
  remove(path: string) { return this.ok(T.REMOVE, path, w => w.str(path)); }
  rename(from: string, to: string) { return this.ok(T.RENAME, from, w => w.str(from).str(to)); }
  chmod(path: string, mode: number) { return this.ok(T.SETSTAT, path, w => writeAttrs(w.str(path), { mode })); }

  /** Reads a whole file with up to 16 requests in flight. */
  async read(path: string, onProgress: (done: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<Uint8Array> {
    const size = (await this.stat(path)).size ?? 0;
    const h = await this.handle(T.OPEN, path, w => writeAttrs(w.str(path).u32(OPEN.READ)));
    const chunks: Uint8Array[] = [];
    let offset = 0, done = 0, eof = false;
    try {
      const one = async (): Promise<void> => {
        while (!eof) {
          signal?.throwIfAborted();
          const at = offset; offset += CHUNK;
          const [t, r] = await this.call(T.READ, w => w.str(h).u64(at).u32(CHUNK));
          if (t === T.STATUS) { const code = new Reader(r.rest()).u32(); if (code === FX.EOF) { eof = true; return; } Sftp.status(t, r, path); }
          const data = r.bytes();
          chunks[at / CHUNK] = data; done += data.length;
          onProgress(done, size);
          if (data.length < CHUNK) {
            if (at + data.length < size) throw new Error(`Short read from ${path}; the file may be changing. Try again.`);
            eof = true;
          }
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, one));
    } finally { this.ok(T.CLOSE, path, w => w.str(h)).catch(() => {}); }
    return concat(...chunks.filter(Boolean));
  }

  /** Writes a whole file (create/truncate, or create-new when `exclusive`) with pipelined writes. */
  async write(path: string, data: Blob | Uint8Array, opts: { exclusive?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}) {
    const flags = OPEN.WRITE | OPEN.CREAT | (opts.exclusive ? OPEN.EXCL : OPEN.TRUNC);
    const h = await this.handle(T.OPEN, path, w => writeAttrs(w.str(path).u32(flags), { mode: 0o644 }));
    const total = data instanceof Blob ? data.size : data.length;
    let offset = 0, done = 0;
    try {
      const one = async (): Promise<void> => {
        while (offset < total) {
          opts.signal?.throwIfAborted();
          const at = offset; offset += CHUNK;
          const end = Math.min(at + CHUNK, total);
          const part = data instanceof Blob ? new Uint8Array(await data.slice(at, end).arrayBuffer()) : data.subarray(at, end);
          await this.ok(T.WRITE, path, w => w.str(h).u64(at).str(part));
          done += part.length; opts.onProgress?.(done, total);
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, one));
    } finally { await this.ok(T.CLOSE, path, w => w.str(h)).catch(() => {}); }
  }

  /** Deletes a file, or a folder and everything in it. */
  async removeTree(path: string, onItem: (p: string) => void = () => {}) {
    const a = await this.lstat(path); // lstat: never follow a link out of the tree
    if (!isDir(a)) { onItem(path); return this.remove(path); }
    for (const e of await this.list(path)) {
      const child = `${path}/${e.name}`;
      if (isDir(e.attrs) && !isLink(e.attrs)) await this.removeTree(child, onItem); else { onItem(child); await this.remove(child); }
    }
    onItem(path); await this.rmdir(path);
  }
}
