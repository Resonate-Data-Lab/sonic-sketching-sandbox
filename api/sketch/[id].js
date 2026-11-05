import { readSketch, writeObject, deleteObject, sketchExists } from '../../lib/sketch-store.js';

export default async function handler(req, res) {
  const { id, objectId } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing sketch id' });
  }

  if (req.method === 'GET' && !objectId) {
    const exists = await sketchExists(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const data = await readSketch(id);
    return res.status(200).json(data);
  }

  if (req.method === 'PUT' && objectId) {
    const exists = await sketchExists(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });

    const data = req.body;
    if (!data || !['sound', 'stroke', 'text'].includes(data.type)) {
      return res.status(400).json({ error: 'Expected a sound, stroke, or text object' });
    }

    try {
      await writeObject(id, { ...data, id: objectId });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Failed to save object', err);
      return res.status(500).json({ error: 'Could not save object' });
    }
  }

  if (req.method === 'DELETE' && objectId) {
    try {
      await deleteObject(id, objectId);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Failed to delete object', err);
      return res.status(500).json({ error: 'Could not delete object' });
    }
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
