//! Port of `engine/log-mel.ts`: NeMo-style log-mel features for the
//! dictation model — preemphasis, a Hann window, power spectrum (radix-2
//! FFT), a triangular mel bank, log, then per-mel normalization over the
//! clip. Output is `[n_mels × frames]`, mel-major, the layout the model's
//! `audio_signal` input takes. (Originally from onnx-asr-web, MIT.)

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogMelOptions {
    pub sample_rate: u32,
    pub n_mels: usize,
    pub n_fft: usize,
    pub win_length: usize,
    pub hop_length: usize,
    pub preemphasis: f32,
}

pub const PARAKEET_FEATURES: LogMelOptions = LogMelOptions {
    sample_rate: 16_000,
    n_mels: 80,
    n_fft: 512,
    win_length: 400,
    hop_length: 160,
    preemphasis: 0.97,
};

#[derive(Debug, Clone)]
pub struct LogMel {
    pub features: Vec<f32>,
    pub frames: usize,
    pub n_mels: usize,
}

const LOG_EPS: f32 = 1e-10;

fn hz_to_mel(hz: f64) -> f64 {
    2595.0 * (1.0 + hz / 700.0).log10()
}
fn mel_to_hz(mel: f64) -> f64 {
    700.0 * (10f64.powf(mel / 2595.0) - 1.0)
}

fn hann_window(length: usize) -> Vec<f32> {
    (0..length)
        .map(|i| (0.5 - 0.5 * ((2.0 * std::f64::consts::PI * i as f64) / (length as f64 - 1.0)).cos()) as f32)
        .collect()
}

fn mel_filter_bank(o: &LogMelOptions) -> Vec<Vec<f32>> {
    let n_freqs = o.n_fft / 2 + 1;
    let mel_max = hz_to_mel(o.sample_rate as f64 / 2.0);
    let bins: Vec<usize> = (0..o.n_mels + 2)
        .map(|i| {
            (((o.n_fft + 1) as f64 * mel_to_hz(mel_max * i as f64 / (o.n_mels + 1) as f64)) / o.sample_rate as f64)
                .floor() as usize
        })
        .collect();
    (0..o.n_mels)
        .map(|m| {
            let mut filter = vec![0f32; n_freqs];
            let (left, center, right) = (bins[m], bins[m + 1], bins[m + 2]);
            for k in left..center.min(n_freqs) {
                filter[k] = (k - left) as f32 / (center - left) as f32;
            }
            for k in center..right.min(n_freqs) {
                filter[k] = (right - k) as f32 / (right - center) as f32;
            }
            filter
        })
        .collect()
}

/// In-place radix-2 FFT plan for one size: bit reversal plus twiddles.
pub struct Fft {
    n: usize,
    reversed: Vec<usize>,
    cos: Vec<f64>,
    sin: Vec<f64>,
    re: Vec<f64>,
    im: Vec<f64>,
}

pub fn create_fft(n: usize) -> anyhow::Result<Fft> {
    if n < 2 || !n.is_power_of_two() {
        anyhow::bail!("FFT size must be a power of two, got {n}");
    }
    let bits = n.trailing_zeros();
    let reversed = (0..n).map(|i| i.reverse_bits() >> (usize::BITS - bits)).collect();
    let cos = (0..n / 2).map(|i| ((2.0 * std::f64::consts::PI * i as f64) / n as f64).cos()).collect();
    let sin = (0..n / 2).map(|i| -((2.0 * std::f64::consts::PI * i as f64) / n as f64).sin()).collect();
    Ok(Fft { n, reversed, cos, sin, re: vec![0.0; n], im: vec![0.0; n] })
}

impl Fft {
    /// |X[k]|² for k in 0..=n/2 of a real frame.
    pub fn power_spectrum(&mut self, frame: &[f32]) -> Vec<f32> {
        let n = self.n;
        for i in 0..n {
            self.re[self.reversed[i]] = frame[i] as f64;
            self.im[self.reversed[i]] = 0.0;
        }
        let mut size = 2;
        while size <= n {
            let half = size >> 1;
            let step = n / size;
            let mut start = 0;
            while start < n {
                for j in 0..half {
                    let k = j * step;
                    let a = start + j;
                    let b = a + half;
                    let tr = self.re[b] * self.cos[k] - self.im[b] * self.sin[k];
                    let ti = self.re[b] * self.sin[k] + self.im[b] * self.cos[k];
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
                start += size;
            }
            size <<= 1;
        }
        (0..=n / 2).map(|k| (self.re[k] * self.re[k] + self.im[k] * self.im[k]) as f32).collect()
    }
}

/// Preemphasis, padded to at least one window.
fn preemphasize(input: &[f32], coefficient: f32, min_length: usize) -> Vec<f32> {
    let mut samples = vec![0f32; input.len().max(min_length)];
    samples[0] = input.first().copied().unwrap_or(0.0);
    for i in 1..input.len() {
        samples[i] = input[i] - coefficient * input[i - 1];
    }
    samples
}

/// Each mel row to zero mean and unit variance over the clip (NeMo's "per_feature").
fn normalize_per_mel(features: &mut [f32], n_mels: usize, frames: usize) {
    for m in 0..n_mels {
        let row = &mut features[m * frames..(m + 1) * frames];
        let mean = row.iter().map(|v| *v as f64).sum::<f64>() / frames as f64;
        let variance = row.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / frames as f64;
        let std = variance.sqrt() + 1e-5;
        for v in row.iter_mut() {
            *v = ((*v as f64 - mean) / std) as f32;
        }
    }
}

/// Builds the window, mel bank and FFT once; call [`LogMelExtractor::compute`] per clip.
pub struct LogMelExtractor {
    o: LogMelOptions,
    window: Vec<f32>,
    bank: Vec<Vec<f32>>,
    fft: Fft,
    frame: Vec<f32>,
}

pub fn create_log_mel(o: LogMelOptions) -> LogMelExtractor {
    LogMelExtractor {
        window: hann_window(o.win_length),
        bank: mel_filter_bank(&o),
        fft: create_fft(o.n_fft).expect("n_fft is a power of two"),
        frame: vec![0.0; o.n_fft],
        o,
    }
}

impl LogMelExtractor {
    pub fn compute(&mut self, input: &[f32]) -> LogMel {
        let o = self.o;
        let samples = preemphasize(input, o.preemphasis, o.win_length);
        let frames = 1 + (samples.len() - o.win_length) / o.hop_length;
        let mut features = vec![0f32; o.n_mels * frames];
        for t in 0..frames {
            let start = t * o.hop_length;
            self.frame.fill(0.0);
            for i in 0..o.win_length {
                self.frame[i] = samples[start + i] * self.window[i];
            }
            let spectrum = self.fft.power_spectrum(&self.frame);
            for m in 0..o.n_mels {
                let filter = &self.bank[m];
                let energy: f32 = spectrum.iter().zip(filter).map(|(s, f)| s * f).sum();
                features[m * frames + t] = energy.max(LOG_EPS).ln();
            }
        }
        normalize_per_mel(&mut features, o.n_mels, frames);
        LogMel { features, frames, n_mels: o.n_mels }
    }
}
