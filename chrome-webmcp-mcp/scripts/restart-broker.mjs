/**
 * Ops helper: make the running broker exit so the next call starts a broker that
 * loads the current `broker.mjs` / `lib/config.mjs`.
 *
 * Why this and not `Stop-Process`: the broker exposes its own `shutdown` IPC method,
 * which is a clean stop (persists ownership, closes IPC/CDP, removes broker.json).
 * Note: the DSH file sandbox denies named-pipe connects (EPERM) and process
 * enumeration, so this needs an unsandboxed shell (`pwsh` with full access).
 *
 *   node scripts/restart-broker.mjs             # probe only (hello)
 *   node scripts/restart-broker.mjs --shutdown  # hello, then shutdown
 *
 * Caveat: `shutdown` resolves only when every client disconnects, so while an MCP
 * client (the bridge) is connected prefer stopping the process by the pid from
 * `mcp__chrome__status` (`broker.pid`); both paths are followed by a lazy respawn on
 * the next `mcp__chrome__*` call.
 */
import { connectIpc } from '../lib/ipc.mjs';

const ipc = process.env.CHROME_WEBMCP_IPC || '\\\\.\\pipe\\dsh-chrome-webmcp-9333';
const doShutdown = process.argv.includes('--shutdown');

const channel = await connectIpc(ipc, { timeoutMs: 5000 });
try {
  const hello = await channel.request(
    'hello',
    { clientId: `ops-restart-${process.pid}`, pid: process.pid, version: '2.0.0', taskId: 'default' },
    { timeoutMs: 5000 },
  );
  console.log('hello:', JSON.stringify(hello));
  if (!doShutdown) {
    console.log('probe only; pass --shutdown to stop the broker');
  } else {
    const result = await channel.request('shutdown', {}, { timeoutMs: 8000 });
    console.log('shutdown:', JSON.stringify(result));
  }
} finally {
  try {
    channel.close();
  } catch {
    /* ignore */
  }
}
