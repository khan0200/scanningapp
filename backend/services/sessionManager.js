const fs = require('fs');
const path = require('path');

const TEMP_SESSION_DIR = path.join(__dirname, '../temp_session');

// Ensure temp_session folder exists
function ensureTempDir() {
  if (!fs.existsSync(TEMP_SESSION_DIR)) {
    fs.mkdirSync(TEMP_SESSION_DIR, { recursive: true });
  }
}

/**
 * Save / Sync current session pages to disk
 */
function saveSession(pages = []) {
  ensureTempDir();
  const sessionFile = path.join(TEMP_SESSION_DIR, 'session.json');
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(pages, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[SessionManager Save Error]:', err);
    return false;
  }
}

/**
 * Load temporary session pages from disk
 */
function loadSession() {
  ensureTempDir();
  const sessionFile = path.join(TEMP_SESSION_DIR, 'session.json');
  try {
    if (fs.existsSync(sessionFile)) {
      const data = fs.readFileSync(sessionFile, 'utf8');
      return JSON.parse(data) || [];
    }
  } catch (err) {
    console.error('[SessionManager Load Error]:', err);
  }
  return [];
}

/**
 * Clear temporary session directory
 */
function clearSession() {
  ensureTempDir();
  try {
    const files = fs.readdirSync(TEMP_SESSION_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(TEMP_SESSION_DIR, file));
    }
    return true;
  } catch (err) {
    console.error('[SessionManager Clear Error]:', err);
    return false;
  }
}

module.exports = {
  saveSession,
  loadSession,
  clearSession
};
