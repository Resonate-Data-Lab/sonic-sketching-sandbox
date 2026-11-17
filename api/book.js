import { createBook } from '../lib/book-store.js';
import { addBookToSketch } from '../lib/sketch-store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, slug, sketchId, sketchName } = req.body || {};
  if (!sketchId || typeof sketchId !== 'string') {
    return res.status(400).json({ error: 'Missing sketchId' });
  }

  try {
    const id = await createBook({ name, slug, sketch: { id: sketchId, name: sketchName || '' } });
    await addBookToSketch(sketchId, id);
    return res.status(201).json({ id });
  } catch (err) {
    console.error('Failed to create sketchbook', err);
    return res.status(500).json({ error: 'Could not create sketchbook' });
  }
}
