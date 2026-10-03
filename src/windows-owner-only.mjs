import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Windowsで「本人・SYSTEM・Administratorsだけが触れる」ことを確かめる（ADR 0194）。
 *
 * POSIXのmode・uidに当たるものがWindowsには無いので、DACL（誰に何を許すかの一覧）を読む。
 * - 読み方は`icacls <path> /save <file>`。SDDLという、表示言語に依らない形で返る。
 *   `icacls <path>`の画面表示は名前が表示言語で変わるので使わない。
 * - 自分のSIDは`whoami /user`で得る。どちらも`%SystemRoot%\System32`の実物を絶対pathで呼ぶ
 *   ——PATHに置かれた同名のprogramへ答えを作らせない。
 * - 所有者は読まない（`icacls`は返さない）。空のフォルダを絞る時に所有者を本人へ替える。
 */

const SELF_SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const COMMAND_TIMEOUT_MS = 10_000;
// `icacls /save`の出力fileの名前。フォルダが空かを見る時、同時に走る別processのこのfileは数えない。
const SCRATCH_NAME = /^\.acl-\d+-[0-9a-f]{12}$/;

let cachedSelfSid = null;

function systemTool(name, env = process.env) {
  return join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', name);
}

function run(tool, args) {
  const result = spawnSync(systemTool(tool), args, { encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT_MS });
  if (result.error || result.status !== 0) throw Error('store_unsafe');
  return result.stdout;
}

/** このprocessを動かしている利用者のSID。process中は変わらないので1回だけ聞く。 */
export function windowsSelfSid() {
  if (cachedSelfSid === null) {
    const sid = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).trim().split(',').at(-1).replaceAll('"', '');
    if (!SELF_SID.test(sid)) throw Error('store_unsafe');
    cachedSelfSid = sid;
  }
  return cachedSelfSid;
}

/**
 * SDDLのDACLが、本人・SYSTEM・Administratorsへの許可だけで出来ているか。
 * 読めない形（DACL無し・拒否・条件つき・object用のACE）はすべて「確かめられない」として通さない。
 */
export function daclIsOwnerOnly(sddl, selfSid) {
  if (typeof sddl !== 'string' || !SELF_SID.test(selfSid)) return false;
  const match = /^D:(?:P|AR|AI)*((?:\([^()]*\))+)$/.exec(sddl);
  if (match === null) return false;
  const trusted = new Set([selfSid, 'SY', SYSTEM_SID, 'BA', ADMINISTRATORS_SID]);
  return match[1].slice(1, -1).split(')(').every((ace) => {
    const fields = ace.split(';');
    return fields.length === 6 && fields[0] === 'A' && fields[3] === '' && fields[4] === '' && trusted.has(fields[5]);
  });
}

/** 親からの継承を切ってあるか（`P`）。切ってあれば、親の権限が後から変わっても降りてこない。 */
export function daclIsProtected(sddl) {
  return typeof sddl === 'string' && /^D:(?:AR|AI)*P/.test(sddl);
}

export const isAclScratchName = (name) => SCRATCH_NAME.test(name);

/**
 * `path`のDACLをSDDLで読む。`icacls`はfileへしか書き出せないので、出力は`scratchDir`へ置いてすぐ消す。
 * `scratchDir`には、他のaccountが書けないフォルダ（絞ったstoreのフォルダ）を渡す——他のaccountが書ける
 * 場所へ置くと、読む前に中身を書き換えられる。
 */
export function readWindowsDacl(path, scratchDir) {
  const scratch = join(scratchDir, `.acl-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    run('icacls.exe', [path, '/save', scratch]);
    const lines = readFileSync(scratch, 'utf16le').replaceAll('\ufeff', '').split(/\r?\n/).filter((line) => line !== '');
    // 1行目が名前、2行目がSDDL。それ以外の形は読めなかったものとして扱う。
    if (lines.length !== 2) throw Error('store_unsafe');
    return lines[1];
  } finally {
    rmSync(scratch, { force: true });
  }
}

/**
 * フォルダを本人・SYSTEM・Administratorsだけに絞る。親からの継承を切り、所有者を本人にする。
 * 中に作るfileはこの権限を引き継ぎ、renameで置き換えた後も保たれる。
 * 誰かがそのフォルダへ直接足した権限は消さない——呼び出し側が絞った後のDACLを読み直して、残っていれば止める。
 */
export function restrictWindowsDirToOwner(dir, selfSid) {
  const sids = [...new Set([selfSid, SYSTEM_SID, ADMINISTRATORS_SID])];
  run('icacls.exe', [dir, '/inheritance:r', '/grant:r', ...sids.map((sid) => `*${sid}:(OI)(CI)F`)]);
  run('icacls.exe', [dir, '/setowner', `*${selfSid}`]);
}
