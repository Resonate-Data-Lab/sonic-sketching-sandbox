// --- sonic sketch: record a sound, drag it around, play it back ---

const board = document.getElementById('board');
const canvas = document.getElementById('canvas');
const recordBtn = document.getElementById('recordBtn');
const recordIcon = recordBtn.querySelector('.icon');
const waveformIconHTML = recordIcon.innerHTML;
const playAllBtn = document.getElementById('playAllBtn');
const playheadEl = document.getElementById('playhead');
const timerEl = document.getElementById('timer');
const toastEl = document.getElementById('toast');
const addMenu = document.getElementById('addMenu');
const fileInput = document.getElementById('fileInput');
const penBtn = document.getElementById('penBtn');
const textBtn = document.getElementById('textBtn');
const imageBtn = document.getElementById('imageBtn');
const imageFileInput = document.getElementById('imageFileInput');
const drawPreview = document.getElementById('drawPreview');
const shareBtn = document.getElementById('shareBtn');
const sharePopup = document.getElementById('sharePopup');
const shareNameRow = document.getElementById('shareNameRow');
const shareNameInput = document.getElementById('shareNameInput');
const createLinkBtn = document.getElementById('createLinkBtn');
const shareLinkSection = document.getElementById('shareLinkSection');
const shareLinkInput = document.getElementById('shareLink');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const renameInput = document.getElementById('renameInput');
const renameBtn = document.getElementById('renameBtn');
const sketchbookTab = document.getElementById('sketchbookTab');
const createBookPopup = document.getElementById('createBookPopup');
const bookNameInput = document.getElementById('bookNameInput');
const createBookBtn = document.getElementById('createBookBtn');
const tray = document.getElementById('tray');
const trayLinkInput = document.getElementById('trayLinkInput');
const trayCopyBtn = document.getElementById('trayCopyBtn');
const trayList = document.getElementById('trayList');

const SVG_NS = 'http://www.w3.org/2000/svg';
const CANVAS_PIXELS_PER_SECOND = 140;
const DRAG_THRESHOLD = 4;
const AUTOSAVE_DEBOUNCE_MS = 1500;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024; // stay under Vercel's 4.5MB function body limit, per object
const IMAGE_DOWNSCALE_THRESHOLD = 1.5 * 1024 * 1024; // only bother resizing files big enough to risk hitting MAX_OBJECT_BYTES
const IMAGE_MAX_DIMENSION = 1600; // long edge, in px — plenty for a sketch element, far below phone-camera resolution
const IMAGE_JPEG_QUALITY = 0.82;

let mode = 'pointer'; // 'pointer' | 'pen'

let mediaRecorder = null;
let activeStream = null;
let chunks = [];
let isRecording = false;
let recordStartTime = 0;
let timerHandle = null;
let spawnIndex = 0;
let playheadRAF = null;
let clipboard = null;
let pasteGeneration = 0;
let currentSketchId = null;
let currentSketchName = '';
let currentSketchBookIds = [];
let isLoadingSketch = false;

// ---------- feature check ----------

const micSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

// ---------- the "+" popover: record or upload ----------

recordBtn.addEventListener('click', () => {
  if (mode === 'pen') setMode('pen');
  if (isRecording) {
    stopRecording();
    return;
  }
  addMenu.hidden = !addMenu.hidden;
});

document.addEventListener('pointerdown', (e) => {
  if (addMenu.hidden) return;
  if (addMenu.contains(e.target) || recordBtn.contains(e.target)) return;
  addMenu.hidden = true;
});

// a focused note/text box (contenteditable) otherwise never loses focus when you click
// away from it, since sound nodes/strokes/the board aren't themselves focusable —
// that stale focus would otherwise silently swallow Delete/Cmd+C/Cmd+V as "typing"
document.addEventListener('pointerdown', (e) => {
  const active = document.activeElement;
  const isEditableField = active && active.classList && (active.classList.contains('note') || active.classList.contains('text-content'));
  if (isEditableField && !active.contains(e.target)) {
    active.blur();
  }
});

document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const isTyping = active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (isTyping) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    const selected = Array.from(document.querySelectorAll('.selected'));
    if (selected.length === 0) return;
    e.preventDefault();
    selected.forEach((el) => el.deleteObject());
    return;
  }

  const withModifier = e.ctrlKey || e.metaKey;
  if (withModifier && e.key.toLowerCase() === 'c') {
    if (document.querySelectorAll('.selected').length === 0) return;
    e.preventDefault();
    copySelection();
  } else if (withModifier && e.key.toLowerCase() === 'v') {
    if (!clipboard) return;
    e.preventDefault();
    pasteClipboard();
  }
});

addMenu.querySelector('[data-action="record"]').addEventListener('click', () => {
  addMenu.hidden = true;
  if (!micSupported) {
    showToast("This browser can't record audio here. Try uploading a file instead.");
    return;
  }
  startRecording();
});

addMenu.querySelector('[data-action="upload"]').addEventListener('click', () => {
  addMenu.hidden = true;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    showToast('Please choose an audio file (wav, mp3, etc).');
    return;
  }
  const url = URL.createObjectURL(file);
  const { x, y } = nextSpawnPosition();
  createSoundNode(x, y, url);
});

// ---------- recording ----------

async function startRecording() {
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access was blocked or is unavailable.');
    return;
  }

  chunks = [];
  mediaRecorder = new MediaRecorder(activeStream);
  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  mediaRecorder.addEventListener('stop', onRecordingStop);
  mediaRecorder.start();

  isRecording = true;
  recordBtn.classList.add('recording');
  recordIcon.textContent = '■'; // overwrites the waveform bars while recording
  recordBtn.title = 'Stop recording';
  startTimer();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
  isRecording = false;
  recordBtn.classList.remove('recording');
  recordIcon.innerHTML = waveformIconHTML;
  recordBtn.title = 'Record a sound';
  stopTimer();
}

function onRecordingStop() {
  if (chunks.length === 0) return;
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const { x, y } = nextSpawnPosition();
  createSoundNode(x, y, url);
}

function startTimer() {
  recordStartTime = Date.now();
  timerEl.hidden = false;
  timerEl.textContent = '0:00';
  timerHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 250);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerEl.hidden = true;
}

// ---------- the scrollable, growing canvas ----------

// converts a viewport/client coordinate into canvas-space, accounting for
// however far the canvas is currently scrolled (getBoundingClientRect already
// reflects scroll position, so no manual offset bookkeeping is needed)
function toCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

const GROW_MARGIN = 300; // flat margin covering most object sizes without measuring each one

