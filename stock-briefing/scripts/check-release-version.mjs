import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let root;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const releasePath = 'stock-briefing/app/src/releaseVersion.json';
const nativePath = 'stock-briefing/app/app.json';
function parts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('배포 버전은 1.5.1과 같은 세 자리 숫자여야 합니다.');
  const values = version.split('.').map(Number);
  if (!values.every(Number.isSafeInteger)) throw new Error('배포 버전 숫자가 너무 큽니다.');
  return values;
}
function compare(a, b) {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function productFile(file) {
  // 검사용 코드·문서 수정만으로 새 제품 버전을 요구하지 않는다.
  return /^(stock-briefing\/(app\/(src|assets|plugins)|backend\/(src|prompts)|shared)\/)/.test(file)
    || /^(Dockerfile|\.dockerignore|railway\.json)$/.test(file)
    || /^stock-briefing\/(app|backend)\/(package(-lock)?\.json|app\.json|app\.config\.[cm]?[jt]s|eas\.json|babel\.config\.[cm]?js|metro\.config\.[cm]?js|tsconfig\.json)$/.test(file);
}
try {
  root = git('rev-parse', '--show-toplevel');
  const current = JSON.parse(readFileSync(join(root, releasePath), 'utf8')).version;
  const native = JSON.parse(readFileSync(join(root, nativePath), 'utf8')).expo.version;
  if (compare(current, native) < 0) throw new Error('앱 배포 버전이 설치 기반 버전보다 낮습니다.');
  const base = process.argv[2] || process.env.BASE_SHA;
  if (!base) {
    console.log(`배포 버전 ${current}: 형식 확인. 비교 커밋이 없어 증가 여부는 검사하지 않았습니다.`);
  } else {
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('비교할 Git 커밋 번호를 확인해 주세요.');
    git('rev-parse', '--verify', `${base}^{commit}`);
    const existed = git('ls-tree', '--name-only', base, '--', releasePath).length > 0;
    const previous = existed ? JSON.parse(git('show', `${base}:${releasePath}`)).version : JSON.parse(git('show', `${base}:${nativePath}`)).expo.version;
    const changed = git('diff', '--name-only', base, '--').split(/\r?\n/).filter(Boolean);
    const comparison = compare(current, previous);
    if (comparison < 0) throw new Error(`배포 버전이 ${previous}에서 ${current}로 내려갔습니다.`);
    if (changed.some(productFile) && comparison <= 0) throw new Error(`제품 수정본의 버전 ${current}이 이전과 같습니다. ${releasePath}의 버전을 올려 주세요.`);
    console.log(`배포 버전 검사 통과: ${previous} → ${current}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '배포 버전 검사 실패');
  process.exitCode = 1;
}
