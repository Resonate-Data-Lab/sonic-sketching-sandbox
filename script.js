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
const textBtn = document.getElementById('textBtn');
const drawPreview = document.getElementById('drawPreview');
const shareBtn = document.getElementById('shareBtn');
const sharePopup = document.getElementById('sharePopup');
const shareLinkInput = document.getElementById('shareLink');
const copyLinkBtn = document.getElementById('copyLinkBtn');

const SVG_NS = 'http://www.w3.org/2000/svg';
const CANVAS_PIXELS_PER_SECOND = 140;
const DRAG_THRESHOLD = 4;
const AUTOSAVE_DEBOUNCE_MS = 1500;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024; // stay under Vercel's 4.5MB function body limit, per object

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

// a focused note (contenteditable) otherwise never loses focus when you click
// away from it, since sound nodes/strokes/the board aren't themselves focusable —
// that stale focus would otherwise silently swallow Delete/Cmd+C/Cmd+V as "typing"
document.addEventListener('pointerdown', (e) => {
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains('note') && !active.contains(e.target)) {
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
          return { type: 'sound', relX, relY, blob, noteText: note ? note.textContent : '' };
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
        return node;
      }
      if (item.type === 'stroke') {
        return createStrokeElement(x, y, item.width, item.height, item.pathD);
      }
      if (item.type === 'text') {
        return createTextElement(x, y, item.text);
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
        item.style.left = `${left + dx}px`;
        item.style.top = `${top + dy}px`;
      });
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (moved) {
      clearSelection();
      dragGroup.forEach((item) => scheduleObjectSave(item));
    } else if (onClick) {
      onClick();
    }
  });
}

// ---------- sound nodes: draggable, playable, annotatable ----------

function createSoundNode(x, y, url, id) {
  const node = document.createElement('div');
  node.className = 'sound-node';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.dataset.url = url;
  node.dataset.objectId = id || crypto.randomUUID();

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
  scheduleObjectSave(node);
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

  // shared by the "x" button and the Delete/Backspace key on a selection
  node.deleteObject = () => {
    activeAudios.forEach((audio) => audio.pause());
    URL.revokeObjectURL(node.dataset.url);
    deleteObjectRemote(node.dataset.objectId);
    node.remove();
  };

  makeDraggable(node, { onClick: trigger });

  // keep clicks/typing in the note, delete, or duplicate controls from starting a drag or a play
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
    document.querySelectorAll('.sound-node, .stroke, .text-box').forEach((item) => {
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
  board.appendChild(strokeEl);

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
  board.appendChild(el);

  el.deleteObject = () => {
    deleteObjectRemote(el.dataset.objectId);
    el.remove();
  };

  makeDraggable(el);

  content.addEventListener('pointerdown', (e) => e.stopPropagation());
  content.addEventListener('click', (e) => e.stopPropagation());
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
    };
  }

  if (el.classList.contains('text-box')) {
    const content = el.querySelector('.text-content');
    return { id, type: 'text', x, y, text: content ? content.textContent : '' };
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
  const elements = Array.from(document.querySelectorAll('.sound-node, .stroke, .text-box'));
  const nodes = await Promise.all(elements.map((el) => serializeOne(el)));
  return { version: 1, nodes };
}

function deserializeCanvas(data) {
  document.querySelectorAll('.sound-node, .stroke, .text-box').forEach((el) => el.remove());

  const nodes = (data && data.nodes) || [];
  nodes.forEach((n) => {
    if (n.type === 'sound') {
      const blob = base64ToBlob(n.audio.base64, n.audio.mimeType);
      const url = URL.createObjectURL(blob);
      const node = createSoundNode(n.x, n.y, url, n.id);
      node.style.transform = `rotate(${n.rotation || 0}deg)`;
      const note = node.querySelector('.note');
      if (note) note.textContent = n.note || '';
    } else if (n.type === 'stroke') {
      createStrokeElement(n.x, n.y, n.width, n.height, n.pathD, n.id);
    } else if (n.type === 'text') {
      createTextElement(n.x, n.y, n.text, n.id);
    }
  });

  // reduce (not fully eliminate) new objects landing on top of restored ones
  spawnIndex = nodes.length;
}

// ---------- sharing: save to a link, load from a link, per-object autosave ----------

async function loadSketchFromURL() {
  const id = new URLSearchParams(location.search).get('sketch');
  if (!id) return;

  isLoadingSketch = true;
  try {
    const res = await fetch(`/api/sketch/${id}`);
    if (!res.ok) {
      showToast("That sketch link doesn't exist anymore.");
      return;
    }
    const data = await res.json();
    deserializeCanvas(data);
    currentSketchId = id;
  } catch (err) {
    showToast('Could not load that sketch.');
  } finally {
    isLoadingSketch = false;
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
    showToast('That recording is too large to save — try a shorter clip.');
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
  const pending = Array.from(document.querySelectorAll('.sound-node, .stroke, .text-box')).filter((el) =>
    pendingObjectSaves.has(el.dataset.objectId)
  );
  pending.forEach((el) => clearTimeout(pendingObjectSaves.get(el.dataset.objectId)));
  return Promise.all(pending.map((el) => saveObject(el)));
}

function showSharePopup(url) {
  shareLinkInput.value = url;
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

  const data = await serializeCanvas();
  if (data.nodes.length === 0) {
    showToast('Nothing on the canvas yet — add a sound or doodle first.');
    return;
  }
  const tooLarge = data.nodes.some((node) => JSON.stringify(node).length > MAX_OBJECT_BYTES);
  if (tooLarge) {
    showToast('One of these recordings is too large to share — try a shorter clip.');
    return;
  }

  try {
    const res = await fetch('/api/sketch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('save failed');
    const { id } = await res.json();
    currentSketchId = id;
    history.pushState(null, '', `?sketch=${id}`);
    showSharePopup(`${location.origin}${location.pathname}?sketch=${id}`);
  } catch (err) {
    showToast('Could not create a share link.');
  }
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

document.addEventListener('pointerdown', (e) => {
  if (sharePopup.hidden) return;
  if (sharePopup.contains(e.target) || shareBtn.contains(e.target)) return;
  sharePopup.hidden = true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSaves();
});

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

// ---------- startup ----------

loadSketchFromURL();
