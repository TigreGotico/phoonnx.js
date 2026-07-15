/**
 * Pure-JS signal-processing primitives for audio super-resolution.
 *
 * These are faithful ports of the host-side DSP that wraps the audiosronnx ONNX
 * graphs (the Python `audiosronnx` package): windowed-sinc (kaiser) resampling,
 * polyphase (scipy `resample_poly`) resampling, torch-faithful and scipy-faithful
 * STFT/ISTFT, a Slaney mel filterbank, and the LavaSR spectral merge.
 *
 * Everything works on `Float64Array` mono PCM in [-1, 1]. No `onnxruntime-web`
 * import lives here on purpose: the DSP is verifiable against the Python
 * reference with plain Node, independent of any ONNX runtime or browser.
 */

// --------------------------------------------------------------------------- //
// Complex FFT (radix-2 for powers of two, Bluestein for arbitrary lengths)
// --------------------------------------------------------------------------- //

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 Cooley-Tukey FFT. `n = re.length` must be a power of two. */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const aR = re[i + k], aI = im[i + k];
        const bR = re[i + k + len / 2], bI = im[i + k + len / 2];
        const tR = bR * curR - bI * curI;
        const tI = bR * curI + bI * curR;
        re[i + k] = aR + tR;
        im[i + k] = aI + tI;
        re[i + k + len / 2] = aR - tR;
        im[i + k + len / 2] = aI - tI;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nR;
      }
    }
  }
}

/** Forward complex FFT for arbitrary N (Bluestein wrapping the radix-2 core). */
function fftBluestein(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  const m = nextPow2(2 * n - 1);
  const sign = inverse ? 1 : -1;

  // chirp w[k] = exp(sign * i * pi * k^2 / n)
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // (k*k mod 2n) keeps the angle accurate for large k
    const j = (k * k) % (2 * n);
    const ang = (sign * Math.PI * j) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  const aR = new Float64Array(m);
  const aI = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    // a[k] = x[k] * conj(chirp[k])
    aR[k] = re[k] * cosT[k] + im[k] * sinT[k];
    aI[k] = -re[k] * sinT[k] + im[k] * cosT[k];
  }

  const bR = new Float64Array(m);
  const bI = new Float64Array(m);
  bR[0] = cosT[0];
  bI[0] = sinT[0];
  for (let k = 1; k < n; k++) {
    bR[k] = bR[m - k] = cosT[k];
    bI[k] = bI[m - k] = sinT[k];
  }

  fftRadix2(aR, aI, false);
  fftRadix2(bR, bI, false);
  for (let i = 0; i < m; i++) {
    const tR = aR[i] * bR[i] - aI[i] * bI[i];
    aI[i] = aR[i] * bI[i] + aI[i] * bR[i];
    aR[i] = tR;
  }
  fftRadix2(aR, aI, true);
  for (let i = 0; i < m; i++) { aR[i] /= m; aI[i] /= m; }

  for (let k = 0; k < n; k++) {
    // X[k] = conj(chirp[k]) * c[k]
    re[k] = aR[k] * cosT[k] + aI[k] * sinT[k];
    im[k] = -aR[k] * sinT[k] + aI[k] * cosT[k];
  }
}

/** In-place complex FFT (forward if `inverse` is false), any length N. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  if (re.length <= 1) return;
  if (isPow2(re.length)) fftRadix2(re, im, inverse);
  else fftBluestein(re, im, inverse);
}

/** Real FFT: returns the first `N/2+1` bins of `fft(x)`. */
export function rfft(x: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  fft(re, im, false);
  const half = (n >> 1) + 1;
  return { re: re.slice(0, half), im: im.slice(0, half) };
}

/** Inverse real FFT: `re`/`im` are `N/2+1` bins; returns the length-`n` real signal. */
export function irfft(re: Float64Array, im: Float64Array, n: number): Float64Array {
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  const half = (n >> 1) + 1;
  for (let k = 0; k < half; k++) { fr[k] = re[k]; fi[k] = im[k]; }
  for (let k = 1; k < n - half + 1; k++) {
    fr[n - k] = re[k];
    fi[n - k] = -im[k];
  }
  fft(fr, fi, true);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fr[i] / n;
  return out;
}

export function rfftFreqs(n: number, sr: number): Float64Array {
  const half = (n >> 1) + 1;
  const f = new Float64Array(half);
  for (let k = 0; k < half; k++) f[k] = (k * sr) / n;
  return f;
}

// --------------------------------------------------------------------------- //
// Windows and the modified Bessel function i0 (for kaiser windows)
// --------------------------------------------------------------------------- //

