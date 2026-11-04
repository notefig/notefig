//! The desktop microphone on cpal — the native counterpart of the TS
//! `openBrowserMicrophone`. Capture runs at the device's own rate on cpal's
//! audio thread, which only downmixes to mono and hands the frames over a
//! channel; a task on the executor (the main thread) resamples them to
//! 16 kHz and calls the listeners. The macOS app needs
//! `NSMicrophoneUsageDescription` for the system prompt to appear.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt, Listeners, Subscription};

use crate::microphone::{Microphone, OpenMicrophone, TARGET_RATE, create_resampler};

/// Audio arrives every ~10–40 ms while it runs; this long without is stopped.
const QUIET: Duration = Duration::from_millis(500);

struct NativeMicrophone {
    stream: RefCell<Option<cpal::Stream>>,
    listeners: Listeners<Vec<f32>>,
    /// Set by the stream's error callback.
    failed: Arc<AtomicBool>,
    /// Millis since `epoch` of the last batch, written on the audio thread.
    heard_at: Arc<AtomicU64>,
    epoch: Instant,
    /// Batches sent but not yet delivered on the main thread.
    in_flight: Arc<AtomicU64>,
    closed: Cell<bool>,
    executor: Rc<dyn Executor>,
}

impl Microphone for NativeMicrophone {
    fn on_audio(&self, listener: Box<dyn Fn(&[f32])>) -> Subscription {
        self.listeners.subscribe(move |samples: &Vec<f32>| listener(samples.as_slice()))
    }

    fn flush(&self) -> LocalBoxFuture<'static, ()> {
        let (in_flight, executor) = (self.in_flight.clone(), self.executor.clone());
        async move {
            while in_flight.load(Ordering::Acquire) > 0 {
                executor.timer(Duration::from_millis(5)).await;
            }
        }
        .boxed_local()
    }

    fn live(&self) -> bool {
        let since = self.epoch.elapsed().as_millis() as u64 - self.heard_at.load(Ordering::Relaxed);
        !self.closed.get() && !self.failed.load(Ordering::Relaxed) && since < QUIET.as_millis() as u64
    }

    fn close(&self) {
        self.closed.set(true);
        // Dropping the stream stops capture and releases the device.
        self.stream.borrow_mut().take();
    }
}

fn open(executor: Rc<dyn Executor>) -> anyhow::Result<Rc<dyn Microphone>> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| anyhow!("No microphone is connected."))?;
    let supported = device.default_input_config().context("The microphone can't be opened")?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels.max(1) as usize;
    let rate = config.sample_rate.0;

    let (tx, rx) = async_channel::unbounded::<Vec<f32>>();
    let failed = Arc::new(AtomicBool::new(false));
    let epoch = Instant::now();
    let heard_at = Arc::new(AtomicU64::new(0));
    let in_flight = Arc::new(AtomicU64::new(0));

    let mono = {
        let (heard_at, in_flight) = (heard_at.clone(), in_flight.clone());
        move |frame: Vec<f32>| {
            heard_at.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
            in_flight.fetch_add(1, Ordering::AcqRel);
            if tx.try_send(frame).is_err() {
                in_flight.fetch_sub(1, Ordering::AcqRel);
            }
        }
    };
    let on_error = {
        let failed = failed.clone();
        move |err: cpal::StreamError| {
            log::warn!("dictation: microphone stream failed: {err}");
            failed.store(true, Ordering::Relaxed);
        }
    };
    fn downmix<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
        data.chunks(channels)
            .map(|frame| frame.iter().map(|s| to_f32(*s)).sum::<f32>() / frame.len() as f32)
            .collect()
    }
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _: &_| mono(downmix(data, channels, |s| s)),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _: &_| mono(downmix(data, channels, |s| s as f32 / 32768.0)),
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _: &_| mono(downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0)),
            on_error,
            None,
        ),
        other => return Err(anyhow!("The microphone's sample format ({other:?}) isn't supported.")),
    }
    .context("The microphone can't be opened")?;
    stream.play().context("The microphone can't start")?;

    let mic = Rc::new(NativeMicrophone {
        stream: RefCell::new(Some(stream)),
        listeners: Listeners::new(),
        failed,
        heard_at,
        epoch,
        in_flight: in_flight.clone(),
        closed: Cell::new(false),
        executor: executor.clone(),
    });
    // Deliver on the main thread until the mic closes (its sender drops with
    // the stream, ending the channel).
    let weak = Rc::downgrade(&mic);
    executor.spawn_local(async move {
        let mut resample = create_resampler(rate, TARGET_RATE);
        while let Ok(frame) = rx.recv().await {
            in_flight.fetch_sub(1, Ordering::AcqRel);
            let Some(mic) = weak.upgrade() else { break };
            if mic.closed.get() {
                continue;
            }
            let samples = resample.resample(&frame);
            if !samples.is_empty() {
                mic.listeners.notify(&samples);
            }
        }
    });
    Ok(mic)
}

/// `OpenMicrophone` for the desktop's default input device.
pub fn native_microphone(executor: Rc<dyn Executor>) -> OpenMicrophone {
    Rc::new(move || {
        let result = open(executor.clone());
        futures::future::ready(result).boxed_local()
    })
}
