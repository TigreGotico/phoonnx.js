/** Encode mono float32 [-1, 1] PCM samples to a 16-bit PCM WAV Blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);   // chunk size
  v.setUint16(20, 1, true);    // PCM
  v.setUint16(22, 1, true);    // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);    // block align
  v.setUint16(34, 16, true);   // bits per sample
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Reconstruct per-phoneme alignments from the model's second output tensor.
 *
 * The model duration output contains one float per input token (including
 * bos/eos/blanks). This function folds special-token durations into adjacent
 * real-phoneme buckets so callers get one entry per content phoneme.
 *
 * @param ids          Token id sequence as passed to the model.
 * @param rawDurations Duration tensor from model output (frames per token).
 * @param hopLength    Frames → samples multiplier (typically 256).
 * @param idxToChar    Reverse-lookup map: token id → character string.
 * @param blankId      Id of the blank/pad token (duration absorbed forward).
 * @param bosId        Id of the BOS token (duration absorbed forward).
 * @param eosId        Id of the EOS token (duration absorbed into last phoneme).
 */
export function reconstructAlignments(
  ids: number[],
  rawDurations: Float32Array,
  hopLength: number,
  idxToChar: Map<number, string>,
  blankId: number,
  bosId: number,
  eosId: number,
): Array<{ phoneme: string; numSamples: number }> | null {
  if (rawDurations.length !== ids.length) return null;

  const result: Array<{ phoneme: string; numSamples: number }> = [];
  let pending = 0;

  for (let i = 0; i < ids.length; i++) {
    const pid = ids[i];
    const nSamples = Math.round(rawDurations[i] * hopLength);
    if (pid === bosId || pid === blankId) {
      pending += nSamples;
    } else if (pid === eosId) {
      if (result.length > 0) {
        result[result.length - 1].numSamples += nSamples;
      }
    } else {
      const phoneme = idxToChar.get(pid) ?? "?";
      result.push({ phoneme, numSamples: pending + nSamples });
      pending = 0;
    }
  }
  if (pending > 0 && result.length > 0) {
    result[result.length - 1].numSamples += pending;
  }
  return result.length > 0 ? result : null;
}
