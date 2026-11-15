const sessions = new Map();
const states = new Map();

const MODES = {
  standard: null,
  speech: { highpass: 100, presence: 3, makeup: 3,
    threshold: -28, ratio: 3, attack: 0.008, release: 0.18 },
  night: { highpass: 55, presence: 1, makeup: 5,
    threshold: -32, ratio: 6, attack: 0.003, release: 0.24 },
  music: null,
};

const LEVELERS = {
  gentle: { threshold: -30, ratio: 2.5, makeup: 3, attack: 0.012, release: 0.3 },
  strong: { threshold: -38, ratio: 7, makeup: 6, attack: 0.005, release: 0.32 },
};

function filter(context, type, frequency, gain = 0) {
  return new BiquadFilterNode(context, { type, frequency, gain, Q: 0.707 });
}

async function makeGraph(context, source) {
  await context.audioWorklet.addModule(chrome.runtime.getURL("peak-limiter.js"));
  const highpass = filter(context, "highpass", 20);
  const presence = filter(context, "peaking", 2600);
  const bass = filter(context, "lowshelf", 120);
  const lowMids = filter(context, "peaking", 350);
  const mids = filter(context, "peaking", 1000);
  const highMids = filter(context, "peaking", 2800);
  const treble = filter(context, "highshelf", 5000);
  const compressor = new DynamicsCompressorNode(context, { knee: 12 });
  const wet = new GainNode(context);
  const shapedBypass = new GainNode(context);
  const mix = new GainNode(context);
  const mono = new GainNode(context, { channelCount: 1, channelCountMode: "explicit" });
  const stereo = new GainNode(context);
  const channels = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
  const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const left = new GainNode(context);
  const right = new GainNode(context);
  const merge = new ChannelMergerNode(context, { numberOfInputs: 2 });
  const gain = new GainNode(context);
  const limiter = new AudioWorkletNode(context, "peak-limiter", {
    channelCount: 2,
    channelCountMode: "explicit",
    outputChannelCount: [2],
  });

  source.connect(bass).connect(lowMids).connect(mids).connect(highMids).connect(treble);
  treble.connect(highpass).connect(presence).connect(compressor).connect(wet).connect(mix);
  treble.connect(shapedBypass).connect(mix);
  mix.connect(stereo).connect(channels);
  mix.connect(mono).connect(channels);
  channels.connect(split);
  split.connect(left, 0).connect(merge, 0, 0);
  split.connect(right, 1).connect(merge, 0, 1);
  merge.connect(gain).connect(limiter).connect(context.destination);

  const input = connectMeters(context, source);
  const output = connectMeters(context, limiter);

  const graph = { input, output, highpass, presence, bass, lowMids, mids, highMids, treble,
    compressor, wet, shapedBypass, mono, stereo, left, right, gain,
    samples: new Float32Array(input[0].fftSize), reduction: 0 };
  limiter.port.onmessage = ({ data }) => { graph.reduction = data.reduction; };
  return graph;
}

function configure(session, settings, initial = false) {
  const { graph, context } = session;
  const mode = MODES[settings.mode];
  const dynamics = LEVELERS[settings.leveler] ?? mode;
  const set = (param, value) => {
    if (initial) param.value = value;
    else param.setTargetAtTime(value, context.currentTime, 0.015);
  };

  for (const band of Object.keys(FLAT_EQ)) set(graph[band].gain, settings[band]);
  set(graph.left.gain, 1 - Math.max(0, settings.balance / 100));
  set(graph.right.gain, 1 + Math.min(0, settings.balance / 100));
  set(graph.mono.gain, Number(settings.mono));
  set(graph.stereo.gain, Number(!settings.mono));
  set(graph.gain.gain, settings.volume / 100);
  set(graph.shapedBypass.gain, Number(!dynamics));
  set(graph.wet.gain, dynamics ? 10 ** (dynamics.makeup / 20) : 0);
  if (dynamics) {
    set(graph.highpass.frequency, mode?.highpass ?? 0);
    set(graph.presence.gain, mode?.presence ?? 0);
    for (const name of ["threshold", "ratio", "attack", "release"]) {
      set(graph.compressor[name], dynamics[name]);
    }
  }
}

function connectMeters(context, source) {
  const stereo = new GainNode(context, { channelCount: 2, channelCountMode: "explicit" });
  const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  source.connect(stereo).connect(split);
  return [0, 1].map((channel) => {
    const analyser = new AnalyserNode(context, { fftSize: 2048 });
    split.connect(analyser, channel);
    return analyser;
  });
}

function readLevel(analysers, samples) {
  let highestEnergy = 0;
  for (const analyser of analysers) {
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    highestEnergy = Math.max(highestEnergy, energy);
  }
  return Math.max(-60, 10 * Math.log10(highestEnergy / samples.length));
}

function meter(tabId) {
  const graph = sessions.get(tabId)?.graph;
  if (!graph) return null;
  return {
    input: readLevel(graph.input, graph.samples),
    output: readLevel(graph.output, graph.samples),
    reduction: graph.reduction,
  };
}

function getState(tabId) {
  return { ...(states.get(tabId) ?? defaultState()), active: sessions.has(tabId) };
}

function stop(tabId, session) {
  if (sessions.get(tabId) === session) sessions.delete(tabId);
  for (const track of session.stream.getTracks()) track.stop();
  if (session.context && session.context.state !== "closed") return session.context.close();
}

async function resume(context) {
  if (context.state === "running") return;
  let timeout;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Audio playback did not start.")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function start(tabId, settings, streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  const session = { stream };
  const track = stream.getAudioTracks()[0];

  try {
    if (!track || track.readyState !== "live") throw new Error("Tab audio ended.");
    const context = new AudioContext();
    session.context = context;
    session.graph = await makeGraph(context, context.createMediaStreamSource(stream));
    configure(session, settings, true);
    await resume(context);
    if (track.readyState !== "live") throw new Error("Tab audio ended.");

    sessions.set(tabId, session);
    track.addEventListener("ended", () => {
      states.delete(tabId);
      void stop(tabId, session).catch(console.warn);
    }, { once: true });
  } catch (error) {
    await stop(tabId, session);
    throw error;
  }
}

async function handle({ tabId, command, state, streamId }) {
  if (command === "get") return getState(tabId);
  if (command === "meter") return meter(tabId);

  const session = sessions.get(tabId);
  if (command === "remove") {
    states.delete(tabId);
    if (session) await stop(tabId, session);
    return null;
  }

  if (isNormal(state.settings)) {
    if (session) await stop(tabId, session);
  } else if (session) {
    configure(session, state.settings);
  } else {
    if (!streamId) throw new Error("Audio capture ended. Try again.");
    await start(tabId, state.settings, streamId);
  }

  states.set(tabId, state);
  return getState(tabId);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "audio") return;
  handle(message).then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