/** Modified Bessel function of the first kind, order 0 (matches numpy.i0). */
export function i0(x: number): number {
  const ax = Math.abs(x);
  let sum = 1.0;
  let term = 1.0;
  const y = (x * x) / 4.0;
  let k = 1;
  // series until the term is negligible; converges quickly for the |x| we use
  while (true) {
    term *= y / (k * k);
    sum += term;
    if (term < sum * 1e-18 || k > 200) break;
    k++;
  }
  return ax === 0 ? 1.0 : sum;
}

/** Symmetric kaiser window of length `n` (scipy get_window(('kaiser', beta), n)). */
function kaiserWindow(n: number, beta: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  const alpha = (n - 1) / 2;
  const denom = i0(beta);
  for (let i = 0; i < n; i++) {
    const r = (i - alpha) / alpha;
    w[i] = i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
  }
  return w;
}

/** Periodic Hann window of length `n` (torch.hann_window / scipy hann sym=False). */
function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

function normalizedSinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

// --------------------------------------------------------------------------- //
// Resampling — torchaudio-faithful windowed-sinc (kaiser)
// --------------------------------------------------------------------------- //

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/**
 * Windowed-sinc resample matching torchaudio's `sinc_interp_kaiser`
 * (`audiosronnx._kaiser.kaiser_resample`). Used by the hifiganbwe and apbwe
 * engines, whose ONNX graphs were trained on exactly this front-end.
 */
export function kaiserResample(
  x: Float64Array,
  origSr: number,
  newSr: number,
  lowpassFilterWidth = 16,
  rolloff = 0.945,
  beta = 14.769656459379492,
): Float64Array {
  if (origSr === newSr || x.length === 0) return Float64Array.from(x);
  const g = gcd(origSr, newSr);
  const origFreq = Math.floor(origSr / g);
  const newFreq = Math.floor(newSr / g);
  const baseFreq = Math.min(origFreq, newFreq) * rolloff;
  const width = Math.ceil((lowpassFilterWidth * origFreq) / baseFreq);

  // kernel[c][k]: for output phase c (0..newFreq-1), tap k (0..2*width+origFreq-1)
  const K = 2 * width + origFreq;
  const kernels: Float64Array[] = [];
  const scale = baseFreq / origFreq;
  for (let c = 0; c < newFreq; c++) {
    const row = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const idx = (k - width) / origFreq;
      let t = (-c / newFreq + idx) * baseFreq;
      t = Math.min(lowpassFilterWidth, Math.max(-lowpassFilterWidth, t));
      const win = i0(beta * Math.sqrt(Math.max(0, 1 - (t / lowpassFilterWidth) ** 2))) / i0(beta);
      const tp = t * Math.PI;
      const sinc = tp === 0 ? 1.0 : Math.sin(tp) / tp;
      row[k] = sinc * win * scale;
    }
    kernels.push(row);
  }

  const length = x.length;
  const padded = new Float64Array(width + length + width + origFreq);
  padded.set(x, width);

  const nFrames = Math.floor((padded.length - K) / origFreq) + 1;
  const out = new Float64Array(nFrames * newFreq);
  for (let f = 0; f < nFrames; f++) {
    const base = f * origFreq;
    for (let c = 0; c < newFreq; c++) {
      const row = kernels[c];
      let acc = 0;
      for (let k = 0; k < K; k++) acc += padded[base + k] * row[k];
      out[f * newFreq + c] = acc;
    }
  }
  const targetLen = Math.ceil((newFreq * length) / origFreq);
  return out.slice(0, targetLen);
}

// --------------------------------------------------------------------------- //
// Resampling — scipy resample_poly (polyphase FIR)
// --------------------------------------------------------------------------- //

/** scipy firwin(numtaps, cutoff, window=('kaiser', beta)) — lowpass, scaled to unity DC gain. */
function firwinKaiserLowpass(numtaps: number, cutoff: number, beta: number): Float64Array {
  const alpha = 0.5 * (numtaps - 1);
  const win = kaiserWindow(numtaps, beta);
  const h = new Float64Array(numtaps);
  let s = 0;
  for (let i = 0; i < numtaps; i++) {
    const m = i - alpha;
    h[i] = cutoff * normalizedSinc(cutoff * m) * win[i];
    s += h[i]; // scale frequency is 0 (DC) for a pass_zero lowpass -> cos term = 1
  }
  for (let i = 0; i < numtaps; i++) h[i] /= s;
  return h;
}

function upfirdnOutputLen(lenH: number, inLen: number, up: number, down: number): number {
  return Math.floor(((inLen - 1) * up + lenH - 1) / down) + 1;
}

