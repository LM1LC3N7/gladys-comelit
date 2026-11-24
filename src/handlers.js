// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger, { retryWait = 2_000 } = {}) {
  // Discovery: the bridge objects, the alarm areas and zones, the doors.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceChanged(device));
  gladys.onDeviceUpdated((device) => app.deviceChanged(device));

  // Lights, plugs, shutters, setpoints, and the alarm and door buttons.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  // getConfig() (or the start) failing is tried again, spaced out, while the
  // connection lasts: the module never stays inert, nor on older options.
  gladys.on('connected', async () => {
    for (let wait = retryWait; ; wait = Math.min(wait * 2, 60_000)) {
      try {
        await app.connected(await gladys.getConfig());
        return;
      } catch (err) {
        logger?.error(`Start failed, trying again in ${wait} ms`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
      if (!gladys.connected) return;
    }
  });
}
