const path = require('path')
const fs = require('fs')

const DB_FILE = path.join(__dirname, 'data', 'crm-db.json')
const DATA_DIR = path.dirname(DB_FILE)

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } catch { return {} }
}

function save(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data)) } catch (e) { console.error('[DB] Erro ao salvar:', e.message) }
}

module.exports = {
  getState:    (key)        => { const d = load(); return d[key] ?? null },
  setState:    (key, value) => { const d = load(); d[key] = value; save(d) },
  deleteState: (key)        => { const d = load(); delete d[key]; save(d) },
}
