// Runs INSIDE the load-test container (has better-sqlite3 + the test DB at $DB_PATH).
// Seeds N throwaway users directly into the DB (skips bcrypt + the auth rate limiter), each with a fake
// discord_id so the bot pairing endpoint can find them. Writes /data/users.json for the host driver.
const Database = require('better-sqlite3');
const fs = require('fs');
const DB = process.env.DB_PATH || '/data/mmd-loadtest.db';
const N = parseInt(process.env.SEED_USERS || '1000', 10);
const db = new Database(DB);
const ins  = db.prepare("INSERT OR IGNORE INTO users (username,email,password) VALUES (?,?,?)");
const setd = db.prepare("UPDATE users SET discord_id=?, discord_name=? WHERE username=?");
const get  = db.prepare("SELECT id,username,discord_id FROM users WHERE username=?");
const tx = db.transaction(() => {
  for (let i = 0; i < N; i++) { const u = 'lt_' + i; ins.run(u, u + '@loadtest.local', 'x'); setd.run('L' + i, u, u); }
});
tx();
const users = [];
for (let i = 0; i < N; i++) { const r = get.get('lt_' + i); users.push({ id: r.id, username: r.username, discord: r.discord_id }); }
fs.writeFileSync('/data/users.json', JSON.stringify(users));
console.log('seeded ' + users.length + ' users -> /data/users.json (ids ' + users[0].id + '..' + users[users.length-1].id + ')');
