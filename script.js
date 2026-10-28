// --- sonic sketch: record a sound, drag it around, play it back ---

const board = document.getElementById('board');
const recordBtn = document.getElementById('recordBtn');
const recordIcon = recordBtn.querySelector('.icon');
const playAllBtn = document.getElementById('playAllBtn');
const playheadEl = document.getElementById('playhead');
const timerEl = document.getElementById('timer');
const toastEl = document.getElementById('toast');
const addMenu = document.getElementById('addMenu');
const fileInput = document.getElementById('fileInput');
const penBtn = document.getElementById('penBtn');
const drawPreview = document.getElementById('drawPreview');

const SVG_NS = 'http://www.w3.org/2000/svg';
const CANVAS_PIXELS_PER_SECOND = 140;
const DRAG_THRESHOLD = 4;

let mode = 'pointer'; // 'pointer' | 'pen'

let mediaRecorder = null;
let activeStream = null;
let chunks = [];
let isRecording = false;
let recordStartTime = 0;
let timerHandle = null;
let spawnIndex = 0;
let playheadRAF = null;

// ---------- feature check ----------

const micSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

// ---------- the "+" popover: record or upload ----------

recordBtn.addEventListener('click', () => {
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
  recordIcon.textContent = '■';
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
  recordIcon.textContent = '+';
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

// ---------- placing new sounds near the button ----------

function nextSpawnPosition() {
  const origin = { x: 150, y: 110 };
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

function makeDraggable(el, { onClick } = {}) {
  let dragging = false;
  let moved = false;
  let start = { x: 0, y: 0 };
  let startPositions = [];

  el.addEventListener('pointerdown', (e) => {
    if (mode !== 'pointer') return;
    e.stopPropagation();
    e.preventDefault();

    if (!el.classList.contains('selected')) {
      clearSelection();
      el.classList.add('selected');
    }

    dragging = true;
    moved = false;
    start = { x: e.clientX, y: e.clientY };
    startPositions = Array.from(document.querySelectorAll('.selected')).map((item) => ({
      item,
      left: parseFloat(item.style.left),
      top: parseFloat(item.style.top),
    }));
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
    if (moved) {
      startPositions.forEach(({ item, left, top }) => {
        item.style.left = `${left + dx}px`;
        item.style.top = `${top + dy}px`;
      });
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!moved && onClick) onClick();
  });
}

// ---------- sound nodes: draggable, playable, annotatable ----------

function createSoundNode(x, y, url) {
  const node = document.createElement('div');
  node.className = 'sound-node';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.dataset.url = url;

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

  const note = document.createElement('div');
  note.className = 'note';
  note.contentEditable = 'true';
  note.setAttribute('data-placeholder', 'add a note…');
  note.spellcheck = false;

  const bars = document.createElement('div');
  bars.className = 'bars';

  node.append(play, del, dup, bars, note);
  board.appendChild(node);

  wireUpNode(node, del, dup, note, bars);
  return node;
}

function wireUpNode(node, del, dup, note, bars) {
  let activePlays = 0;
  const activeAudios = [];

  function trigger() {
    activePlays++;
    node.classList.add('playing');

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    bar.appendChild(fill);
    bars.appendChild(bar);

    const audio = new Audio(node.dataset.url);
    activeAudios.push(audio);
    const finish = () => {
      bar.remove();
      activeAudios.splice(activeAudios.indexOf(audio), 1);
      activePlays = Math.max(0, activePlays - 1);
      if (activePlays === 0) node.classList.remove('playing');
    };

    audio.addEventListener('timeupdate', () => {
      if (audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    });

    return new Promise((resolve) => {
      audio.addEventListener('ended', () => {
        finish();
        resolve();
      });
      audio.play().catch(() => {
        finish();
        resolve();
      });
    });
  }

  // let the "play entire canvas" feature trigger this node the same way a click does
  node.triggerSound = trigger;

  makeDraggable(node, { onClick: trigger });

  // keep clicks/typing in the note, delete, or duplicate controls from starting a drag or a play
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    activeAudios.forEach((audio) => audio.pause());
    URL.revokeObjectURL(node.dataset.url);
    node.remove();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    duplicateNode(node, note);
  });

  note.addEventListener('pointerdown', (e) => e.stopPropagation());
  note.addEventListener('click', (e) => e.stopPropagation());
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
  e.preventDefault();
  const keepSelected = e.shiftKey ? new Set(document.querySelectorAll('.selected')) : new Set();
  if (!e.shiftKey) clearSelection();

  const startX = e.clientX;
  const startY = e.clientY;
  const box = document.createElement('div');
  box.className = 'marquee';
  board.appendChild(box);

  function updateBox(cx, cy) {
    const x = Math.min(startX, cx);
    const y = Math.min(startY, cy);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    return { left: x, top: y, right: x + w, bottom: y + h };
  }

  function applySelection(rect) {
    document.querySelectorAll('.sound-node, .stroke').forEach((item) => {
      const r = item.getBoundingClientRect();
      const intersects = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
      item.classList.toggle('selected', intersects || keepSelected.has(item));
    });
  }

  applySelection(updateBox(startX, startY));

  function onMove(ev) {
    applySelection(updateBox(ev.clientX, ev.clientY));
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    box.remove();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function pointsToPathData(points, offsetX, offsetY) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x - offsetX} ${p.y - offsetY}`).join(' ');
}

function startStroke(e) {
  e.preventDefault();
  const points = [{ x: e.clientX, y: e.clientY }];
  const previewPath = document.createElementNS(SVG_NS, 'path');
  previewPath.setAttribute('d', pointsToPathData(points, 0, 0));
  drawPreview.appendChild(previewPath);

  function onMove(ev) {
    points.push({ x: ev.clientX, y: ev.clientY });
    previewPath.setAttribute('d', pointsToPathData(points, 0, 0));
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    previewPath.remove();
    finalizeStroke(points);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
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

function createStrokeElement(left, top, width, height, pathD) {
  const strokeEl = document.createElement('div');
  strokeEl.className = 'stroke';
  strokeEl.style.left = `${left}px`;
  strokeEl.style.top = `${top}px`;
  strokeEl.style.width = `${width}px`;
  strokeEl.style.height = `${height}px`;

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
  board.appendChild(strokeEl);

  makeDraggable(strokeEl);

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    strokeEl.remove();
  });

  dup.addEventListener('pointerdown', (e) => e.stopPropagation());
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    const currentLeft = parseFloat(strokeEl.style.left) + 30;
    const currentTop = parseFloat(strokeEl.style.top) + 30;
    createStrokeElement(currentLeft, currentTop, width, height, pathD);
  });

  return strokeEl;
}

// ---------- play the entire canvas, left to right ----------

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

  positioned.forEach(({ node, x }) => {
    const delay = ((x - originX) / CANVAS_PIXELS_PER_SECOND) * 1000;
    setTimeout(() => {
      Promise.resolve(node.triggerSound()).then(() => {
        pending--;
        if (pending === 0) playAllBtn.classList.remove('playing');
      });
    }, delay);
  });

  if (playheadRAF) cancelAnimationFrame(playheadRAF);
  const playbackStart = performance.now();
  playheadEl.style.left = `${originX}px`;
  playheadEl.classList.add('active');

  function stepPlayhead() {
    const elapsedSeconds = (performance.now() - playbackStart) / 1000;
    playheadEl.style.left = `${originX + elapsedSeconds * CANVAS_PIXELS_PER_SECOND}px`;
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
