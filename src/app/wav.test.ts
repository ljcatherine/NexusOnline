import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, MAX_SECONDS } from './wav.ts';

const ascii = (b: Uint8Array, off: number, len: number) => String.fromCharCode(...b.subarray(off, off + len));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

test('header fields for a short clip', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWav(samples, 16000);
  const v = view(wav);
  assert.equal(wav.length, 44 + 8);
  assert.equal(ascii(wav, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 8);
  assert.equal(ascii(wav, 8, 4), 'WAVE');
  assert.equal(ascii(wav, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);   // PCM
  assert.equal(v.getUint16(22, true), 1);   // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000); // byte rate
  assert.equal(v.getUint16(32, true), 2);   // block align
  assert.equal(v.getUint16(34, true), 16);  // bits
  assert.equal(ascii(wav, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 8);
});

test('samples are written as clamped little-endian int16', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2, NaN]), 8000);
  const v = view(wav);
  const s = (i: number) => v.getInt16(44 + i * 2, true);
  assert.equal(s(0), 0);
  assert.equal(s(1), Math.round(0.5 * 0x7fff));
  assert.equal(s(2), -0x4000);
  assert.equal(s(3), 0x7fff);
  assert.equal(s(4), -0x8000);
  assert.equal(s(5), 0x7fff);   // clamped from 2
  assert.equal(s(6), -0x8000);  // clamped from -2
  assert.equal(s(7), 0);        // NaN -> silence
});

test('clip longer than MAX_SECONDS is truncated', () => {
  assert.equal(MAX_SECONDS, 60);
  const rate = 100;
  const wav = encodeWav(new Float32Array(rate * 61), rate);
  assert.equal(view(wav).getUint32(40, true), rate * MAX_SECONDS * 2);
  assert.equal(wav.length, 44 + rate * MAX_SECONDS * 2);
});

test('empty input gives a valid header-only WAV', () => {
  const wav = encodeWav(new Float32Array(0), 16000);
  assert.equal(wav.length, 44);
  assert.equal(ascii(wav, 0, 4), 'RIFF');
  assert.equal(view(wav).getUint32(40, true), 0);
});

test('invalid sample rate throws', () => {
  assert.throws(() => encodeWav(new Float32Array(1), 0), RangeError);
  assert.throws(() => encodeWav(new Float32Array(1), 44.1), RangeError);
});
