// --- Audio graph & state ---

let audioCtx;
let isPlaying = false;
let currentStep = 0;
let timerId = null;

const stepsCount = 16;

const pattern = {
  kick: new Array(stepsCount).fill(false),
  snare: new Array(stepsCount).fill(false),
  hihat: new Array(stepsCount).fill(false),
};

let masterGain, masterLimiter;
let reverbInput, reverbOutput, reverbMixGain;
let drumsBus, drumsPanNode, drumsVerbSend, drumsMeterNode;
let synthBus, synthPanNode, synthVerbSend, synthMeterNode;
let noiseSource, noiseGain, noiseGateThreshold = -40;

let analyser, oscAnalyser;
let spectrumCanvas, spectrumCtx;
let oscCanvas, oscCtx;

let filterCutoff = 2000;
let filterRes = 1.2;
let envAttack = 0.01;
let envDecay = 0.4;
let noiseLevel = 0.15;

// --- Init audio ---

function initAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.9;

  masterLimiter = audioCtx.createDynamicsCompressor();
  masterLimiter.threshold.value = -3;
  masterLimiter.knee.value = 10;
  masterLimiter.ratio.value = 12;
  masterLimiter.attack.value = 0.003;
  masterLimiter.release.value = 0.25;

  // Simple feedback delay as "reverb"
  const delay = audioCtx.createDelay(3.0);
  const feedback = audioCtx.createGain();
  reverbMixGain = audioCtx.createGain();
  reverbMixGain.gain.value = 0.4;

  delay.delayTime.value = 0.25;
  feedback.gain.value = 0.4;

  reverbInput = audioCtx.createGain();
  reverbOutput = audioCtx.createGain();

  reverbInput.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(reverbOutput);

  reverbOutput.connect(reverbMixGain);

  // Drums bus
  drumsBus = audioCtx.createGain();
  drumsPanNode = audioCtx.createStereoPanner();
  drumsVerbSend = audioCtx.createGain();
  drumsMeterNode = createMeterNode();

  drumsBus.connect(drumsPanNode);
  drumsPanNode.connect(drumsMeterNode);
  drumsMeterNode.connect(masterGain);
  drumsBus.connect(drumsVerbSend);
  drumsVerbSend.connect(reverbInput);

  // Synth bus
  synthBus = audioCtx.createGain();
  synthPanNode = audioCtx.createStereoPanner();
  synthVerbSend = audioCtx.createGain();
  synthMeterNode = createMeterNode();

  synthBus.connect(synthPanNode);
  synthPanNode.connect(synthMeterNode);
  synthMeterNode.connect(masterGain);
  synthBus.connect(synthVerbSend);
  synthVerbSend.connect(reverbInput);

  // Noise bed (for noise gate / damp)
  noiseSource = audioCtx.createBufferSource();
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = noiseLevel;

  noiseSource.connect(noiseGain);
  noiseGain.connect(masterGain);
  noiseSource.start();

  // Analyser for spectrum + oscilloscope
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  oscAnalyser = audioCtx.createAnalyser();
  oscAnalyser.fftSize = 2048;

  masterGain.connect(analyser);
  masterGain.connect(oscAnalyser);
  reverbMixGain.connect(masterGain);
  masterGain.connect(masterLimiter);
  masterLimiter.connect(audioCtx.destination);

  // Visualizers
  setupVisualizers();
  drawSpectrum();
  drawOscilloscope();
}

// --- Meter node (simple RMS approximation) ---

function createMeterNode() {
  const meter = audioCtx.createScriptProcessor(256, 1, 1);
  meter.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    const rms = Math.sqrt(sum / input.length);
    const db = 20 * Math.log10(rms + 1e-6);
    updateMeters(meter, db);
  };
  return meter;
}

function updateMeters(node, db) {
  const norm = Math.min(1, Math.max(0, (db + 60) / 60));
  if (node === drumsMeterNode) {
    setMeterHeight("drums", norm);
  } else if (node === synthMeterNode) {
    setMeterHeight("synth", norm);
  }
  // master meter is updated from analyser in drawSpectrum
}

function setMeterHeight(name, value) {
  const meter = document.querySelector(`.meter[data-meter="${name}"] .meter-bar`);
  if (meter) {
    meter.style.height = `${value * 100}%`;
  }
}

// --- Drum synths ---

