/** Longest clip the encoder keeps; anything past this is truncated. */
export const MAX_SECONDS = 60;

/**
 * Encodes mono Float32 samples (-1..1) as a 16-bit PCM WAV file.
 * Out-of-range and NaN samples are clamped to -1..1 / 0. Input longer than MAX_SECONDS is truncated.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`bad sampleRate: ${sampleRate}`);
  const n = Math.min(samples.length, MAX_SECONDS * sampleRate);
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, dataBytes, true);

  for (let i = 0; i < n; i++) {
    const x = samples[i];
    const s = x > 1 ? 1 : x < -1 ? -1 : x || 0;
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}
