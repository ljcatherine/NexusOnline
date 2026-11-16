// Floating composer for new mail, replies, forwards and drafts. One open at a time.
import { h } from '../app/lib';
import { call, icon, toast, size, type Addr } from './shared';

export type ComposeInit = {
  id?: string; from?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string;
  replyOf?: string; forwardOf?: string; forwardFiles?: { filename: string; size: number }[]; title?: string;
  focusBody?: boolean;
};
type Settings = { from: string[]; name: string; sending: boolean };

const MAX_ATTACH = 18 * 1024 * 1024; // base64 grows 4/3; the message limit is 25 MB
let settings: Settings = { from: [], name: '', sending: false };
let current: { close: (save: boolean) => Promise<void> } | null = null;
let onSent: (threadId: string) => void = () => {};

export function setupComposer(s: Settings, sent: (threadId: string) => void) { settings = s; onSent = sent; }

const fmtAddr = (a: Addr) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const addrList = (list: Addr[]) => list.map(fmtAddr);
const valid = (v: string) => /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/.test(v.match(/<([^>]+)>\s*$/)?.[1] ?? v.trim());

/** Recipient field: typed addresses become chips on Enter, comma, Tab or leaving the field. */
function recipients(label: string, initial: string[], onChange: () => void) {
  const values: string[] = [];
  const input = h('input', { type: 'text', list: 'contacts', autocomplete: 'off', 'aria-label': label, spellcheck: 'false' });
  const box = h('div', { class: 'rcpt' }, h('span', { class: 'rcpt-l' }, label));
  const chips = h('span', { class: 'chips' });
  box.append(chips, input);
  const draw = () => chips.replaceChildren(...values.map((v, i) => h('span', { class: `chip${valid(v) ? '' : ' bad'}`, title: v },
    v.replace(/\s*<[^>]+>\s*$/, '') || v,
    h('button', { type: 'button', 'aria-label': `Remove ${v}`, onclick: () => { values.splice(i, 1); draw(); onChange(); } }, '×'))));
  const commit = () => {
    const parts = input.value.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    values.push(...parts); input.value = ''; draw(); onChange();
  };
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') && input.value.trim()) { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); draw(); onChange(); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('change', () => { if (input.value.includes('@')) commit(); }); // picked from the suggestions
  box.addEventListener('click', e => { if (e.target === box || e.target === chips) input.focus(); });
  values.push(...initial); draw();
  return { el: box, input, get: () => { commit(); return [...values]; } };
}