function growCanvasToFit(x, y) {
  const neededWidth = x + GROW_MARGIN;
  const neededHeight = y + GROW_MARGIN;
  if (neededWidth > canvas.offsetWidth) canvas.style.width = `${neededWidth}px`;
  if (neededHeight > canvas.offsetHeight) canvas.style.height = `${neededHeight}px`;
}

const EDGE_SCROLL_ZONE = 40; // px from the viewport edge that triggers auto-scroll while dragging
const EDGE_SCROLL_SPEED = 18; // px scrolled per drag-move tick while in that zone

// lets you drag something off the visible edge and see the view follow, so you
// can tell how far you're actually moving it
function autoScrollForDrag(clientX, clientY) {
  const rect = board.getBoundingClientRect();
  if (clientX < rect.left + EDGE_SCROLL_ZONE) board.scrollLeft -= EDGE_SCROLL_SPEED;
  else if (clientX > rect.right - EDGE_SCROLL_ZONE) board.scrollLeft += EDGE_SCROLL_SPEED;
  if (clientY < rect.top + EDGE_SCROLL_ZONE) board.scrollTop -= EDGE_SCROLL_SPEED;
  else if (clientY > rect.bottom - EDGE_SCROLL_ZONE) board.scrollTop += EDGE_SCROLL_SPEED;
}

// ---------- two-finger scrolling on touch screens ----------

// whatever one-finger interaction is in progress (a stroke, a drag, a marquee)
// registers how to abort itself here, so a second finger landing can undo it
// instead of leaving a stray dot or a small nudge behind
let cancelActiveGesture = null;

const panTouches = new Map(); // pointerId -> { x, y }, only touches that started on the board
let isPanning = false;
let lastPanMid = null;

function panMidpoint() {
  const pts = Array.from(panTouches.values());
  return {
    x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
    y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
  };
}

// these run in the capture phase on window, ahead of every other pointer
// handler, so while panning no other handler ever sees these touches
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !board.contains(e.target)) return;
  panTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (panTouches.size === 2 && !isPanning) {
    isPanning = true;
    if (cancelActiveGesture) cancelActiveGesture();
    cancelActiveGesture = null;
  }
  if (isPanning) {
    lastPanMid = panMidpoint();
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

window.addEventListener('pointermove', (e) => {
  if (!panTouches.has(e.pointerId)) return;
  panTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!isPanning) return;
  e.stopImmediatePropagation();
  if (panTouches.size < 2) return; // one finger left over from a pan: ignore it until it lifts
  const mid = panMidpoint();
  board.scrollLeft -= mid.x - lastPanMid.x;
  board.scrollTop -= mid.y - lastPanMid.y;
  lastPanMid = mid;
}, true);

function endPanTouch(e) {
  if (!panTouches.has(e.pointerId)) return;
  panTouches.delete(e.pointerId);
  if (!isPanning) return;
  e.stopImmediatePropagation();
  if (panTouches.size === 0) isPanning = false;
  else lastPanMid = panMidpoint();
}
window.addEventListener('pointerup', endPanTouch, true);
window.addEventListener('pointercancel', endPanTouch, true);

// ---------- placing new sounds near the button ----------

function nextSpawnPosition() {
  const origin = toCanvasPoint(150, 110);
  const step = 64;
  const perRow = 6;
  const row = Math.floor(spawnIndex / perRow);
  const col = spawnIndex % perRow;
  spawnIndex++;
  return {
    x: origin.x + col * step,
    y: origin.y + row * step,
  };
}

// ---------- selection (sounds and strokes alike) & dragging ----------

function clearSelection() {
  document.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
}

// ---------- copy & paste a mixed selection of sounds and doodles ----------

async function copySelection() {
  const selected = Array.from(document.querySelectorAll('.selected'));
  if (selected.length === 0) return;

  const anchorX = Math.min(...selected.map((el) => parseFloat(el.style.left)));
  const anchorY = Math.min(...selected.map((el) => parseFloat(el.style.top)));

  try {
    const items = await Promise.all(
      selected.map(async (el) => {
        const relX = parseFloat(el.style.left) - anchorX;
        const relY = parseFloat(el.style.top) - anchorY;

        if (el.classList.contains('sound-node')) {
          const blob = await (await fetch(el.dataset.url)).blob();
          const note = el.querySelector('.note');
          return {
            type: 'sound',
            relX,
            relY,
            blob,
            noteText: note ? note.textContent : '',
            fx: { speed: el.fxSpeed, volume: el.fxVolume, reverb: el.fxReverb, reverse: el.fxReverse },
          };
        }
        if (el.classList.contains('stroke')) {
          const path = el.querySelector('path');
          return {
            type: 'stroke',
            relX,
            relY,
            width: parseFloat(el.style.width),
            height: parseFloat(el.style.height),
            pathD: path.getAttribute('d'),
          };
        }
        if (el.classList.contains('text-box')) {
          const content = el.querySelector('.text-content');
          return { type: 'text', relX, relY, text: content ? content.textContent : '' };
        }
        if (el.classList.contains('image-box')) {
          const blob = await (await fetch(el.dataset.url)).blob();
          return { type: 'image', relX, relY, blob };
        }
        return null;
      })
    );

    clipboard = { anchorX, anchorY, items: items.filter(Boolean) };
    pasteGeneration = 0;
  } catch (err) {
    showToast('Could not copy that selection.');
  }
}

function pasteClipboard() {
  if (!clipboard) return;
  pasteGeneration++;
  const dx = 30 * pasteGeneration;
  const dy = 30 * pasteGeneration;

  const pasted = clipboard.items
    .map((item) => {
      const x = clipboard.anchorX + item.relX + dx;
      const y = clipboard.anchorY + item.relY + dy;

      if (item.type === 'sound') {
        const url = URL.createObjectURL(item.blob);
        const node = createSoundNode(x, y, url);
        const note = node.querySelector('.note');
        if (note) note.textContent = item.noteText;
        if (item.fx) node.setFx(item.fx);
        return node;
      }
      if (item.type === 'stroke') {
        return createStrokeElement(x, y, item.width, item.height, item.pathD);
      }
      if (item.type === 'text') {
        return createTextElement(x, y, item.text);
      }
      if (item.type === 'image') {
        return createImageElement(x, y, URL.createObjectURL(item.blob));
      }
      return null;
    })
    .filter(Boolean);

  clearSelection();
  pasted.forEach((el) => el.classList.add('selected'));
}