function playKick(time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(120, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.2);

  gain.gain.setValueAtTime(1, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

  osc.connect(gain);
  gain.connect(drumsBus);

  osc.start(time);
  osc.stop(time + 0.3);
}

function playSnare(time) {
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = 1800;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.8, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

  noise.connect(noiseFilter);
  noiseFilter.connect(gain);
  gain.connect(drumsBus);

  noise.start(time);
  noise.stop(time + 0.2);
}

function playHiHat(time) {
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.05, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = "highpass";
  noiseFilter.frequency.value = 6000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

  noise.connect(noiseFilter);
  noiseFilter.connect(gain);
  gain.connect(drumsBus);

  noise.start(time);
  noise.stop(time + 0.05);
}

// --- Sequencer timing ---

function scheduleStep(stepIndex, time) {
  if (pattern.kick[stepIndex]) playKick(time);
  if (pattern.snare[stepIndex]) playSnare(time);
  if (pattern.hihat[stepIndex]) playHiHat(time);
}

function tick() {
  if (!audioCtx) return;
  const bpm = parseFloat(document.getElementById("bpmInput").value) || 120;
  const secondsPerBeat = 60 / bpm;
  const stepDuration = secondsPerBeat / 4;

  const now = audioCtx.currentTime;
  const time = now + 0.05;

  scheduleStep(currentStep, time);
  highlightStep(currentStep);
  flashClockLED();

  currentStep = (currentStep + 1) % stepsCount;
  timerId = setTimeout(tick, stepDuration * 1000);
}

function highlightStep(stepIndex) {
  document.querySelectorAll(".seq-step").forEach((el) => el.classList.remove("playing"));
  document
    .querySelectorAll(`.seq-step[data-step="${stepIndex}"]`)
    .forEach((el) => el.classList.add("playing"));
}

function flashClockLED() {
  const led = document.getElementById("ledClock");
  led.classList.add("active");
  setTimeout(() => led.classList.remove("active"), 80);
}

// --- UI: build sequencer grid ---

function buildSequencer() {
  const rows = document.querySelectorAll(".seq-steps");
  rows.forEach((row) => {
    const voice = row.dataset.voice;
    for (let i = 0; i < stepsCount; i++) {
      const step = document.createElement("div");
      step.className = "seq-step";
      step.dataset.voice = voice;
      step.dataset.step = i;
      step.addEventListener("click", () => {
        pattern[voice][i] = !pattern[voice][i];
        step.classList.toggle("active", pattern[voice][i]);
      });
      row.appendChild(step);
    }
  });
}

// --- Synth keyboard ---

const notes = [
  { name: "C4", freq: 261.63 },
  { name: "D4", freq: 293.66 },
  { name: "E4", freq: 329.63 },
  { name: "F4", freq: 349.23 },
  { name: "G4", freq: 392.0 },
  { name: "A4", freq: 440.0 },
  { name: "B4", freq: 493.88 },
  { name: "C5", freq: 523.25 },
];

function buildKeyboard() {
  const kb = document.getElementById("keyboard");
  notes.forEach((n) => {
    const key = document.createElement("div");
    key.className = "key";
    key.dataset.freq = n.freq;
    key.title = n.name;

    key.addEventListener("mousedown", () => {
      initAudio();
      key.classList.add("white-active");
      playSynthNote(n.freq);
    });
    key.addEventListener("mouseup", () => {
      key.classList.remove("white-active");
    });
    key.addEventListener("mouseleave", () => {
      key.classList.remove("white-active");
    });

    kb.appendChild(key);
  });
}

function playSynthNote(freq) {
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  osc.type = "sawtooth";
  osc.frequency.value = freq;

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(filterCutoff, now);
  filter.Q.value = filterRes;

  const attack = envAttack;
  const decay = envDecay;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.7, now + attack);
  gain.gain.linearRampToValueAtTime(0.0, now + attack + decay);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(synthBus);

  osc.start(now);
  osc.stop(now + attack + decay + 0.1);
}

// --- Transport ---

function start() {
  initAudio();
  if (isPlaying) return;
  isPlaying = true;
  currentStep = 0;
  tick();
}

function stop() {
  isPlaying = false;
  clearTimeout(timerId);
  timerId = null;
  document.querySelectorAll(".seq-step").forEach((el) => el.classList.remove("playing"));
}

// --- Visualizers ---

function setupVisualizers() {
  spectrumCanvas = document.getElementById("spectrumCanvas");
  oscCanvas = document.getElementById("oscCanvas");
  spectrumCtx = spectrumCanvas.getContext("2d");
  oscCtx = oscCanvas.getContext("2d");
}

function drawSpectrum() {
  if (!analyser) return;
  requestAnimationFrame(drawSpectrum);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  spectrumCtx.fillStyle = "#020617";
  spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  const barWidth = (spectrumCanvas.width / bufferLength) * 2.5;
  let x = 0;
  let maxDbNorm = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 255;
    const barHeight = v * spectrumCanvas.height;
    maxDbNorm = Math.max(maxDbNorm, v);

    const gradient = spectrumCtx.createLinearGradient(0, 0, 0, spectrumCanvas.height);
    gradient.addColorStop(0, "#22c55e");
    gradient.addColorStop(0.5, "#f97316");
    gradient.addColorStop(1, "#ef4444");

    spectrumCtx.fillStyle = gradient;
    spectrumCtx.fillRect(
      x,
      spectrumCanvas.height - barHeight,
      barWidth,
      barHeight
    );

    x += barWidth + 1;
  }

  setMeterHeight("master", maxDbNorm);
}

