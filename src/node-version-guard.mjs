/** Shared sensor/MCP runtime compatibility policy; no bootstrap side effects. */
export {
  MIN_NODE_MAJOR,
  evaluateNodeVersionGuard,
} from '../sensor/dist/bin/node-version-check.js';