function makeDraggable(el, { onClick } = {}) {
  let dragging = false;
  let moved = false;
  let start = { x: 0, y: 0 };
  let dragGroup = [];
  let startPositions = [];

  el.addEventListener('pointerdown', (e) => {
    if (mode !== 'pointer') return;
    e.stopPropagation();
    e.preventDefault();

    dragging = true;
    moved = false;
    start = { x: e.clientX, y: e.clientY };

    // drag the existing selection if this item is already part of one, otherwise just this item
    dragGroup = el.classList.contains('selected') ? Array.from(document.querySelectorAll('.selected')) : [el];
    startPositions = dragGroup.map((item) => ({
      item,
      left: parseFloat(item.style.left),
      top: parseFloat(item.style.top),
    }));
    el.setPointerCapture(e.pointerId);

    const pointerId = e.pointerId;
    cancelActiveGesture = () => {
      dragging = false;
      startPositions.forEach(({ item, left, top }) => {
        item.style.left = `${left}px`;
        item.style.top = `${top}px`;
      });
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    };
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      moved = true;
      // only show the "selected" highlight once this is an actual move, not a plain click
      dragGroup.forEach((item) => item.classList.add('selected'));
    }
    if (moved) {
      startPositions.forEach(({ item, left, top }) => {
        const newLeft = left + dx;
        const newTop = top + dy;
        item.style.left = `${newLeft}px`;
        item.style.top = `${newTop}px`;
        growCanvasToFit(newLeft, newTop);
      });
      autoScrollForDrag(e.clientX, e.clientY);
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    cancelActiveGesture = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (moved) {
      clearSelection();
      dragGroup.forEach((item) => scheduleObjectSave(item));
    } else if (onClick) {
      onClick(e);
    }
  });
}

// ---------- audio playback + light effects (speed, reverse, reverb) ----------

let audioContext = null;
let reverbImpulseBuffer = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

// a short synthetic impulse response (decaying noise) — no external audio
// file needed just to get a basic, recognizable reverb tail
function getReverbImpulse(ctx) {
  if (!reverbImpulseBuffer) {
    const duration = 2;
    const length = Math.round(ctx.sampleRate * duration);
    reverbImpulseBuffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = reverbImpulseBuffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
    }
  }
  return reverbImpulseBuffer;
}

function reverseBuffer(ctx, buffer) {
  const reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel).slice().reverse();
    reversed.copyToChannel(data, channel);
  }
  return reversed;
}

// decodes a node's audio once and caches the result on the node itself,
// since decoding is relatively expensive and this app encourages rapid re-triggering
function decodeNodeBuffer(node) {
  if (!node._bufferPromise) {
    node._bufferPromise = fetch(node.dataset.url)
      .then((res) => res.arrayBuffer())
      .then((data) => getAudioContext().decodeAudioData(data));
  }
  return node._bufferPromise;
}

// plays a node's sound through its currently configured speed/reverse/reverb,
// reporting progress (0-1) for the existing progress-bar UI, and resolving when
// playback actually finishes (including if stopped early, so cleanup always runs)
function playNodeSound(node, { onProgress, registerSource, unregisterSource } = {}) {
  const ctx = getAudioContext();
  return decodeNodeBuffer(node).then((buffer) => {
    const speed = node.fxSpeed || 1;
    const reverbAmount = node.fxReverb || 0;
    const volumeDb = node.fxVolume || 0;

    let sourceBuffer = buffer;
    if (node.fxReverse) {
      if (!node._reversedBuffer) node._reversedBuffer = reverseBuffer(ctx, buffer);
      sourceBuffer = node._reversedBuffer;
    }

    const source = ctx.createBufferSource();
    source.buffer = sourceBuffer;
    source.playbackRate.value = speed;

    // volume is stored in decibels (0 = unchanged), so the slider's center is
    // "as recorded" and equal distances either side feel equally louder/quieter
    const volumeGain = ctx.createGain();
    volumeGain.gain.value = Math.pow(10, volumeDb / 20);
    source.connect(volumeGain);

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1 - reverbAmount;
    const wetGain = ctx.createGain();
    wetGain.gain.value = reverbAmount;
    const convolver = ctx.createConvolver();
    convolver.buffer = getReverbImpulse(ctx);

    volumeGain.connect(dryGain).connect(ctx.destination);
    volumeGain.connect(convolver).connect(wetGain).connect(ctx.destination);

    const startTime = ctx.currentTime;
    const playDuration = sourceBuffer.duration / speed;
    let rafId = null;

    function tick() {
      const elapsed = ctx.currentTime - startTime;
      if (onProgress) onProgress(Math.min(1, elapsed / playDuration));
      if (elapsed < playDuration) rafId = requestAnimationFrame(tick);
    }
    if (onProgress) rafId = requestAnimationFrame(tick);
    if (registerSource) registerSource(source);

    return new Promise((resolve) => {
      source.onended = () => {
        if (rafId) cancelAnimationFrame(rafId);
        if (onProgress) onProgress(1);
        if (unregisterSource) unregisterSource(source);
        resolve();
      };
      source.start();
    });
  });
}

// ---------- sound nodes: draggable, playable, annotatable ----------

const VOLUME_RANGE_DB = 12; // slider goes this many dB quieter/louder either side of "as recorded"

// wraps a slider whose middle is its default, adding a faint tick under the center
function centerTicked(input) {
  const wrap = document.createElement('span');
  wrap.className = 'fx-centered';
  wrap.appendChild(input);
  return wrap;
}

