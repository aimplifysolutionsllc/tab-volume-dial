const ceiling = 10 ** (-1 / 20);

class PeakLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.previous = [];
    this.previousLimit = 1;
    this.gain = 1;
    this.reportFrames = 0;
    this.lowestGain = 1;
  }

  process([input], [output]) {
    const frames = output[0].length;
    if (this.previous[0]?.length !== frames) {
      this.previous = output.map(() => new Float32Array(frames));
      this.previousLimit = 1;
      this.gain = 1;
    }

    let peak = 0;
    for (const channel of input) {
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    }

    // Delay by one block so gain can ramp down before the next peak.
    // Cap both ends of the ramp for the delayed block and link stereo gain.
    const nextLimit = Math.min(1, ceiling / peak);
    const release = 1 - Math.exp(-frames / (sampleRate * 0.08));
    const start = this.gain;
    const end = Math.min(this.previousLimit, nextLimit, start + (1 - start) * release);
    for (let channel = 0; channel < output.length; channel++) {
      const delayed = this.previous[channel];
      const destination = output[channel];
      for (let frame = 0; frame < frames; frame++) {
        const gain = start + (end - start) * ((frame + 1) / frames);
        destination[frame] = delayed[frame] * gain;
      }

      if (input[channel]) delayed.set(input[channel]);
      else delayed.fill(0);
    }

    this.lowestGain = Math.min(this.lowestGain, start, end);
    this.reportFrames += frames;
    if (this.reportFrames >= sampleRate / 10) {
      this.port.postMessage({ reduction: -20 * Math.log10(this.lowestGain) });
      this.reportFrames = 0;
      this.lowestGain = 1;
    }

    this.gain = end;
    this.previousLimit = nextLimit;
    return true;
  }
}

registerProcessor("peak-limiter", PeakLimiter);
