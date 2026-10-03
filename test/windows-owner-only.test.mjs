import assert from 'node:assert/strict';
import test from 'node:test';

import { daclIsOwnerOnly, daclIsProtected, isAclScratchName } from '../src/windows-owner-only.mjs';

// `icacls /save`が返すSDDLの判定。実物の値はfox（Windows 11）で採った形で、SIDの機械部分だけ置き換えてある。
const SELF = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';

test('本人・SYSTEM・Administratorsへの許可だけのDACLを通す', () => {
  for (const sddl of [
    // 継承を切って絞ったフォルダ、その中のfile、BugHubの持ち主が置いた合鍵。
    `D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${SELF})`,
    `D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SELF})`,
    `D:PAI(A;;FA;;;${SELF})`,
    // SYSTEMとAdministratorsは、別名でなくSIDで書かれていても同じ。
    'D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)',
  ]) assert.equal(daclIsOwnerOnly(sddl, SELF), true, sddl);
  // SYSTEMとして動く時（CIのrunner）は、本人がSYSTEMになる。
  assert.equal(daclIsOwnerOnly('D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)', 'S-1-5-18'), true);
});

test('他のaccountが現れるDACLと、読めない形のDACLは通さない', () => {
  for (const sddl of [
    // 既定の`%LOCALAPPDATA%`の下: 別のローカルaccountへ継承で許している。
    `D:AI(A;OICIID;0x1200a9;;;${OTHER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SELF})`,
    // 絞った後に、Users・Everyone・Authenticated Usersへ足された。
    `D:AI(A;;FR;;;BU)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SELF})`,
    `D:PAI(A;;FA;;;${SELF})(A;;FR;;;WD)`,
    `D:PAI(A;;FA;;;${SELF})(A;;FR;;;AU)`,
    // 拒否・条件つき・object用のACEは、意味を確かめないので通さない。
    `D:AI(D;;0x100116;;;WD)(A;ID;FA;;;${SELF})`,
    `D:PAI(XA;;FA;;;${SELF};(Member_of {SID(BA)}))`,
    `D:PAI(OA;;FA;00000000-0000-0000-0000-000000000000;;${SELF})`,
    // 許可が1つも無い・DACLそのものが無い（誰でも触れる）・SDDLでない。
    'D:', 'D:P', 'D:NO_ACCESS_CONTROL', `O:BAD:PAI(A;;FA;;;${SELF})`, '', `D:PAI(A;;FA;;;${SELF}`, `D:PAI(A;;FA;;;${SELF})x`,
  ]) assert.equal(daclIsOwnerOnly(sddl, SELF), false, sddl);
  // 本人のSIDは完全一致で見る。別の利用者のSIDや、SIDでない値を本人として渡しても通さない。
  assert.equal(daclIsOwnerOnly(`D:PAI(A;;FA;;;${SELF})`, OTHER), false);
  assert.equal(daclIsOwnerOnly('D:PAI(A;;FA;;;BU)', 'BU'), false);
  assert.equal(daclIsOwnerOnly(undefined, SELF), false);
});

test('親からの継承を切ってあるDACLを見分ける', () => {
  for (const sddl of ['D:P(A;;FA;;;SY)', 'D:PAI(A;;FA;;;SY)', 'D:ARP(A;;FA;;;SY)']) assert.equal(daclIsProtected(sddl), true, sddl);
  for (const sddl of ['D:AI(A;ID;FA;;;SY)', 'D:(A;;FA;;;SY)', 'D:', '', undefined]) assert.equal(daclIsProtected(sddl), false, String(sddl));
});

test('空かどうかを見る時に数えないのは、DACLの読み取りが置く出力fileの名前だけ', () => {
  assert.equal(isAclScratchName('.acl-1234-0123456789ab'), true);
  for (const name of ['runtime-errors.json', '.acl-1234-0123456789ab.json', '.acl-x-0123456789ab', 'x.acl-1-0123456789ab']) {
    assert.equal(isAclScratchName(name), false, name);
  }
});