function createSoundNode(x, y, url, id) {
  const node = document.createElement('div');
  node.className = 'sound-node';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.dataset.url = url;
  node.dataset.objectId = id || crypto.randomUUID();
  node.fxSpeed = 1;
  node.fxVolume = 0;
  node.fxReverb = 0;
  node.fxReverse = false;

  const wobble = (Math.random() * 8 - 4).toFixed(1);
  node.style.transform = `rotate(${wobble}deg)`;

  const play = document.createElement('span');
  play.className = 'play';
  play.textContent = '▶';

  const del = document.createElement('div');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Delete this sound';

  const dup = document.createElement('div');
  dup.className = 'duplicate';
  dup.title = 'Duplicate this sound';

  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.title = 'Edit sound (speed, volume, reverb, reverse)';

  const fxPopup = document.createElement('div');
  fxPopup.className = 'fx-popup';
  fxPopup.hidden = true;

  const speedLabel = document.createElement('label');
  speedLabel.textContent = 'speed';
  const speedInput = document.createElement('input');
  speedInput.type = 'range';
  speedInput.className = 'fx-speed';
  speedInput.min = '0.5';
  speedInput.max = '1.5';
  speedInput.step = '0.01';
  speedInput.value = '1';
  speedLabel.appendChild(centerTicked(speedInput));

  const volumeLabel = document.createElement('label');
  volumeLabel.textContent = 'volume';
  const volumeInput = document.createElement('input');
  volumeInput.type = 'range';
  volumeInput.className = 'fx-volume';
  volumeInput.min = String(-VOLUME_RANGE_DB);
  volumeInput.max = String(VOLUME_RANGE_DB);
  volumeInput.step = '0.5';
  volumeInput.value = '0';
  volumeLabel.appendChild(centerTicked(volumeInput));

  const reverbLabel = document.createElement('label');
  reverbLabel.textContent = 'reverb';
  const reverbInput = document.createElement('input');
  reverbInput.type = 'range';
  reverbInput.className = 'fx-reverb';
  reverbInput.min = '0';
  reverbInput.max = '1';
  reverbInput.step = '0.01';
  reverbInput.value = '0';
  reverbLabel.appendChild(reverbInput);

  const reverseLabel = document.createElement('label');
  reverseLabel.className = 'fx-reverse-row';
  const reverseInput = document.createElement('input');
  reverseInput.type = 'checkbox';
  reverseInput.className = 'fx-reverse';
  reverseLabel.append(reverseInput, document.createTextNode(' reverse'));

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'fx-reset';
  resetBtn.textContent = 'reset';

  fxPopup.append(speedLabel, volumeLabel, reverbLabel, reverseLabel, resetBtn);

  const note = document.createElement('div');
  note.className = 'note';
  note.contentEditable = 'true';
  note.setAttribute('data-placeholder', 'add a note…');
  note.spellcheck = false;

  const bars = document.createElement('div');
  bars.className = 'bars';

  node.append(play, del, dup, knob, fxPopup, bars, note);
  canvas.appendChild(node);
  growCanvasToFit(x, y);

  // lets loading/duplicating/pasting set speed/reverb/reverse on an existing node,
  // keeping the JS state and the slider/checkbox UI in sync in one place
  node.setFx = ({ speed = 1, volume = 0, reverb = 0, reverse = false }) => {
    node.fxSpeed = speed;
    node.fxVolume = volume;
    node.fxReverb = reverb;
    node.fxReverse = reverse;
    speedInput.value = speed;
    volumeInput.value = volume;
    reverbInput.value = reverb;
    reverseInput.checked = reverse;
  };

  wireUpNode(node, del, dup, note, bars, knob, fxPopup, speedInput, volumeInput, reverbInput, reverseInput, resetBtn);
  scheduleObjectSave(node);
  return node;
}

let openFxPopup = null;

function closeFxPopup() {
  if (!openFxPopup) return;
  openFxPopup.hidden = true;
  const owner = openFxPopup.closest('.sound-node');
  if (owner) owner.classList.remove('fx-open');
  openFxPopup = null;
}

document.addEventListener('pointerdown', (e) => {
  if (!openFxPopup) return;
  if (openFxPopup.contains(e.target)) return;
  closeFxPopup();
});

function wireUpNode(node, del, dup, note, bars, knob, fxPopup, speedInput, volumeInput, reverbInput, reverseInput, resetBtn) {
  let activePlays = 0;
  const activeSources = [];

  function trigger() {
    activePlays++;
    node.classList.add('playing');

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    bar.appendChild(fill);
    bars.appendChild(bar);

    const finish = () => {
      bar.remove();
      activePlays = Math.max(0, activePlays - 1);
      if (activePlays === 0) node.classList.remove('playing');
    };

    return playNodeSound(node, {
      onProgress: (fraction) => {
        fill.style.width = `${fraction * 100}%`;
      },
      registerSource: (source) => activeSources.push(source),
      unregisterSource: (source) => {
        const i = activeSources.indexOf(source);
        if (i >= 0) activeSources.splice(i, 1);
      },
    }).finally(finish);
  }

  // let the "play entire canvas" feature trigger this node the same way a click does
  node.triggerSound = trigger;

  // shared by the "x" button and the Delete/Backspace key on a selection
  node.deleteObject = () => {
    activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // already stopped/finished — nothing to do
      }
    });
    URL.revokeObjectURL(node.dataset.url);
    deleteObjectRemote(node.dataset.objectId);
    node.remove();
  };

  makeDraggable(node, { onClick: trigger });

  // keep clicks/typing in the note, delete, duplicate, or fx controls from starting a drag or a play
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    node.deleteObject();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    duplicateNode(node, note);
  });

  knob.addEventListener('pointerdown', (e) => e.stopPropagation());
  knob.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openFxPopup && openFxPopup !== fxPopup) closeFxPopup();
    fxPopup.hidden = !fxPopup.hidden;
    node.classList.toggle('fx-open', !fxPopup.hidden);
    openFxPopup = fxPopup.hidden ? null : fxPopup;
  });

  // auto-close once the pointer has been away from the node (and its popup —
  // a DOM descendant, so hovering it doesn't count as "away") for a bit, with
  // a short grace period so crossing the small visual gap to reach a slider doesn't close it
  let fxCloseTimer = null;
  node.addEventListener('pointerenter', () => clearTimeout(fxCloseTimer));
  node.addEventListener('pointerleave', () => {
    if (fxPopup.hidden) return;
    fxCloseTimer = setTimeout(() => {
      if (openFxPopup === fxPopup) closeFxPopup();
    }, 400);
  });

  fxPopup.addEventListener('pointerdown', (e) => e.stopPropagation());
  fxPopup.addEventListener('click', (e) => e.stopPropagation());
  speedInput.addEventListener('input', () => {
    node.fxSpeed = parseFloat(speedInput.value);
    scheduleObjectSave(node);
  });
  volumeInput.addEventListener('input', () => {
    node.fxVolume = parseFloat(volumeInput.value);
    scheduleObjectSave(node);
  });
  reverbInput.addEventListener('input', () => {
    node.fxReverb = parseFloat(reverbInput.value);
    scheduleObjectSave(node);
  });
  reverseInput.addEventListener('change', () => {
    node.fxReverse = reverseInput.checked;
    scheduleObjectSave(node);
  });
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    node.setFx({ speed: 1, volume: 0, reverb: 0, reverse: false });
    scheduleObjectSave(node);
  });

  note.addEventListener('pointerdown', (e) => e.stopPropagation());
  note.addEventListener('click', (e) => e.stopPropagation());
  note.addEventListener('input', () => scheduleObjectSave(node));
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      note.blur();
    }
  });
}

// ---------- duplicating a sound ----------

async function duplicateNode(sourceNode, sourceNote) {
  try {
    const blob = await (await fetch(sourceNode.dataset.url)).blob();
    const url = URL.createObjectURL(blob);
    const x = parseFloat(sourceNode.style.left) + 30;
    const y = parseFloat(sourceNode.style.top) + 30;
    const newNode = createSoundNode(x, y, url);
    const newNote = newNode.querySelector('.note');
    if (newNote) newNote.textContent = sourceNote.textContent;
    newNode.setFx({ speed: sourceNode.fxSpeed, volume: sourceNode.fxVolume, reverb: sourceNode.fxReverb, reverse: sourceNode.fxReverse });
  } catch (err) {
    showToast('Could not duplicate that sound.');
  }
}

