// Somo BNPL — minimal server
// Serves the static frontend (public/) and a tiny key-value REST API that the
// frontend's storage polyfill talks to, replacing Claude.ai's artifact-only
// window.storage with a real shared, persistent store.
//
// Data is kept in a single JSON file (data/store.json). That's intentionally
// simple — no database server to install — but it means:
//   - only one server process should run against a given data file at a time
//   - back up data/store.json regularly (it's the entire system's data)
// For a larger deployment, swap loadStore()/saveStore() for a real database.

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write to a temp file then rename, so a crash mid-write can't corrupt the store.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
}

const app = express();
app.use(express.json({ limit: '10mb' })); // logos are base64 images, keep headroom
app.use(express.static(path.join(__dirname, 'public')));

// List keys (optionally filtered by prefix)
app.get('/api/storage', (req, res) => {
  const store = loadStore();
  const prefix = req.query.prefix || '';
  const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
  res.json({ keys, prefix: req.query.prefix || undefined, shared: true });
});

// Get one value
app.get('/api/storage/:key', (req, res) => {
  const store = loadStore();
  const key = req.params.key;
  if (!(key in store)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: store[key], shared: true });
});

// Set one value
app.post('/api/storage/:key', (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a JSON string' });
  }
  const store = loadStore();
  store[key] = value;
  saveStore(store);
  res.json({ key, value, shared: true });
});

// Delete one value
app.delete('/api/storage/:key', (req, res) => {
  const key = req.params.key;
  const store = loadStore();
  const existed = key in store;
  delete store[key];
  saveStore(store);
  res.json({ key, deleted: existed, shared: true });
});

app.listen(PORT, () => {
  console.log(`Somo BNPL server listening on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