const readFile = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export async function compose(init: ComposeInit = {}) {
  if (current) await current.close(true);
  const id = init.id ?? crypto.randomUUID();
  let savedOnce = !!init.id, dirty = false, timer = 0, busy = false, confirmEmpty = false;
  const files: File[] = [];
  const keep = (init.forwardFiles ?? []).map((f, i) => ({ ...f, i, on: true }));

  const status = h('span', { class: 'cmp-status', role: 'status' });
  const touched = () => { dirty = true; status.textContent = ''; clearTimeout(timer); timer = window.setTimeout(save, 2500); };
  const to = recipients('To', init.to ?? [], touched);
  const cc = recipients('Cc', init.cc ?? [], touched);
  const bcc = recipients('Bcc', init.bcc ?? [], touched);
  const ccRow = h('div', { class: 'cmp-row' }, cc.el, bcc.el);
  ccRow.hidden = !(init.cc?.length || init.bcc?.length);
  const subject = h('input', { type: 'text', class: 'cmp-subject', placeholder: 'Subject', 'aria-label': 'Subject', value: init.subject ?? '', oninput: touched });
  const body = h('textarea', { class: 'cmp-body', 'aria-label': 'Message', oninput: touched });
  body.value = init.text ?? '';
  const senders = settings.from.length ? settings.from : [''];
  const from = h('select', { class: 'cmp-from', 'aria-label': 'From', onchange: touched },
    ...senders.map(a => h('option', { value: a, selected: a === (init.from || senders[0]) }, settings.name ? `${settings.name} <${a}>` : a)));
  const error = h('div', { class: 'cmp-error', role: 'alert' });
  error.hidden = true;
  const attachList = h('div', { class: 'cmp-files' });
  const picker = h('input', { type: 'file', multiple: true, onchange: () => { files.push(...(picker.files ?? [])); picker.value = ''; drawFiles(); touched(); } });
  picker.hidden = true;

  const total = () => files.reduce((n, f) => n + f.size, 0) + keep.filter(k => k.on).reduce((n, k) => n + k.size, 0);
  function drawFiles() {
    const chip = (name: string, bytes: number, remove: () => void) => h('span', { class: 'file' }, icon('attach'), h('span', { class: 'fn' }, name), h('small', {}, size(bytes)),
      h('button', { type: 'button', 'aria-label': `Remove ${name}`, onclick: () => { remove(); drawFiles(); } }, '×'));
    attachList.replaceChildren(
      ...keep.filter(k => k.on).map(k => chip(k.filename, k.size, () => { k.on = false; })),
      ...files.map((f, i) => chip(f.name, f.size, () => { files.splice(i, 1); })));
    const over = total() > MAX_ATTACH;
    error.hidden = !over;
    if (over) error.textContent = `Attachments total ${size(total())}. The limit is ${size(MAX_ATTACH)}.`;
  }

  const fields = () => ({
    from: from.value, to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subject.value, text: body.value,
    ...(init.replyOf ? { replyOf: init.replyOf } : {}), ...(init.forwardOf ? { forwardOf: init.forwardOf } : {}),
  });
  const empty = () => { const f = fields(); return !f.to.length && !f.cc.length && !f.bcc.length && !f.subject.trim() && !f.text.trim() && !files.length; };

  async function save() {
    clearTimeout(timer);
    if (busy || !dirty || (empty() && !savedOnce)) return;
    try {
      status.textContent = 'Saving…';
      await call(`/drafts/${id}`, { method: 'PUT', body: JSON.stringify(fields()) });
      savedOnce = true; dirty = false;
      status.textContent = files.length ? 'Draft saved (without attachments)' : 'Draft saved';
    } catch (e) { status.textContent = `Draft not saved: ${(e as Error).message}`; }
  }

  async function send() {
    if (busy) return;
    const f = fields();
    const bad = [...f.to, ...f.cc, ...f.bcc].filter(v => !valid(v));
    error.hidden = false;
    if (!f.to.length && !f.cc.length && !f.bcc.length) { error.textContent = 'Add at least one recipient.'; return; }
    if (bad.length) { error.textContent = `Check ${bad.length > 1 ? 'these addresses' : 'this address'}: ${bad.join(', ')}`; return; }
    if (total() > MAX_ATTACH) { drawFiles(); return; }
    if (!f.subject.trim() && !confirmEmpty) { confirmEmpty = true; error.textContent = 'This message has no subject. Press Send again to send it anyway.'; return; }
    error.hidden = true; busy = true; clearTimeout(timer);
    win.classList.add('sending'); sendBtn.textContent = 'Sending…';
    try {
      const attachments = await Promise.all(files.map(async file => ({ filename: file.name, type: file.type || 'application/octet-stream', data: await readFile(file) })));
      const res = await call<{ thread_id: string }>('/send', { method: 'POST', body: JSON.stringify({
        ...f, ...(savedOnce ? { draftId: id } : {}), attachments,
        // Without the original's file list (a reopened draft), the server forwards every original attachment.
        ...(init.forwardOf && init.forwardFiles ? { keepAttachments: keep.filter(k => k.on).map(k => k.i) } : {}),
      }) });
      teardown();
      onSent(res.thread_id);
    } catch (e) {
      busy = false; win.classList.remove('sending'); sendBtn.textContent = 'Send';
      error.hidden = false; error.textContent = (e as Error).message;
    }
  }

  const teardown = () => { clearTimeout(timer); win.remove(); document.removeEventListener('keydown', keys, true); if (current === handle) current = null; };
  async function close(saveIt: boolean) {
    if (saveIt && dirty) { await save(); if (savedOnce) toast('Draft saved'); }
    teardown();
  }
  async function discard() {
    clearTimeout(timer); dirty = false;
    if (savedOnce) await call(`/drafts/${id}`, { method: 'DELETE' }).catch(() => {});
    teardown(); toast(savedOnce ? 'Draft discarded' : 'Message discarded');
  }

  const sendBtn = h('button', { type: 'button', class: 'btn-send', title: 'Send (Ctrl+Enter)', onclick: send }, 'Send');
  const ccBtn = h('button', { type: 'button', class: 'linkish', onclick: () => { ccRow.hidden = false; ccBtn.remove(); cc.input.focus(); } }, 'Cc Bcc');
  if (!ccRow.hidden) ccBtn.hidden = true;
  const win = h('div', { class: 'composer', role: 'dialog', 'aria-label': init.title ?? 'New message' },
    h('header', { class: 'cmp-head', onclick: (e: Event) => { if (!(e.target as Element).closest('button')) win.classList.toggle('min'); } },
      h('b', {}, init.title ?? 'New message'), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'ic', title: 'Minimise', onclick: () => win.classList.toggle('min') }, icon('min')),
      h('button', { type: 'button', class: 'ic hide-sm', title: 'Full screen', onclick: () => win.classList.toggle('max') }, icon('expand')),
      h('button', { type: 'button', class: 'ic', title: 'Save and close (Esc)', onclick: () => close(true) }, icon('close'))),
    h('div', { class: 'cmp-main' },
      ...(settings.sending ? [] : [h('p', { class: 'cmp-warn' }, 'Sending is not set up on your mail server yet. You can still write and save drafts.')]),
      ...(senders.length > 1 ? [h('div', { class: 'cmp-row' }, h('div', { class: 'rcpt' }, h('span', { class: 'rcpt-l' }, 'From'), from))] : []),
      h('div', { class: 'cmp-row' }, to.el, ccBtn),
      ccRow, subject, body, attachList, error),
    h('footer', { class: 'cmp-foot' }, sendBtn,
      h('button', { type: 'button', class: 'ic', title: 'Attach files', onclick: () => picker.click() }, icon('attach')), picker,
      status, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'ic', title: 'Discard draft', onclick: discard }, icon('trash'))));

  function keys(e: KeyboardEvent) {
    if (!win.contains(document.activeElement)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  }
  const handle = { close };
  current = handle;
  document.addEventListener('keydown', keys, true);
  document.body.append(win);
  drawFiles();
  (init.focusBody ? body : init.to?.length ? subject : to.input).focus();
  if (init.focusBody) body.setSelectionRange(0, 0);
}
