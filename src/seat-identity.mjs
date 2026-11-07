// 席の識別の唯一の置き場。AIは LATTICE_SEAT_ID を言い、機械が seat_id と状態の置き場を導く。
// 不正な値は拒否せず null に落とす（席が無名になるだけで、何も止めない）。
import { homedir } from 'node:os';
import path from 'node:path';

const SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** @returns {{ seat_id: string|null, state_dir: string }} */
export function resolveSeatIdentity(env = process.env) {
  const raw = env.LATTICE_SEAT_ID;
  const seat_id = typeof raw === 'string' && SEAT_ID.test(raw) ? raw : null;
  const configured = env.LATTICE_CONFIG_DIR;
  const state_dir = typeof configured === 'string' && path.isAbsolute(configured)
    ? configured
    : seat_id === null ? path.join(homedir(), '.lattice') : path.join(homedir(), '.lattice', 'seats', seat_id);
  return Object.freeze({ seat_id, state_dir });
}

/** status / session-context の top-level へ混ぜる欄。未設定なら空（欄を出さない）。 */
export function seatIdentityFields(env = process.env) {
  const { seat_id } = resolveSeatIdentity(env);
  return seat_id === null ? {} : { seat_id };
}