/**
 * Polyphase upsample-filter-downsample (scipy.signal.upfirdn, mode='constant', cval=0).
 * `x` is upsampled by `up`, convolved with `h`, downsampled by `down`.
 */
function upfirdn(h: Float64Array, x: Float64Array, up: number, down: number): Float64Array {
  const inLen = x.length;
  const lenH = h.length;
  const outLen = upfirdnOutputLen(lenH, inLen, up, down);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = i * down;
    const xIdx = Math.floor(t / up);
    const hOffset = t % up; // t - xIdx*up
    let acc = 0;
    // y[i] = sum_k h[hOffset + up*k] * x[xIdx - k]
    let hj = hOffset;
    let xk = xIdx;
    while (hj < lenH && xk >= 0) {
      if (xk < inLen) acc += h[hj] * x[xk];
      hj += up;
      xk -= 1;
    }
    out[i] = acc;
  }
  return out;
}

/**
 * scipy.signal.resample_poly(x, up, down) with the default kaiser(5.0) FIR and
 * padtype='constant'. Faithful port including the pre/post filter padding and the
 * output trimming, so the first output sample aligns with the first input sample.
 * Used by the lavasr (16k<->44.1k<->48k) and novasr (->16k) engines.
 */
export function resamplePoly(x: Float64Array, up: number, down: number): Float64Array {
  const g = gcd(up, down);
  up = Math.floor(up / g);
  down = Math.floor(down / g);
  if (up === 1 && down === 1) return Float64Array.from(x);

  const nIn = x.length;
  let nOut = nIn * up;
  nOut = Math.floor(nOut / down) + (nOut % down ? 1 : 0);

  const maxRate = Math.max(up, down);
  const fC = 1 / maxRate;
  const halfLen = 10 * maxRate;
  let h = firwinKaiserLowpass(2 * halfLen + 1, fC, 5.0);
  const scaled = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) scaled[i] = h[i] * up;
  h = scaled;

  const nPrePad = down - (halfLen % down);
  let nPostPad = 0;
  const nPreRemove = Math.floor((halfLen + nPrePad) / down);
  while (upfirdnOutputLen(h.length + nPrePad + nPostPad, nIn, up, down) < nOut + nPreRemove) {
    nPostPad += 1;
  }
  const hp = new Float64Array(nPrePad + h.length + nPostPad);
  hp.set(h, nPrePad);

  const y = upfirdn(hp, x, up, down);
  return y.slice(nPreRemove, nPreRemove + nOut);
}

/** Resample by sample rate (chooses up/down from the gcd), scipy-poly faithful. */
export function resample(x: Float64Array, srcSr: number, dstSr: number): Float64Array {
  if (srcSr === dstSr || x.length === 0) return Float64Array.from(x);
  const g = gcd(srcSr, dstSr);
  return resamplePoly(x, Math.floor(dstSr / g), Math.floor(srcSr / g));
}

// --------------------------------------------------------------------------- //
// STFT / ISTFT — scipy-faithful (LavaSR) and torch-faithful (AP-BWE)
// --------------------------------------------------------------------------- //

function reflectPad(x: Float64Array, pad: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) out[i] = x[pad - i];           // reflect (no edge repeat)
  out.set(x, pad);
  for (let i = 0; i < pad; i++) out[pad + n + i] = x[n - 2 - i];
  return out;
}

export interface Spectrogram {
  re: Float64Array; // [nFreq * nFrames], row-major (freq-major)
  im: Float64Array;
  nFreq: number;
  nFrames: number;
}

/**
 * torch.stft-faithful complex STFT (`audiosronnx._stft.stft`). A `winSize` Hann
 * window is centred in an `nFft` frame, centre reflect padding, one-sided output.
 * Returns freq-major `[nFreq, nFrames]`.
 */
export function torchStft(
  audio: Float64Array, nFft: number, hop: number, winSize: number, center = true,
): Spectrogram {
  const win = paddedHann(winSize, nFft);
  let x = audio;
  if (center) x = reflectPad(audio, nFft >> 1);
  const nFrames = 1 + Math.floor((x.length - nFft) / hop);
  const nFreq = (nFft >> 1) + 1;
  const re = new Float64Array(nFreq * nFrames);
  const im = new Float64Array(nFreq * nFrames);
  const frame = new Float64Array(nFft);
  for (let t = 0; t < nFrames; t++) {
    const s = t * hop;
    for (let i = 0; i < nFft; i++) frame[i] = x[s + i] * win[i];
    const spec = rfft(frame);
    for (let f = 0; f < nFreq; f++) {
      re[f * nFrames + t] = spec.re[f];
      im[f * nFrames + t] = spec.im[f];
    }
  }
  return { re, im, nFreq, nFrames };
}

