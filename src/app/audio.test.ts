import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWav, wavProblem, checkSpeechText, toBase64, buildTranscriptionRequest, buildSpeechRequest,
  MAX_STT_BYTES, MAX_REFERENCE_BYTES, MAX_TTS_CHARS,
} from './audio.ts';

/** A minimal RIFF/WAVE blob of `size` bytes, header included. */
function wav(size = 44) {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WAVE'), 8);
  return b;
}

test('isWav accepts RIFF....WAVE and rejects other headers', () => {
  assert.equal(isWav(wav()), true);
  assert.equal(isWav(new TextEncoder().encode('RIFF\0\0\0\0AVI ')), false);
  assert.equal(isWav(new TextEncoder().encode('RIFF')), false);
  assert.equal(isWav(new Uint8Array(0)), false);
  assert.equal(isWav(new TextEncoder().encode('\x89PNG\r\n\x1a\n....')), false);
});

test('wavProblem rejects non-WAV and oversize input', () => {
  assert.equal(wavProblem(wav(), MAX_STT_BYTES), null);
  assert.match(wavProblem(new Uint8Array([1, 2, 3]), MAX_STT_BYTES) ?? '', /not a WAV file/);
  assert.match(wavProblem(wav(100), 50) ?? '', /limit/);
});

test('checkSpeechText trims and enforces the 1000 character cap', () => {
  assert.equal(checkSpeechText('   '), 'Enter some text.');
  assert.equal(checkSpeechText('  hi  '), null);
  assert.equal(checkSpeechText('a'.repeat(MAX_TTS_CHARS)), null);
  assert.notEqual(checkSpeechText('a'.repeat(MAX_TTS_CHARS + 1)), null);
});

test('toBase64 round-trips across the chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => (i * 31) & 0xff);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(bytes), 'base64')), bytes);
});

test('buildTranscriptionRequest sends base64 WAV and optional fields only when set', () => {
  const src = wav(64);
  const req = buildTranscriptionRequest(src);
  assert.deepEqual(Object.keys(req), ['audio_b64']);
  assert.deepEqual(new Uint8Array(Buffer.from(req.audio_b64, 'base64')), src);
  assert.deepEqual(buildTranscriptionRequest(src, { language: 'en', translate: true }),
    { audio_b64: req.audio_b64, language: 'en', translate: true });
});

test('buildTranscriptionRequest refuses non-WAV and files over 10 MiB', () => {
  assert.throws(() => buildTranscriptionRequest(new Uint8Array([0, 1, 2, 3])), RangeError);
  assert.throws(() => buildTranscriptionRequest(wav(MAX_STT_BYTES + 1)), RangeError);
});

test('buildSpeechRequest sends trimmed text without a voice reference', () => {
  assert.deepEqual(buildSpeechRequest({ input: '  Hello there.  ' }), { input: 'Hello there.' });
  assert.throws(() => buildSpeechRequest({ input: '' }), RangeError);
  assert.throws(() => buildSpeechRequest({ input: 'a'.repeat(MAX_TTS_CHARS + 1) }), RangeError);
});

test('voice reference without consent throws and sends nothing', () => {
  assert.throws(() => buildSpeechRequest({ input: 'Hi', voiceReference: wav() }), /consent/);
  assert.throws(() => buildSpeechRequest({ input: 'Hi', voiceReference: wav(), consent: false }), /consent/);
});

test('voice reference with consent is sent with consent:true', () => {
  const req = buildSpeechRequest({ input: 'Hi', voiceReference: wav(), consent: true });
  assert.equal(req.consent, true);
  assert.equal(typeof req.voice_reference_b64, 'string');
});

test('voice reference must be a WAV of at most 2 MiB', () => {
  assert.throws(() => buildSpeechRequest({ input: 'Hi', voiceReference: new Uint8Array([0, 0, 0, 0]), consent: true }), RangeError);
  assert.throws(() => buildSpeechRequest({ input: 'Hi', voiceReference: wav(MAX_REFERENCE_BYTES + 1), consent: true }), RangeError);
});
