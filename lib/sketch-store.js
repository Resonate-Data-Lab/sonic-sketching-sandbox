import { put, get, del, list } from '@vercel/blob';
import { randomBytes } from 'crypto';

const PREFIX = 'sketches/';

export function generateId() {
  return randomBytes(8).toString('base64url');
}

function metaPathFor(sketchId) {
  return `${PREFIX}${sketchId}/meta.json`;
}

function objectPathFor(sketchId, objectId) {
  return `${PREFIX}${sketchId}/objects/${objectId}.json`;
}

function objectsPrefixFor(sketchId) {
  return `${PREFIX}${sketchId}/objects/`;
}

async function readJsonBlob(pathname) {
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export async function sketchExists(sketchId) {
  const result = await get(metaPathFor(sketchId), { access: 'private' });
  return !!result;
}

export async function createSketch(nodes) {
  const sketchId = generateId();
  await put(metaPathFor(sketchId), JSON.stringify({ version: 1, createdAt: Date.now() }), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  await Promise.all(nodes.map((node) => writeObject(sketchId, node)));
  return sketchId;
}

export async function readSketch(sketchId) {
  const { blobs } = await list({ prefix: objectsPrefixFor(sketchId) });
  const nodes = await Promise.all(blobs.map((blob) => readJsonBlob(blob.pathname)));
  return { version: 1, nodes: nodes.filter(Boolean) };
}

export async function writeObject(sketchId, node) {
  const body = JSON.stringify(node);
  await put(objectPathFor(sketchId, node.id), body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function deleteObject(sketchId, objectId) {
  await del(objectPathFor(sketchId, objectId));
}
