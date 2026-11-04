import { put, list } from '@vercel/blob';
import { randomBytes } from 'crypto';

const PREFIX = 'sketches/';

export function generateId() {
  return randomBytes(8).toString('base64url');
}

function pathFor(id) {
  return `${PREFIX}${id}.json`;
}

export async function findSketchBlob(id) {
  const { blobs } = await list({ prefix: pathFor(id), limit: 1 });
  return blobs[0] || null;
}

export async function readSketch(id) {
  const blob = await findSketchBlob(id);
  if (!blob) return null;
  const response = await fetch(blob.url);
  if (!response.ok) return null;
  return response.json();
}

export async function writeSketch(id, data) {
  const body = JSON.stringify({ ...data, version: 1 });
  await put(pathFor(id), body, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}
