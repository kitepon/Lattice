import { spawn } from 'node:child_process';
import { setupError } from './setup-config.mjs';

/** 登録から起動したstdioの初期化とtool一覧を読戻す。AIへの推論依頼は行わない。 */
export async function probeSetupMcp(entry, { env = process.env, timeoutMs = 15000 } = {}) {
  const child = spawn(entry.command, entry.args ?? [], {
    shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: entry.cwd,
    env: { ...env, ...entry.env }, windowsHide: true,
  });
  let buffer = '';
  let initialized = false;
  let result;
  let failure;
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(setupError('MCP_TIMEOUT', 'MCP接続確認が時間内に完了しません')), timeoutMs);
      const finish = (error, value) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      child.once('error', () => finish(setupError('MCP_LAUNCH_FAILED', '登録されたMCP実行体を起動できません')));
      child.stdin.on('error', () => finish(setupError('MCP_CONNECTION_CLOSED', 'MCP入力が閉じました')));
      child.stderr.resume();
      child.once('exit', () => finish(setupError('MCP_CONNECTION_CLOSED', '接続確認前にMCPが終了しました')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) return finish(setupError('MCP_PROTOCOL_INVALID', 'MCP出力が上限を超えました'));
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n');
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch {
            return finish(setupError('MCP_PROTOCOL_INVALID', 'MCP出力がJSON-RPCではありません'));
          }
          if (response.id === 1) {
            if (response.error || response.result?.serverInfo?.name !== 'lattice-sensor') {
              return finish(setupError('MCP_IDENTITY_MISMATCH', 'Lattice MCPの初期化結果を確認できません'));
            }
            initialized = true;
            send({ method: 'notifications/initialized' });
            send({ id: 2, method: 'tools/list', params: {} });
          } else if (response.id === 2) {
            const names = response.result?.tools?.map((tool) => tool.name);
            if (!initialized || response.error || !names?.includes('lattice_sensor_explore')
              || names.some((name) => !name.startsWith('lattice_sensor_'))) {
              return finish(setupError('MCP_TOOLS_MISMATCH', 'Lattice sensorの公開toolを確認できません'));
            }
            finish(null, { state: 'verified', tool_count: names.length });
          }
        }
      });
      send({ id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'lattice-setup', version: '1' },
      } });
    });
  } catch (error) { failure = error; }
  finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await closed;
    clearTimeout(timer);
  }
  if (failure) throw failure;
  return result;
}