function drawOscilloscope() {
  if (!oscAnalyser) return;
  requestAnimationFrame(drawOscilloscope);

  const bufferLength = oscAnalyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  oscAnalyser.getByteTimeDomainData(dataArray);

  oscCtx.fillStyle = "#020617";
  oscCtx.fillRect(0, 0, oscCanvas.width, oscCanvas.height);

  oscCtx.lineWidth = 2;
  oscCtx.strokeStyle = "#38bdf8";
  oscCtx.beginPath();

  const sliceWidth = (oscCanvas.width * 1.0) / bufferLength;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * oscCanvas.height) / 2;

    if (i === 0) {
      oscCtx.moveTo(x, y);
    } else {
      oscCtx.lineTo(x, y);
    }

    x += sliceWidth;
  }

  oscCtx.stroke();
}

// --- Controls binding ---

function bindControls() {
  document.getElementById("drumsVol").addEventListener("input", (e) => {
    if (!audioCtx) return;
    drumsBus.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("drumsPan").addEventListener("input", (e) => {
    if (!audioCtx) return;
    drumsPanNode.pan.value = parseFloat(e.target.value);
  });

  document.getElementById("drumsVerb").addEventListener("input", (e) => {
    if (!audioCtx) return;
    drumsVerbSend.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("synthVol").addEventListener("input", (e) => {
    if (!audioCtx) return;
    synthBus.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("synthPan").addEventListener("input", (e) => {
    if (!audioCtx) return;
    synthPanNode.pan.value = parseFloat(e.target.value);
  });

  document.getElementById("synthVerb").addEventListener("input", (e) => {
    if (!audioCtx) return;
    synthVerbSend.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("masterLimit").addEventListener("input", (e) => {
    if (!audioCtx) return;
    const v = parseFloat(e.target.value);
    masterLimiter.threshold.value = (1 - v) * -20;
  });

  document.getElementById("verbMix").addEventListener("input", (e) => {
    if (!audioCtx) return;
    reverbMixGain.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("verbSize").addEventListener("input", (e) => {
    if (!audioCtx) return;
    const size = parseFloat(e.target.value);
    // map to delay time
    reverbInput.gain.setValueAtTime(1, audioCtx.currentTime);
    // you could also adjust delay.delayTime if you expose it
  });

  document.getElementById("verbDamp").addEventListener("input", () => {
    // placeholder: could be mapped to a lowpass filter in the reverb path
  });

  document.getElementById("filterCutoff").addEventListener("input", (e) => {
    filterCutoff = parseFloat(e.target.value);
  });

  document.getElementById("filterRes").addEventListener("input", (e) => {
    filterRes = parseFloat(e.target.value);
  });

  document.getElementById("envAttack").addEventListener("input", (e) => {
    envAttack = parseFloat(e.target.value);
  });

  document.getElementById("envDecay").addEventListener("input", (e) => {
    envDecay = parseFloat(e.target.value);
  });

  document.getElementById("noiseLevel").addEventListener("input", (e) => {
    noiseLevel = parseFloat(e.target.value);
    if (noiseGain) noiseGain.gain.value = noiseLevel;
  });

  document.getElementById("noiseGate").addEventListener("input", (e) => {
    noiseGateThreshold = parseFloat(e.target.value);
    // simple gate: if master meter below threshold, reduce noise
    // we approximate via analyser in drawSpectrum
  });
}

// --- Noise gate integration (approx) ---
// In drawSpectrum, we can gate noise based on maxDbNorm

const originalDrawSpectrum = drawSpectrum;
drawSpectrum = function wrappedDrawSpectrum() {
  if (!analyser) return;
  requestAnimationFrame(drawSpectrum);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  spectrumCtx.fillStyle = "#020617";
  spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  const barWidth = (spectrumCanvas.width / bufferLength) * 2.5;
  let x = 0;
  let maxDbNorm = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 255;
    const barHeight = v * spectrumCanvas.height;
    maxDbNorm = Math.max(maxDbNorm, v);

    const gradient = spectrumCtx.createLinearGradient(0, 0, 0, spectrumCanvas.height);
    gradient.addColorStop(0, "#22c55e");
    gradient.addColorStop(0.5, "#f97316");
    gradient.addColorStop(1, "#ef4444");

    spectrumCtx.fillStyle = gradient;
    spectrumCtx.fillRect(
      x,
      spectrumCanvas.height - barHeight,
      barWidth,
      barHeight
    );

    x += barWidth + 1;
  }

  // master meter
  setMeterHeight("master", maxDbNorm);

  // noise gate: convert norm to dB approx
  const db = maxDbNorm === 0 ? -80 : maxDbNorm * 60 - 60;
  if (noiseGain) {
    if (db < noiseGateThreshold) {
      noiseGain.gain.setTargetAtTime(noiseLevel * 0.1, audioCtx.currentTime, 0.1);
    } else {
      noiseGain.gain.setTargetAtTime(noiseLevel, audioCtx.currentTime, 0.1);
    }
  }
};

// --- Wire DOM ---

window.addEventListener("DOMContentLoaded", () => {
  buildSequencer();
  buildKeyboard();
  bindControls();

  document.getElementById("playBtn").addEventListener("click", start);
  document.getElementById("stopBtn").addEventListener("click", stop);

  document.body.addEventListener(
    "click",
    () => {
      initAudio();
    },
    { once: true }
  );
});
