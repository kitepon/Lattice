/**
 * This terminal's identity and the label it shows to others (ADR 0197).
 *
 * The identity is a random id kept in the Lattice config root. It was born as
 * the bridge-hub's routing key (`bridge-hub-heartbeat.mjs`, ADR 0162) and stays
 * that: the id itself never leaves the terminal↔hub wire.
 *
 * The label is what leaves. Todo journals are committed into public
 * repositories and the hub landing is served to anyone, so neither may carry
 * the OS hostname — a hostname is free text the operating system chose, and
 * it routinely holds its owner's name. The label is derived one-way from the
 * id: stable per terminal, so records and the landing still tell terminals
 * apart, and it says nothing about the machine or the person.
 */

import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bridgeConfigPaths } from './bridge-config.mjs';

export const TERMINAL_IDENTITY_SCHEMA = 'lattice.bridge_hub_terminal_identity.v1';
export const TERMINAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const LABEL_DOMAIN = 'lattice.terminal_public_label.v1';
const LABEL_HEX_LENGTH = 12;

export function terminalIdentityPath(env = process.env) {
  return path.join(bridgeConfigPaths(env).root, 'bridge-hub-terminal.json');
}

/**
 * The label a terminal is shown under in journals and on the hub landing.
 * One-way: the routing id cannot be recovered from it, so publishing the label
 * does not hand out the key the hub reconciles registrations by.
 */
export function terminalPublicLabel(terminalId) {
  if (typeof terminalId !== 'string' || !TERMINAL_IDENTIFIER.test(terminalId)) {
    throw new TypeError('terminal id is invalid');
  }
  const digest = createHash('sha256').update(`${LABEL_DOMAIN}\0${terminalId}`).digest('hex');
  return `terminal-${digest.slice(0, LABEL_HEX_LENGTH)}`;
}

/**
 * Synchronous twin of `readOrCreateBridgeHubTerminalId`: same file, same
 * schema, same no-overwrite publish. The todo CLI resolves its actor
 * synchronously on every mutation, and both paths must agree on one id per
 * terminal — a second file would give the journal and the landing two
 * different labels for the same machine.
 *
 * Returns `null` when the id can be neither read nor created (read-only or
 * missing home, invalid file). The caller decides what an unidentified
 * terminal is called; this function never invents an id it could not persist,
 * because an unpersisted id would change on every call.
 */
export function readOrCreateTerminalIdSync({ env = process.env } = {}) {
  let ref;
  try {
    ref = terminalIdentityPath(env);
    mkdirSync(path.dirname(ref), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const value = JSON.parse(readFileSync(ref, 'utf8'));
      return value?.schema === TERMINAL_IDENTITY_SCHEMA && TERMINAL_IDENTIFIER.test(value.terminal_id)
        ? value.terminal_id : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
    const terminalId = randomBytes(16).toString('hex');
    const temporary = `${ref}.${terminalId}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ schema: TERMINAL_IDENTITY_SCHEMA, terminal_id: terminalId })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      return null;
    }
    try {
      // 完成済みのbytesだけを、既存のIDを上書きせず公開する。
      linkSync(temporary, ref);
      return terminalId;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      // 同時生成の勝者が公開した完成済みIDを読む。
    } finally {
      try { unlinkSync(temporary); } catch { /* 一時fileは残っても識別子を壊さない */ }
    }
  }
  return null;
}