// ---------- the pen tool: draw a doodle, drag it, delete/duplicate it ----------

function setMode(next) {
  mode = mode === next ? 'pointer' : next;
  penBtn.classList.toggle('active', mode === 'pen');
  board.style.cursor = mode === 'pen' ? 'crosshair' : '';
  document.body.classList.toggle('pen-active', mode === 'pen');
  if (mode !== 'pointer') clearSelection();
}

penBtn.addEventListener('click', () => setMode('pen'));

board.addEventListener('pointerdown', (e) => {
  if (mode === 'pen') {
    startStroke(e);
  } else {
    startMarquee(e);
  }
});

function startMarquee(e) {
  // nothing on the canvas to select yet — skip the whole marquee interaction so
  // casual clicking around an empty canvas never flashes a confusing selection box
  if (document.querySelectorAll('.sound-node, .stroke, .text-box, .image-box').length === 0) return;

  e.preventDefault();
  const keepSelected = e.shiftKey ? new Set(document.querySelectorAll('.selected')) : new Set();
  if (!e.shiftKey) clearSelection();

  const startX = e.clientX;
  const startY = e.clientY;
  let box = null;
  let moved = false;

  function updateBox(cx, cy) {
    const x = Math.min(startX, cx);
    const y = Math.min(startY, cy);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    // the box lives inside the scrolled canvas, so it's placed in canvas-space;
    // the returned rect stays in client-space to compare against getBoundingClientRect
    const corner = toCanvasPoint(x, y);
    box.style.left = `${corner.x}px`;
    box.style.top = `${corner.y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    return { left: x, top: y, right: x + w, bottom: y + h };
  }

  function applySelection(rect) {
    document.querySelectorAll('.sound-node, .stroke, .text-box, .image-box').forEach((item) => {
      const r = item.getBoundingClientRect();
      const intersects = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
      item.classList.toggle('selected', intersects || keepSelected.has(item));
    });
  }

  function onMove(ev) {
    if (!moved) {
      if (Math.abs(ev.clientX - startX) <= DRAG_THRESHOLD && Math.abs(ev.clientY - startY) <= DRAG_THRESHOLD) return;
      moved = true;
      box = document.createElement('div');
      box.className = 'marquee';
      canvas.appendChild(box);
    }
    applySelection(updateBox(ev.clientX, ev.clientY));
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (box) box.remove();
    cancelActiveGesture = null;
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  cancelActiveGesture = () => {
    onUp();
    clearSelection();
    keepSelected.forEach((item) => item.classList.add('selected'));
  };
}

function pointsToPathData(points, offsetX, offsetY) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x - offsetX} ${p.y - offsetY}`).join(' ');
}

function startStroke(e) {
  e.preventDefault();
  // capture points in canvas-space right away, so the live preview (which
  // lives inside the scrolled canvas) lines up with the cursor
  const points = [toCanvasPoint(e.clientX, e.clientY)];
  const previewPath = document.createElementNS(SVG_NS, 'path');
  previewPath.setAttribute('d', pointsToPathData(points, 0, 0));
  drawPreview.appendChild(previewPath);

  function onMove(ev) {
    points.push(toCanvasPoint(ev.clientX, ev.clientY));
    previewPath.setAttribute('d', pointsToPathData(points, 0, 0));
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    previewPath.remove();
    cancelActiveGesture = null;
    finalizeStroke(points);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  cancelActiveGesture = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    previewPath.remove();
  };
}

function finalizeStroke(points) {
  if (points.length < 2) return;

  const pad = 6;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.max(...xs) + pad - minX;
  const height = Math.max(...ys) + pad - minY;
  const pathD = pointsToPathData(points, minX, minY);

  createStrokeElement(minX, minY, width, height, pathD);
}

function createStrokeElement(left, top, width, height, pathD, id) {
  const strokeEl = document.createElement('div');
  strokeEl.className = 'stroke';
  strokeEl.style.left = `${left}px`;
  strokeEl.style.top = `${top}px`;
  strokeEl.style.width = `${width}px`;
  strokeEl.style.height = `${height}px`;
  strokeEl.dataset.objectId = id || crypto.randomUUID();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  svg.appendChild(path);

  const del = document.createElement('div');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Delete this doodle';

  const dup = document.createElement('div');
  dup.className = 'duplicate';
  dup.title = 'Duplicate this doodle';

  strokeEl.append(svg, del, dup);
  canvas.appendChild(strokeEl);
  growCanvasToFit(left, top);

  strokeEl.deleteObject = () => {
    deleteObjectRemote(strokeEl.dataset.objectId);
    strokeEl.remove();
  };

  makeDraggable(strokeEl);

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    strokeEl.deleteObject();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    const currentLeft = parseFloat(strokeEl.style.left) + 30;
    const currentTop = parseFloat(strokeEl.style.top) + 30;
    createStrokeElement(currentLeft, currentTop, width, height, pathD);
  });

  scheduleObjectSave(strokeEl);
  return strokeEl;
}

// ---------- the text tool: add a text box ----------

// focuses a contenteditable AND places the cursor at the exact point clicked,
// matching native click-to-position behavior (which a programmatic .focus() alone doesn't do)
function focusAt(content, x, y) {
  content.focus();
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

textBtn.addEventListener('click', () => {
  if (mode === 'pen') setMode('pen');
  const { x, y } = nextSpawnPosition();
  const el = createTextElement(x, y, '');
  el.querySelector('.text-content').focus();
});

function createTextElement(x, y, text, id) {
  const el = document.createElement('div');
  el.className = 'text-box';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.dataset.objectId = id || crypto.randomUUID();

  const content = document.createElement('div');
  content.className = 'text-content';
  content.contentEditable = 'true';
  content.setAttribute('data-placeholder', 'type something…');
  content.spellcheck = false;
  content.textContent = text || '';

  const del = document.createElement('div');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Delete this text';

  const dup = document.createElement('div');
  dup.className = 'duplicate';
  dup.title = 'Duplicate this text';

  el.append(content, del, dup);
  canvas.appendChild(el);
  growCanvasToFit(x, y);

  el.deleteObject = () => {
    deleteObjectRemote(el.dataset.objectId);
    el.remove();
  };

  // a plain click (no movement) focuses the text for editing, same single-click
  // feel as the note under a sound; a click-and-drag moves it instead, same
  // disambiguation makeDraggable already uses for playing a sound on click
  makeDraggable(el, { onClick: (e) => focusAt(content, e.clientX, e.clientY) });

  // once actually focused, clicks inside should behave like normal text editing
  // (place the cursor, select text) instead of being treated as a drag
  content.addEventListener('pointerdown', (e) => {
    if (document.activeElement === content) e.stopPropagation();
  });
  content.addEventListener('click', (e) => {
    if (document.activeElement === content) e.stopPropagation();
  });
  content.addEventListener('input', () => scheduleObjectSave(el));

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    el.deleteObject();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    const currentLeft = parseFloat(el.style.left) + 30;
    const currentTop = parseFloat(el.style.top) + 30;
    createTextElement(currentLeft, currentTop, content.textContent);
  });

  scheduleObjectSave(el);
  return el;
}

