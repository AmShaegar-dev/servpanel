'use strict';

/*
 * Сборка релиза Servpanel.
 *
 *   node scripts/build-release.js [--out dist] [--no-node-modules]
 *
 * Результат:
 *   dist/servpanel-<version>/                  — распакованный релиз
 *   dist/servpanel-<version>.tar.gz            — архив для панели/upgrade.sh
 *   dist/servpanel-<version>.tar.gz.sha256     — контрольная сумма
 *
 * В релиз НЕ попадают данные панели (.secrets.json, admin_pass.txt,
 * .sessions, журналы) — обновление не должно их перезаписывать.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(outArg >= 0 && args[outArg + 1] ? args[outArg + 1] : path.join(ROOT, 'dist'));
const WITH_NM = !args.includes('--no-node-modules');

const ITEMS = [
    'server.js', 'package.json', 'package-lock.json',
    'public', 'lib', 'tests', 'demo',
    'README.md', 'DEMO.md', 'ИЗМЕНЕНИЯ.md', 'ОБНОВЛЕНИЕ-2.4.md',
    'install.sh', 'install_adguard_silent.sh', 'install_awg_stateful.sh',
    'update.sh', 'upgrade.sh', 'LICENSE', '.gitignore'
];
const FORBIDDEN = new Set([
    'admin_pass.txt', '.secrets.json', '.users.json', '.panel_port', '.panel_public_port',
    '.obf_profiles.json', '.notify.json', '.backup.json', '.backup_pass',
    '.install_state.json', '.sessions', 'awg_audit.log', 'servpanel_auth.log'
]);

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.isFile()) out.push(p);
    }
    return out;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const STAGE = path.join(OUT, `servpanel-${pkg.version}`);
fs.mkdirSync(STAGE, { recursive: true });

for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
        console.warn('пропуск (нет файла):', item);
        continue;
    }
    fs.cpSync(src, path.join(STAGE, item), { recursive: true, force: true });
}
if (WITH_NM && fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fs.cpSync(path.join(ROOT, 'node_modules'), path.join(STAGE, 'node_modules'), { recursive: true, force: true });
}

// Никаких данных панели в релизе.
for (const bad of FORBIDDEN) {
    const p = path.join(STAGE, bad);
    if (fs.existsSync(p)) throw new Error('В релиз попал файл данных: ' + bad);
}
for (const required of ['server.js', 'package.json', 'public/index.html', 'public/style.css', 'public/app.js', 'lib/update-worker.js']) {
    if (!fs.existsSync(path.join(STAGE, required))) throw new Error('В релизе нет ' + required);
}
if (WITH_NM && !fs.existsSync(path.join(STAGE, 'node_modules', 'qrcode'))) {
    throw new Error('В node_modules нет qrcode');
}

const files = walk(STAGE)
    .map(p => ({ path: path.relative(STAGE, p).replace(/\\/g, '/'), sha256: sha256(p), size: fs.statSync(p).size }))
    .sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    nodeModules: WITH_NM,
    files: files.length,
    bytes: files.reduce((s, f) => s + f.size, 0),
    checksums: files
};
fs.writeFileSync(path.join(STAGE, 'release.json'), JSON.stringify(manifest, null, 2));

const archive = path.join(OUT, `servpanel-${pkg.version}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', OUT, `servpanel-${pkg.version}`], { stdio: 'inherit' });
const sum = sha256(archive);
fs.writeFileSync(archive + '.sha256', `${sum}  ${path.basename(archive)}\n`);

console.log('');
console.log('Релиз:', archive);
console.log('Размер:', (fs.statSync(archive).size / 1024 / 1024).toFixed(2), 'МБ');
console.log('SHA256:', sum);
console.log('Файлов:', files.length, '; node_modules:', WITH_NM ? 'да' : 'нет');
