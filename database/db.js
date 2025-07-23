//db.js
const fs = require('fs');

const dbFile = 'db.json';

// Инициализация базы данных
function initDB() {
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({ owners: [], employees: [], taskSessions: [] }));
  }
}

// Загрузка данных из базы
function loadDB() {
  try {
    const raw = fs.readFileSync(dbFile, 'utf-8');
    if (!raw.trim()) {
      // Файл пустой — вернуть дефолтную структуру
      return { owners: [], employees: [], taskSessions: [], taskHistory: [] };
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load DB:', err.message);
    // Возвращаем пустую базу данных как fallback
    return { owners: [], employees: [], taskSessions: [], taskHistory: [] };
  }
}

// Сохранение данных в базу
function saveDB(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

module.exports = {
  initDB,
  loadDB,
  saveDB
};