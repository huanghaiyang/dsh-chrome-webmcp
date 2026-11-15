/**
 * Ops helper: read or change the debug Chrome window state over CDP, independently of
 * the bridge's launch path (talks to `lib/cdp.mjs` directly).
 *
 *   node scripts/window-state.mjs report   # print the window id and bounds
 *   node scripts/window-state.mjs small     # force a 900x620 non-maximized window
 *
 * `small` is how the "already-running window gets re-maximized" behaviour is tested:
 * shrink the window, then call `mcp__chrome__launch` and expect `window.applied: 1`
 * plus `windowState: "maximized"` in `report`.
 */
import { ChromeCdp } from '../lib/cdp.mjs';

const port = Number(process.env.CHROME_CDP_PORT || 9333);
const action = process.argv[2] || 'report';
const cdp = new ChromeCdp({ port, endpoint: `http://127.0.0.1:${port}` });

const windowOfFirstPage = async () => {
  const { targetInfos } = await cdp.send('Target.getTargets', {});
  const page = (targetInfos || []).find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
  return { targetId: page.targetId, windowId, bounds };
};

try {
  if (action === 'small') {
    const { windowId } = await windowOfFirstPage();
    // A window state must not be combined with geometry in the same call.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 120, top: 120, width: 900, height: 620 },
    });
    console.log('forced small window:', JSON.stringify(await windowOfFirstPage()));
  } else {
    console.log('window:', JSON.stringify(await windowOfFirstPage()));
  }
} finally {
  await cdp.close().catch(() => {});
}