// ---------- uploading an image ----------

imageBtn.addEventListener('click', () => {
  if (mode === 'pen') setMode('pen');
  imageFileInput.click();
});

// phone-camera photos routinely exceed MAX_OBJECT_BYTES once base64-encoded — shrink
// the pixel dimensions (the actual source of the bloat) before they ever reach that check
async function downscaleImageIfNeeded(file) {
  if (file.size <= IMAGE_DOWNSCALE_THRESHOLD) return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG stays PNG so transparency survives; everything else re-encodes as JPEG for the size win
  const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, IMAGE_JPEG_QUALITY));
  return blob || file;
}

imageFileInput.addEventListener('change', async () => {
  const file = imageFileInput.files && imageFileInput.files[0];
  imageFileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file (jpg, png, etc).');
    return;
  }

  let blob = file;
  try {
    blob = await downscaleImageIfNeeded(file);
  } catch (err) {
    // if decoding/resizing fails for any reason, fall back to the original file untouched
  }

  const url = URL.createObjectURL(blob);
  const { x, y } = nextSpawnPosition();
  createImageElement(x, y, url);
});

function createImageElement(x, y, url, id) {
  const el = document.createElement('div');
  el.className = 'image-box';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.dataset.url = url;
  el.dataset.objectId = id || crypto.randomUUID();

  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.draggable = false;

  const del = document.createElement('div');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Delete this image';

  const dup = document.createElement('div');
  dup.className = 'duplicate';
  dup.title = 'Duplicate this image';

  el.append(img, del, dup);
  canvas.appendChild(el);
  growCanvasToFit(x, y);

  el.deleteObject = () => {
    deleteObjectRemote(el.dataset.objectId);
    URL.revokeObjectURL(el.dataset.url);
    el.remove();
  };

  makeDraggable(el);

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    el.deleteObject();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      // an independent copy of the blob, same reason sound duplication does this —
      // deleting the original must not break a duplicate sharing the same URL
      const blob = await (await fetch(el.dataset.url)).blob();
      const newUrl = URL.createObjectURL(blob);
      const currentLeft = parseFloat(el.style.left) + 30;
      const currentTop = parseFloat(el.style.top) + 30;
      createImageElement(currentLeft, currentTop, newUrl);
    } catch (err) {
      showToast('Could not duplicate that image.');
    }
  });

  scheduleObjectSave(el);
  return el;
}

// ---------- sharing: serialize the canvas to JSON and back ----------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function serializeOne(el) {
  const x = parseFloat(el.style.left);
  const y = parseFloat(el.style.top);
  const id = el.dataset.objectId;

  if (el.classList.contains('sound-node')) {
    const blob = await (await fetch(el.dataset.url)).blob();
    const base64 = await blobToBase64(blob);
    const rotationMatch = el.style.transform.match(/rotate\(([-\d.]+)deg\)/);
    const note = el.querySelector('.note');
    return {
      id,
      type: 'sound',
      x,
      y,
      rotation: rotationMatch ? parseFloat(rotationMatch[1]) : 0,
      note: note ? note.textContent : '',
      audio: { mimeType: blob.type || 'audio/webm', base64 },
      speed: el.fxSpeed,
      volume: el.fxVolume,
      reverb: el.fxReverb,
      reverse: el.fxReverse,
    };
  }

  if (el.classList.contains('text-box')) {
    const content = el.querySelector('.text-content');
    return { id, type: 'text', x, y, text: content ? content.textContent : '' };
  }

  if (el.classList.contains('image-box')) {
    const blob = await (await fetch(el.dataset.url)).blob();
    const base64 = await blobToBase64(blob);
    return { id, type: 'image', x, y, image: { mimeType: blob.type || 'image/png', base64 } };
  }

  const path = el.querySelector('path');
  return {
    id,
    type: 'stroke',
    x,
    y,
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
    pathD: path.getAttribute('d'),
  };
}

async function serializeCanvas() {
  const elements = Array.from(document.querySelectorAll('.sound-node, .stroke, .text-box, .image-box'));
  const nodes = await Promise.all(elements.map((el) => serializeOne(el)));
  return { version: 1, nodes };
}

function deserializeCanvas(data) {
  document.querySelectorAll('.sound-node, .stroke, .text-box, .image-box').forEach((el) => el.remove());

  const nodes = (data && data.nodes) || [];
  nodes.forEach((n) => {
    if (n.type === 'sound') {
      const blob = base64ToBlob(n.audio.base64, n.audio.mimeType);
      const url = URL.createObjectURL(blob);
      const node = createSoundNode(n.x, n.y, url, n.id);
      node.style.transform = `rotate(${n.rotation || 0}deg)`;
      const note = node.querySelector('.note');
      if (note) note.textContent = n.note || '';
      node.setFx({ speed: n.speed || 1, volume: n.volume || 0, reverb: n.reverb || 0, reverse: n.reverse || false });
    } else if (n.type === 'stroke') {
      createStrokeElement(n.x, n.y, n.width, n.height, n.pathD, n.id);
    } else if (n.type === 'text') {
      createTextElement(n.x, n.y, n.text, n.id);
    } else if (n.type === 'image') {
      const blob = base64ToBlob(n.image.base64, n.image.mimeType);
      const url = URL.createObjectURL(blob);
      createImageElement(n.x, n.y, url, n.id);
    }
  });

  // reduce (not fully eliminate) new objects landing on top of restored ones
  spawnIndex = nodes.length;
}

// ---------- sharing: save to a link, load from a link, per-object autosave ----------

async function loadSketchById(id) {
  isLoadingSketch = true;
  try {
    const res = await fetch(`/api/sketch/${id}`);
    if (!res.ok) {
      showToast("That sketch link doesn't exist anymore.");
      return false;
    }
    const data = await res.json();
    deserializeCanvas(data);
    currentSketchId = id;
    currentSketchName = data.name || '';
    currentSketchBookIds = data.bookIds || [];
    updateSketchbookTabState();
    return true;
  } catch (err) {
    showToast('Could not load that sketch.');
    return false;
  } finally {
    isLoadingSketch = false;
  }
}