function paddedHann(winLength: number, nFft: number): Float64Array {
  const win = hannPeriodic(winLength);
  if (winLength === nFft) return win;
  const out = new Float64Array(nFft);
  out.set(win, (nFft - winLength) >> 1);
  return out;
}

/** Inverse of {@link torchStft} (`audiosronnx._stft.istft`), window-envelope normalised. */
export function torchIstft(
  spec: Spectrogram, nFft: number, hop: number, winSize: number,
  center = true, length: number | null = null,
): Float64Array {
  const win = paddedHann(winSize, nFft);
  const { nFrames } = spec;
  const outLen = nFft + hop * (nFrames - 1);
  const ola = new Float64Array(outLen);
  const winSq = new Float64Array(outLen);
  const w2 = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) w2[i] = win[i] * win[i];
  const colRe = new Float64Array(spec.nFreq);
  const colIm = new Float64Array(spec.nFreq);
  for (let t = 0; t < nFrames; t++) {
    for (let f = 0; f < spec.nFreq; f++) {
      colRe[f] = spec.re[f * nFrames + t];
      colIm[f] = spec.im[f * nFrames + t];
    }
    const frame = irfft(colRe, colIm, nFft);
    const s = t * hop;
    for (let i = 0; i < nFft; i++) {
      ola[s + i] += frame[i] * win[i];
      winSq[s + i] += w2[i];
    }
  }
  for (let i = 0; i < outLen; i++) ola[i] /= winSq[i] > 1e-11 ? winSq[i] : 1;
  let out: Float64Array = ola;
  if (center) out = out.slice(nFft >> 1, out.length - (nFft >> 1));
  if (length != null) out = fitLength(out, length);
  return out;
}

function fitLength(x: Float64Array, length: number): Float64Array {
  if (x.length === length) return x;
  if (x.length > length) return x.slice(0, length);
  const out = new Float64Array(length);
  out.set(x);
  return out;
}

/**
 * scipy.signal.stft-faithful STFT with boundary='zeros', padded=True, one-sided,
 * spectrum scaling (each frame divided by win.sum()). Used by LavaSR. Returns
 * freq-major `[nFreq, nFrames]`.
 */
