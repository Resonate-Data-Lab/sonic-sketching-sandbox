// --- sonic sketch: record a sound, drag it around, play it back ---

const board = document.getElementById('board');
const recordBtn = document.getElementById('recordBtn');
const recordIcon = recordBtn.querySelector('.icon');
const playAllBtn = document.getElementById('playAllBtn');
const timerEl = document.getElementById('timer');
const toastEl = document.getElementById('toast');

const CANVAS_PIXELS_PER_SECOND = 140;

let mediaRecorder = null;
let activeStream = null;
let chunks = [];
let isRecording = false;
let recordStartTime = 0;
let timerHandle = null;
let spawnIndex = 0;

// ---------- feature check ----------

const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
if (!supported) {
  recordBtn.disabled = true;
  showToast("This browser can't record audio here. Try a recent Chrome, Firefox, Edge, or Safari.");
}

// ---------- recording ----------

recordBtn.addEventListener('click', () => {
  if (!supported) return;
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

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

  const note = document.createElement('div');
  note.className = 'note';
  note.contentEditable = 'true';
  note.setAttribute('data-placeholder', 'add a note…');
  note.spellcheck = false;

  const bars = document.createElement('div');
  bars.className = 'bars';

  node.append(play, del, bars, note);
  board.appendChild(node);

  wireUpNode(node, del, note, bars);
}

function wireUpNode(node, del, note, bars) {
  let dragging = false;
  let moved = false;
  let start = { x: 0, y: 0 };
  let origin = { left: 0, top: 0 };
  let activePlays = 0;

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
    const finish = () => {
      bar.remove();
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

  node.addEventListener('pointerdown', (e) => {
    if (del.contains(e.target) || note.contains(e.target)) return;
    dragging = true;
    moved = false;
    start = { x: e.clientX, y: e.clientY };
    origin = { left: parseFloat(node.style.left), top: parseFloat(node.style.top) };
    node.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (moved) {
      node.style.left = `${origin.left + dx}px`;
      node.style.top = `${origin.top + dy}px`;
    }
  });

  node.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (!moved) trigger();
  });

  // keep clicks/typing in the note or the delete button from starting a drag or a play
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    URL.revokeObjectURL(node.dataset.url);
    node.remove();
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