async function loadSketchFromURL() {
  const params = new URLSearchParams(location.search);
  const sketchId = params.get('sketch');
  const bookId = params.get('book');

  if (sketchId) {
    await loadSketchById(sketchId);
    return;
  }

  if (bookId) {
    try {
      const res = await fetch(`/api/book/${bookId}`);
      if (!res.ok) {
        showToast("That sketchbook link doesn't exist anymore.");
        return;
      }
      const book = await res.json();
      const seed = book.sketches && book.sketches[0];
      if (!seed) return;
      history.replaceState(null, '', `${location.pathname}?sketch=${seed.id}`);
      const loaded = await loadSketchById(seed.id);
      if (loaded) await openTray(bookId);
    } catch (err) {
      showToast('Could not load that sketchbook.');
    }
  }
}

// ---------- sketchbooks: a named collection of sketches, with a lateral tray ----------

function updateSketchbookTabState() {
  const inBook = currentSketchBookIds.length > 0;
  sketchbookTab.textContent = inBook ? 'sketchbook' : '+ sketchbook';
  sketchbookTab.classList.toggle('in-book', inBook);
}

sketchbookTab.addEventListener('click', () => {
  if (currentSketchBookIds.length > 0) {
    openTray(currentSketchBookIds[0]);
  } else {
    createBookPopup.hidden = !createBookPopup.hidden;
  }
});

document.addEventListener('pointerdown', (e) => {
  if (createBookPopup.hidden) return;
  if (createBookPopup.contains(e.target) || sketchbookTab.contains(e.target)) return;
  createBookPopup.hidden = true;
});

document.addEventListener('pointerdown', (e) => {
  if (tray.hidden) return;
  if (tray.contains(e.target) || sketchbookTab.contains(e.target)) return;
  tray.hidden = true;
});

createBookBtn.addEventListener('click', async () => {
  // a sketchbook needs a real sketch link to seed from — share this one first if it isn't yet
  if (!currentSketchId) {
    const data = await serializeCanvas();
    if (data.nodes.length === 0) {
      showToast('Nothing on the canvas yet — add a sound or doodle first.');
      return;
    }
    try {
      const res = await fetch('/api/sketch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, name: '' }),
      });
      if (!res.ok) throw new Error('save failed');
      const { id } = await res.json();
      currentSketchId = id;
      history.pushState(null, '', `?sketch=${id}`);
    } catch (err) {
      showToast('Could not share this sketch yet.');
      return;
    }
  }

  const name = bookNameInput.value.trim();
  try {
    const res = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug: name, sketchId: currentSketchId, sketchName: currentSketchName }),
    });
    if (!res.ok) throw new Error('create failed');
    const { id } = await res.json();
    currentSketchBookIds = [id];
    updateSketchbookTabState();
    createBookPopup.hidden = true;
    bookNameInput.value = '';
    // we already know the book's contents (just the seed sketch) — no need to re-fetch it
    showTray(id, { sketches: [{ id: currentSketchId, name: currentSketchName }] });
  } catch (err) {
    showToast('Could not create a sketchbook.');
  }
});

bookNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createBookBtn.click();
});

function showTray(bookId, book) {
  trayLinkInput.value = `${location.origin}${location.pathname}?book=${bookId}`;
  renderTray(bookId, book);
  tray.hidden = false;
}

let trayRequestSeq = 0; // guards against an older, slower fetch overwriting a newer one

async function openTray(bookId) {
  const seq = ++trayRequestSeq;
  try {
    const res = await fetch(`/api/book/${bookId}`);
    if (seq !== trayRequestSeq) return;
    if (!res.ok) {
      showToast('Could not load this sketchbook.');
      return;
    }
    const book = await res.json();
    if (seq !== trayRequestSeq) return;
    showTray(bookId, book);
  } catch (err) {
    if (seq === trayRequestSeq) showToast('Could not load this sketchbook.');
  }
}

function renderTray(bookId, book) {
  trayList.innerHTML = '';

  (book.sketches || []).forEach((sketch, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tray-item';
    item.textContent = sketch.name || `sketch ${i + 1}`;
    if (sketch.id === currentSketchId) item.classList.add('current');
    item.addEventListener('click', () => navigateToSketch(sketch.id));
    trayList.appendChild(item);
  });

  const addItem = document.createElement('button');
  addItem.type = 'button';
  addItem.className = 'tray-item tray-add';
  addItem.textContent = '+ new sketch';
  addItem.addEventListener('click', () => addNewSketchToBook(bookId));
  trayList.appendChild(addItem);
}

async function navigateToSketch(sketchId) {
  if (sketchId === currentSketchId) {
    tray.hidden = true;
    return;
  }
  history.pushState(null, '', `?sketch=${sketchId}`);
  tray.hidden = true;
  await loadSketchById(sketchId);
}

async function addNewSketchToBook(bookId) {
  try {
    const res = await fetch('/api/sketch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [], name: '' }),
    });
    if (!res.ok) throw new Error('create failed');
    const { id } = await res.json();

    const putRes = await fetch(`/api/book/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sketch: { id, name: '' } }),
    });
    if (!putRes.ok) throw new Error('link failed');
    const book = await putRes.json();

    // the new sketch is already known to be empty — no need to re-fetch it, just adopt it directly
    deserializeCanvas({ nodes: [] });
    currentSketchId = id;
    currentSketchName = '';
    currentSketchBookIds = [bookId];
    updateSketchbookTabState();
    history.pushState(null, '', `?sketch=${id}`);
    showTray(bookId, book); // re-render with the new sketch already marked current, instead of closing the tray
  } catch (err) {
    showToast('Could not add a new sketch to this sketchbook.');
  }
}

const pendingObjectSaves = new Map(); // objectId -> timeout handle

function scheduleObjectSave(el) {
  if (isLoadingSketch || !currentSketchId) return;
  const objectId = el.dataset.objectId;
  clearTimeout(pendingObjectSaves.get(objectId));
  pendingObjectSaves.set(objectId, setTimeout(() => saveObject(el), AUTOSAVE_DEBOUNCE_MS));
}

async function saveObject(el) {
  const objectId = el.dataset.objectId;
  pendingObjectSaves.delete(objectId);
  if (!currentSketchId) return;

  const node = await serializeOne(el);
  if (JSON.stringify(node).length > MAX_OBJECT_BYTES) {
    showToast('That is too large to save — try a shorter clip or a smaller file.');
    return;
  }
  try {
    await fetch(`/api/sketch/${currentSketchId}?objectId=${objectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(node),
    });
  } catch (err) {
    showToast('Could not save changes.');
  }
}