export function scipyStft(wave: Float64Array, nFft: number, hop: number): Spectrogram {
  const nperseg = nFft;
  const nstep = hop;
  const win = hannPeriodic(nperseg);
  let winSum = 0;
  for (let i = 0; i < nperseg; i++) winSum += win[i];

  // boundary='zeros' -> pad nperseg//2 zeros each side
  const bpad = nperseg >> 1;
  let x = new Float64Array(wave.length + 2 * bpad);
  x.set(wave, bpad);
  // padded=True -> append zeros so the last frame is full
  const nadd = mod(-(x.length - nperseg), nstep);
  if (nadd) {
    const ext = new Float64Array(x.length + nadd);
    ext.set(x);
    x = ext;
  }
  const nFrames = 1 + Math.floor((x.length - nperseg) / nstep);
  const nFreq = (nFft >> 1) + 1;
  const re = new Float64Array(nFreq * nFrames);
  const im = new Float64Array(nFreq * nFrames);
  const frame = new Float64Array(nFft);
  const invSum = 1 / winSum;
  for (let t = 0; t < nFrames; t++) {
    const s = t * nstep;
    for (let i = 0; i < nFft; i++) frame[i] = x[s + i] * win[i];
    const spec = rfft(frame);
    for (let f = 0; f < nFreq; f++) {
      re[f * nFrames + t] = spec.re[f] * invSum;
      im[f * nFrames + t] = spec.im[f] * invSum;
    }
  }
  return { re, im, nFreq, nFrames };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** scipy.signal.istft-faithful inverse of {@link scipyStft} (boundary=True). */
export function scipyIstft(spec: Spectrogram, nFft: number, hop: number): Float64Array {
  const nperseg = nFft;
  const nstep = hop;
  const win = hannPeriodic(nperseg);
  let winSum = 0;
  for (let i = 0; i < nperseg; i++) winSum += win[i];
  const { nFrames } = spec;
  const outLen = nperseg + (nFrames - 1) * nstep;
  const x = new Float64Array(outLen);
  const norm = new Float64Array(outLen);
  const colRe = new Float64Array(spec.nFreq);
  const colIm = new Float64Array(spec.nFreq);
  for (let t = 0; t < nFrames; t++) {
    for (let f = 0; f < spec.nFreq; f++) {
      colRe[f] = spec.re[f * nFrames + t];
      colIm[f] = spec.im[f * nFrames + t];
    }
    const frame = irfft(colRe, colIm, nFft);
    const s = t * nstep;
    for (let i = 0; i < nperseg; i++) {
      x[s + i] += frame[i] * winSum * win[i]; // scaling='spectrum' -> xsubs *= win.sum()
      norm[s + i] += win[i] * win[i];
    }
  }
  // boundary=True -> trim nperseg//2 each side
  const bpad = nperseg >> 1;
  const out = new Float64Array(outLen - 2 * bpad);
  for (let i = 0; i < out.length; i++) {
    const n = norm[i + bpad];
    out[i] = x[i + bpad] / (n > 1e-10 ? n : 1);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Mel filterbank (Slaney) and LavaSR spectral merge
// --------------------------------------------------------------------------- //

function hzToMel(f: number): number {
  const fSp = 200.0 / 3.0;
  const minLogHz = 1000.0;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27.0;
  return f < minLogHz ? f / fSp : minLogMel + Math.log(f / minLogHz) / logstep;
}

function melToHz(mel: number): number {
  const fSp = 200.0 / 3.0;
  const minLogHz = 1000.0;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27.0;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logstep * (mel - minLogMel));
}

/**
 * Slaney-style mel filterbank matching `audiosronnx.engines.lavasr._build_mel_filterbank`.
 * Returns row-major `[nMels, nFft/2+1]`.
 */
export function buildMelFilterbank(
  sr: number, nFft: number, nMels: number, fmin: number, fmax: number,
): Float64Array {
  const nFreq = (nFft >> 1) + 1;
  const fftFreqs = new Float64Array(nFreq);
  for (let k = 0; k < nFreq; k++) fftFreqs[k] = (k * (sr / 2)) / (nFreq - 1);
  const melMin = hzToMel(fmin);
  const melMax = hzToMel(fmax);
  const hzEdges = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    hzEdges[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }
  const fb = new Float64Array(nMels * nFreq);
  for (let m = 0; m < nMels; m++) {
    const left = hzEdges[m];
    const center = hzEdges[m + 1];
    const right = hzEdges[m + 2];
    if (center <= left || right <= center) continue;
    const gain = 2.0 / Math.max(1e-8, right - left);
    for (let k = 0; k < nFreq; k++) {
      const up = (fftFreqs[k] - left) / (center - left);
      const down = (right - fftFreqs[k]) / (right - center);
      fb[m * nFreq + k] = Math.max(0, Math.min(up, down)) * gain;
    }
  }
  return fb;
}

/**
 * LavaSR spectral merge (`_spectral_merge`): keep the original signal below
 * `cutoffHz`, the enhanced signal above, with a smoothstep transition. Full-length
 * rFFT of both, blend, inverse. Returns a length-`min(len)` real signal.
 */
export function spectralMerge(
  original: Float64Array, enhanced: Float64Array, sr: number,
  cutoffHz: number, transitionBins: number,
): Float64Array {
  const n = Math.min(original.length, enhanced.length);
  if (n <= 0) return Float64Array.from(enhanced);
  const o = original.slice(0, n);
  const e = enhanced.slice(0, n);
  const so = rfft(o);
  const se = rfft(e);
  const freqs = rfftFreqs(n, sr);
  // cutoff_bin = argmin |freqs - cutoff|
  let cutoffBin = 0;
  let best = Infinity;
  for (let k = 0; k < freqs.length; k++) {
    const d = Math.abs(freqs[k] - cutoffHz);
    if (d < best) { best = d; cutoffBin = k; }
  }
  const half = Math.max(1, transitionBins >> 1);
  const start = Math.max(0, cutoffBin - half);
  const end = Math.min(so.re.length - 1, cutoffBin + half);
  const mask = new Float64Array(so.re.length);
  for (let k = 0; k < start; k++) mask[k] = 1.0;
  if (end > start) {
    const steps = end - start;
    for (let i = 0; i <= steps; i++) {
      const tt = 1.0 - i / steps; // linspace(1,0,end-start+1)
      mask[start + i] = 3.0 * tt * tt - 2.0 * tt * tt * tt;
    }
  }
  const mRe = new Float64Array(so.re.length);
  const mIm = new Float64Array(so.im.length);
  for (let k = 0; k < mRe.length; k++) {
    mRe[k] = se.re[k] + (so.re[k] - se.re[k]) * mask[k];
    mIm[k] = se.im[k] + (so.im[k] - se.im[k]) * mask[k];
  }
  return irfft(mRe, mIm, n);
}
