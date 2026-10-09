import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const checker = fileURLToPath(new URL('./check-release-version.mjs', import.meta.url));
const release = 'stock-briefing/app/src/releaseVersion.json';
const native = 'stock-briefing/app/app.json';
function fixture(run, legacy = false) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'stock-version-check-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => { const target = join(dir, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); };
  const version = value => write(release, JSON.stringify({ version: value }));
  try {
    git('init'); git('config', 'user.name', '버전 검사'); git('config', 'user.email', 'version-test@example.invalid'); git('config', 'commit.gpgsign', 'false');
    write(native, JSON.stringify({ expo: { version: '1.5.0' } }));
    write('stock-briefing/app/src/example.ts', '기존 화면');
    write('stock-briefing/backend/src/example.ts', '기존 서버');
    write('notes.md', '기존 문서');
    if (!legacy) version('1.5.1');
    git('add', '.'); git('commit', '-m', '검사 기준');
    const base = git('rev-parse', 'HEAD');
    const check = (relative = '.') => spawnSync(process.execPath, [checker, base], { cwd: join(dir, relative), encoding: 'utf8', windowsHide: true });
    run({ write, version, check });
  } finally {
    // 이 검사에서 만든 임시 폴더만 지운다.
    const target = realpathSync(dir);
    if (!target.startsWith(resolve(parent) + '\\stock-version-check-') && !target.startsWith(resolve(parent) + '/stock-version-check-')) throw new Error('임시 검사 경로 확인 실패');
    rmSync(target, { recursive: true, force: true });
  }
}
test('화면 수정인데 버전을 그대로 두면 실패', () => fixture(({ write, check }) => {
  write('stock-briefing/app/src/example.ts', '수정 화면'); const r = check(); assert.equal(r.status, 1); assert.match(r.stderr, /이전과 같습니다/);
}));
test('서버만 바꿔도 버전을 올려야 함', () => fixture(({ write, check }) => {
  write('stock-briefing/backend/src/example.ts', '수정 서버'); assert.equal(check().status, 1);
}));
test('CI처럼 앱 폴더에서 실행해도 버전 누락을 차단', () => fixture(({ write, check }) => {
  write('stock-briefing/app/src/example.ts', '수정 화면'); assert.equal(check('stock-briefing/app').status, 1);
}));
test('수정본과 함께 버전을 올리면 통과', () => fixture(({ write, version, check }) => {
  write('stock-briefing/app/src/example.ts', '수정 화면'); version('1.5.2'); assert.equal(check().status, 0);
}));
test('문서만 바꾸면 같은 버전 허용', () => fixture(({ write, check }) => { write('notes.md', '수정 문서'); assert.equal(check().status, 0); }));
test('과거 설치 번호에서 첫 배포 번호로 전환', () => fixture(({ write, version, check }) => {
  write('stock-briefing/app/src/example.ts', '새 버전 화면'); version('1.5.1'); assert.equal(check().status, 0);
}, true));
test('버전 하락과 잘못된 문자열은 거부', () => fixture(({ version, check }) => {
  for (const value of ['1.4.9', '1.05.2', 'invalid']) { version(value); assert.equal(check().status, 1); }
}));
