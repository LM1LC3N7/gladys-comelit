// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  ALARM_TRIGGERED: 'alarm_triggered',
  ARMED: 'armed',
  DISARMED: 'disarmed',
};

/**
 * Every mode a Vedo area can show, by the `armed` level of `area_stat.json`
 * (aiocomelit and the Home Assistant integration): 0 disarmed, 1 partial P1,
 * 2 partial P2, 3 partial P1 + P2, 4 total. Frozen: the `armed` scene
 * trigger carries them.
 */
export const ARMED_LEVELS = ['disarmed', 'armed_p1', 'armed_p2', 'armed_p12', 'armed_total'];

/** The modes Gladys can ask, and the action word the Vedo takes for each. */
export const ARM_ACTIONS = {
  armed_total: 'tot',
  armed_p1: 'p1',
  armed_p12: 'p12',
};
export const DISARM_ACTION = 'dis';

/** How a zone shows in Gladys (frozen: stored in the configuration). */
export const ZONE_KINDS = ['opening', 'motion', 'smoke', 'leak'];

/** Bits of a zone status (aiocomelit ALARM_ZONE_STATUS). */
export const ZONE_BITS = {
  open: 1,
  alarm: 2,
  faulty: 4,
  sabotage: 8,
  armed: 32,
  excluded: 128,
  isolated: 256,
  unavailable: 512,
  inhibited: 32768,
};

/** The SimpleHome object types read from the bridge, by Gladys device kind. */
export const BRIDGE_TYPES = {
  thermostat: 'clima',
  shutter: 'shutter',
  light: 'light',
  plug: 'other',
};

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** Status of a shutter on the bridge (aiocomelit STATE_COVER). */
export const SHUTTER_STATUS = { STOPPED: 0, OPENING: 1, CLOSING: 2 };

export const DEFAULT_PORT = 80;
export const ICONA_PORT = 64100;

export const LIMITS = {
  /** Objects of one type on a bridge, areas and zones of a Vedo, at most. */
  maxObjects: 256,
  maxAreas: 64,
  maxZones: 512,
  /** Doors read from the intercom bridge, at most. */
  maxDoors: 32,
  /** Bytes of an HTTP answer read at most (a JSON page of the bridge). */
  maxBody: 512 * 1024,
  /** Bytes of one ICONA frame at most. */
  maxIconaFrame: 64 * 1024,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the bridge, the areas and the devices other than zones may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300); alarm_triggered is never dropped. */
  eventsPerMinute: 120,
  /** Tries of an alarm_triggered event refused by Gladys or the network. */
  alarmEventTries: 3,
  /** Setpoint bounds of a SimpleHome thermostat (Home Assistant: 5 to 30 °C). */
  minSetpoint: 5,
  maxSetpoint: 30,
};

export const TIMINGS = {
  /** One HTTP request to the bridge or the Vedo (aiocomelit waits 10 s). */
  requestTimeout: 5_000,
  /** Never two requests to the same host closer than this (aiocomelit: 0.25 s between Vedo calls). */
  gap: 250,
  /** The Vedo needs this long after a login (aiocomelit SLEEP_AFTER_VEDO_LOGIN). */
  vedoLoginWait: 1_500,
  /** A login whose session is not seen at once is checked again after this. */
  loginCheckWait: 1_500,
  /** Two thermostat commands at least this far apart (aiocomelit SLEEP_BETWEEN_BRIDGE_CALLS). */
  climaGap: 1_500,
  /** Waits before a new session after a failure, in a row (the last one repeats). */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /**
   * Gladys waits 5 s for a set_value ack. A command must be sent by sendBy
   * after it was asked (else it is refused, nothing sent), and the answer is
   * awaited until answerBy (then "sent, not confirmed").
   */
  sendBy: 3_500,
  answerBy: 4_500,
  /** The fresh read before a command, at most. */
  readBefore: 1_500,
  /** After an alarm command, its state is read this often until answerBy. */
  confirmEvery: 500,
  /** The object is read again this long after a command. */
  readBack: 2_000,
  /** A shutter stop (a reverse command on the bridge) is not sent again until seen or expired. */
  stopGuard: 15_000,
  /** A door is not opened again from Gladys within this time. */
  doorGuard: 10_000,
  /** A transition seen this long after a Gladys command is credited to it. */
  commandMemory: 2 * 60_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** Waits between two tries of an alarm_triggered event. */
  alarmEventRetry: [5_000, 20_000],
  /** "Test the connection" waits this long for the sessions (the manifest allows 30 s). */
  testWait: 25_000,
  /** TCP connection and one answer of the intercom bridge. */
  iconaConnect: 3_000,
  iconaRead: 2_000,
  /** Waits before reading the doors of the intercom again after a failure. */
  iconaRetry: [60_000, 5 * 60_000, 30 * 60_000],
};