async function deleteObjectRemote(objectId) {
  if (!currentSketchId) return;
  clearTimeout(pendingObjectSaves.get(objectId));
  pendingObjectSaves.delete(objectId);
  try {
    await fetch(`/api/sketch/${currentSketchId}?objectId=${objectId}`, { method: 'DELETE' });
  } catch (err) {
    // best-effort — nothing more to do locally if this fails
  }
}

function flushPendingSaves() {
  const pending = Array.from(document.querySelectorAll('.sound-node, .stroke, .text-box, .image-box')).filter((el) =>
    pendingObjectSaves.has(el.dataset.objectId)
  );
  pending.forEach((el) => clearTimeout(pendingObjectSaves.get(el.dataset.objectId)));
  return Promise.all(pending.map((el) => saveObject(el)));
}

// shows the final "here's your link" state — always the last step, never the name-prompt step
function showSharePopup(url) {
  shareNameRow.hidden = true;
  createLinkBtn.hidden = true;
  shareLinkSection.hidden = false;
  shareLinkInput.value = url;
  renameInput.value = currentSketchName;
  sharePopup.hidden = false;
  shareLinkInput.focus();
  shareLinkInput.select();
}

shareBtn.addEventListener('click', async () => {
  if (currentSketchId) {
    await flushPendingSaves();
    showSharePopup(`${location.origin}${location.pathname}?sketch=${currentSketchId}`);
    return;
  }

  // first share: prompt for a name BEFORE creating anything, so it can actually affect the URL
  shareNameRow.hidden = false;
  createLinkBtn.hidden = false;
  shareLinkSection.hidden = true;
  sharePopup.hidden = false;
  shareNameInput.focus();
});

createLinkBtn.addEventListener('click', async () => {
  const data = await serializeCanvas();
  if (data.nodes.length === 0) {
    showToast('Nothing on the canvas yet — add a sound or doodle first.');
    return;
  }
  const tooLarge = data.nodes.some((node) => JSON.stringify(node).length > MAX_OBJECT_BYTES);
  if (tooLarge) {
    showToast('One of these items is too large to share — try a shorter clip or a smaller file.');
    return;
  }

  try {
    const res = await fetch('/api/sketch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, name: shareNameInput.value.trim() }),
    });
    if (!res.ok) throw new Error('save failed');
    const { id } = await res.json();
    currentSketchId = id;
    currentSketchName = shareNameInput.value.trim();
    history.pushState(null, '', `?sketch=${id}`);
    showSharePopup(`${location.origin}${location.pathname}?sketch=${id}`);
  } catch (err) {
    showToast('Could not create a share link.');
  }
});

shareNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createLinkBtn.click();
});

copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
  } catch (err) {
    shareLinkInput.select();
    document.execCommand('copy');
  }
  copyLinkBtn.textContent = 'copied!';
  copyLinkBtn.classList.add('copied');
  setTimeout(() => {
    copyLinkBtn.textContent = 'copy';
    copyLinkBtn.classList.remove('copied');
  }, 1500);
});

renameBtn.addEventListener('click', async () => {
  if (!currentSketchId) return;
  const name = renameInput.value.trim();
  try {
    const res = await fetch(`/api/sketch/${currentSketchId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('rename failed');
    currentSketchName = name;
    if (currentSketchBookIds.length > 0) {
      await fetch(`/api/book/${currentSketchBookIds[0]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renameSketch: { id: currentSketchId, name } }),
      });
    }
    renameBtn.textContent = 'saved!';
    setTimeout(() => {
      renameBtn.textContent = 'save';
    }, 1500);
  } catch (err) {
    showToast('Could not rename this sketch.');
  }
});

renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renameBtn.click();
});

trayCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(trayLinkInput.value);
  } catch (err) {
    trayLinkInput.select();
    document.execCommand('copy');
  }
  trayCopyBtn.textContent = 'copied!';
  trayCopyBtn.classList.add('copied');
  setTimeout(() => {
    trayCopyBtn.textContent = 'copy';
    trayCopyBtn.classList.remove('copied');
  }, 1500);
});

document.addEventListener('pointerdown', (e) => {
  if (sharePopup.hidden) return;
  if (sharePopup.contains(e.target) || shareBtn.contains(e.target)) return;
  sharePopup.hidden = true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSaves();
});

// ---------- play the entire canvas, left to right ----------

const PLAYHEAD_VIEWPORT_FRACTION = 0.25; // keep the playhead 25% in from the left edge while following it

function scrollToShowPlayhead(x) {
  board.scrollLeft = Math.max(0, x - board.clientWidth * PLAYHEAD_VIEWPORT_FRACTION);
}

playAllBtn.addEventListener('click', () => {
  const nodes = Array.from(document.querySelectorAll('.sound-node'));
  if (nodes.length === 0) {
    showToast('Nothing on the canvas yet — record a sound first.');
    return;
  }

  const positioned = nodes
    .map((node) => ({ node, x: parseFloat(node.style.left) }))
    .sort((a, b) => a.x - b.x);

  const originX = positioned[0].x;
  let pending = positioned.length;
  playAllBtn.classList.add('playing');
  board.style.overflow = 'hidden'; // no manual scrolling while the view is following the playhead

  positioned.forEach(({ node, x }) => {
    const delay = ((x - originX) / CANVAS_PIXELS_PER_SECOND) * 1000;
    setTimeout(() => {
      Promise.resolve(node.triggerSound()).then(() => {
        pending--;
        if (pending === 0) {
          playAllBtn.classList.remove('playing');
          board.style.overflow = '';
        }
      });
    }, delay);
  });

  if (playheadRAF) cancelAnimationFrame(playheadRAF);
  const playbackStart = performance.now();
  playheadEl.style.left = `${originX}px`;
  playheadEl.classList.add('active');
  scrollToShowPlayhead(originX);

  function stepPlayhead() {
    const elapsedSeconds = (performance.now() - playbackStart) / 1000;
    const x = originX + elapsedSeconds * CANVAS_PIXELS_PER_SECOND;
    playheadEl.style.left = `${x}px`;
    scrollToShowPlayhead(x);
    if (pending > 0) {
      playheadRAF = requestAnimationFrame(stepPlayhead);
    } else {
      playheadEl.classList.remove('active');
      playheadRAF = null;
    }
  }
  playheadRAF = requestAnimationFrame(stepPlayhead);
});

// ---------- toast ----------

let toastTimeout = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.hidden = true;
  }, 3500);
}

// ---------- startup ----------

loadSketchFromURL();
