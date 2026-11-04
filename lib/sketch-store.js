import { put, get } from '@vercel/blob';
import { randomBytes } from 'crypto';

const PREFIX = 'sketches/';

export function generateId() {
  return randomBytes(8).toString('base64url');
}

function pathFor(id) {
  return `${PREFIX}${id}.json`;
}

export async function sketchExists(id) {
  const result = await get(pathFor(id), { access: 'private' });
  return !!result;
}

export async function readSketch(id) {
  const result = await get(pathFor(id), { access: 'private' });
  if (!result || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export async function writeSketch(id, data) {
  const body = JSON.stringify({ ...data, version: 1 });
  await put(pathFor(id), body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}
