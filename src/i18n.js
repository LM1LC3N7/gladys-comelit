// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

export const DEVICE_NAMES = {
  bridge: { fr: 'Pont Comelit', en: 'Comelit bridge' },
  vedo: { fr: 'Alarme Comelit Vedo', en: 'Comelit Vedo alarm' },
  light: { fr: (n) => `Lumière ${n}`, en: (n) => `Light ${n}` },
  plug: { fr: (n) => `Prise ${n}`, en: (n) => `Plug ${n}` },
  shutter: { fr: (n) => `Volet ${n}`, en: (n) => `Shutter ${n}` },
  thermostat: { fr: (n) => `Thermostat ${n}`, en: (n) => `Thermostat ${n}` },
  area: { fr: (n) => `Secteur ${n}`, en: (n) => `Area ${n}` },
  zone: { fr: (n) => `Zone ${n}`, en: (n) => `Zone ${n}` },
  door: { fr: (n) => `Porte ${n}`, en: (n) => `Door ${n}` },
};

export const FEATURE_NAMES = {
  online: { fr: 'Connecté', en: 'Connected' },
  light: { fr: 'Lumière', en: 'Light' },
  plug: { fr: 'Prise', en: 'Plug' },
  shutter: { fr: 'Volet', en: 'Shutter' },
  temperature: { fr: 'Température', en: 'Temperature' },
  setpoint: { fr: 'Consigne', en: 'Setpoint' },
  mode: { fr: 'État', en: 'State' },
  alarm: { fr: 'Alarme en cours', en: 'Alarm in progress' },
  tamper: { fr: 'Sabotage', en: 'Tamper' },
  'arm-total': { fr: 'Armement total', en: 'Arm total' },
  'arm-p1': { fr: 'Armement partiel P1', en: 'Arm partial P1' },
  'arm-p12': { fr: 'Armement partiel P1 + P2', en: 'Arm partial P1 + P2' },
  disarm: { fr: 'Désarmer', en: 'Disarm' },
  kind: {
    opening: { fr: 'Ouverture', en: 'Opening' },
    motion: { fr: 'Mouvement', en: 'Motion' },
    smoke: { fr: 'Fumée', en: 'Smoke' },
    leak: { fr: "Fuite d'eau", en: 'Water leak' },
  },
  'zone-alarm': { fr: 'Alarme', en: 'Alarm' },
  excluded: { fr: 'Exclue', en: 'Excluded' },
  'zone-tamper': { fr: 'Sabotage', en: 'Tamper' },
  open: { fr: 'Ouvrir', en: 'Open' },
};

/** The text of the read-only state feature of an area. */
export const MODE_NAMES = {
  disarmed: { fr: 'Désarmé', en: 'Disarmed' },
  armed_p1: { fr: 'Armé (partiel P1)', en: 'Armed (partial P1)' },
  armed_p2: { fr: 'Armé (partiel P2)', en: 'Armed (partial P2)' },
  armed_p12: { fr: 'Armé (partiel P1 + P2)', en: 'Armed (partial P1 + P2)' },
  armed_total: { fr: 'Armé (total)', en: 'Armed (total)' },
  exit_delay: { fr: 'Armement en cours', en: 'Arming (exit delay)' },
  entry_delay: { fr: "Délai d'entrée", en: 'Entry delay' },
  unknown: { fr: 'Inconnu', en: 'Unknown' },
};

/** What a command is, in the logs and the messages. */
export const COMMAND_NAMES = {
  armed_total: { fr: (n) => `armement total du secteur ${n}`, en: (n) => `arm area ${n} total` },
  armed_p1: {
    fr: (n) => `armement partiel P1 du secteur ${n}`,
    en: (n) => `arm area ${n} partial P1`,
  },
  armed_p12: {
    fr: (n) => `armement partiel P1 + P2 du secteur ${n}`,
    en: (n) => `arm area ${n} partial P1 + P2`,
  },
  disarm: { fr: (n) => `désarmement du secteur ${n}`, en: (n) => `disarm area ${n}` },
  light: {
    fr: (name, on) => `${on ? 'allumage' : 'extinction'} de ${name}`,
    en: (name, on) => `turn ${on ? 'on' : 'off'} ${name}`,
  },
  shutter: {
    fr: (name, action) =>
      `${{ open: 'ouverture', close: 'fermeture', stop: 'arrêt' }[action]} de ${name}`,
    en: (name, action) => `${action} ${name}`,
  },
  setpoint: {
    fr: (name, value) => `consigne de ${name} à ${value} °C`,
    en: (name, value) => `set ${name} to ${value} °C`,
  },
  door: { fr: (name) => `ouverture de ${name}`, en: (name) => `open ${name}` },
};

const s = (n, fr) => (n > 1 ? fr : '');

/** Messages: status of the connection, answers to the buttons and commands. */
export const T = {
  noHost: {
    fr: "Indiquez l'adresse du pont Comelit ou de la Vedo",
    en: 'Enter the address of the Comelit bridge or of the Vedo',
  },
  connecting: { fr: 'Connexion…', en: 'Connecting…' },
  noConfig: {
    fr: "Configuration illisible depuis Gladys : rien n'a été lancé, réessayez",
    en: 'The configuration could not be read from Gladys: nothing was started, try again',
  },
  connected: {
    fr: (parts) => `Connecté : ${parts.join(', ')}`,
    en: (parts) => `Connected: ${parts.join(', ')}`,
  },
  partBridge: {
    fr: (n) => `pont (${n} appareil${s(n, 's')})`,
    en: (n) => `bridge (${n} device${n > 1 ? 's' : ''})`,
  },
  partVedo: {
    fr: (areas, zones) =>
      `alarme (${areas} secteur${s(areas, 's')}, ${zones} zone${s(zones, 's')})`,
    en: (areas, zones) =>
      `alarm (${areas} area${areas > 1 ? 's' : ''}, ${zones} zone${zones > 1 ? 's' : ''})`,
  },
  partDoors: {
    fr: (n) => `interphone (${n} porte${s(n, 's')})`,
    en: (n) => `intercom (${n} door${n > 1 ? 's' : ''})`,
  },
  partVedoDown: { fr: 'alarme injoignable', en: 'alarm unreachable' },
  partVedoRefused: { fr: 'alarme : code refusé', en: 'alarm: PIN refused' },
  partDoorsDown: { fr: 'interphone injoignable', en: 'intercom unreachable' },
  partDoorsRefused: { fr: 'interphone : jeton refusé', en: 'intercom: token refused' },
  unreachable: {
    fr: (what, reason, seconds) =>
      `${what} injoignable (${reason}), nouvel essai dans ${seconds} s`,
    en: (what, reason, seconds) => `${what} unreachable (${reason}), next try in ${seconds} s`,
  },
  bridgeRefused: {
    fr: 'Le pont a refusé le code (PIN) : connexion arrêtée. Corrigez-le puis enregistrez, ou cliquez sur « Tester la connexion ».',
    en: 'The bridge refused the PIN: connection stopped. Fix it and save, or click "Test the connection".',
  },
  vedoRefused: {
    fr: "La Vedo a refusé le code de l'alarme : alarme arrêtée. Corrigez-le puis enregistrez, ou cliquez sur « Tester la connexion ».",
    en: 'The Vedo refused the alarm PIN: alarm stopped. Fix it and save, or click "Test the connection".',
  },
  stillConnecting: {
    fr: 'Connexion toujours en cours, réessayez dans un instant',
    en: 'Still connecting, try again in a moment',
  },
  offline: {
    fr: "Pas connecté : rien n'a été envoyé",
    en: 'Not connected: nothing was sent',
  },
  tooLate: {
    fr: "Le pont n'a pas répondu à temps : rien n'a été envoyé",
    en: 'The bridge did not answer in time: nothing was sent',
  },
  stateUnknown: {
    fr: "État illisible sur le pont : rien n'a été envoyé",
    en: 'The state could not be read from the bridge: nothing was sent',
  },
  sessionExpired: {
    fr: "Session expirée, reconnexion en cours : rien n'a été envoyé",
    en: 'Session expired, logging in again: nothing was sent',
  },
  unknownObject: {
    fr: (what) => `${what} inconnu : rien n'a été envoyé`,
    en: (what) => `Unknown ${what}: nothing was sent`,
  },
  badValue: {
    fr: (value) => `Valeur ${value} non comprise : rien n'a été envoyé`,
    en: (value) => `Value ${value} not understood: nothing was sent`,
  },
  setpointRefused: {
    fr: "Réglage de la consigne désactivé dans la configuration : rien n'a été envoyé",
    en: 'Setting the setpoint is disabled in the configuration: nothing was sent',
  },
  setpointRange: {
    fr: (min, max) => `Consigne hors limites (${min} à ${max} °C) : rien n'a été envoyé`,
    en: (min, max) => `Setpoint out of range (${min} to ${max} °C): nothing was sent`,
  },
  thermostatOff: {
    fr: "Thermostat éteint : rien n'a été envoyé",
    en: 'The thermostat is off: nothing was sent',
  },
  thermostatAuto: {
    fr: "Thermostat en mode automatique (le programme fixe la consigne) : rien n'a été envoyé",
    en: 'The thermostat is in automatic mode (its program sets the target): nothing was sent',
  },
  shutterOpposite: {
    fr: "Le volet bouge dans l'autre sens : arrêtez-le d'abord. Rien n'a été envoyé",
    en: 'The shutter moves the other way: stop it first. Nothing was sent',
  },
  stopPending: {
    fr: "Arrêt précédent pas encore vu sur le pont : rien n'a été envoyé",
    en: 'The previous stop is not seen on the bridge yet: nothing was sent',
  },
  armRefused: {
    fr: "Armement désactivé dans la configuration : rien n'a été envoyé",
    en: 'Arming is disabled in the configuration: nothing was sent',
  },
  disarmRefused: {
    fr: "Désarmement désactivé dans la configuration : rien n'a été envoyé",
    en: 'Disarming is disabled in the configuration: nothing was sent',
  },
  doorRefused: {
    fr: "Ouverture de porte désactivée dans la configuration : rien n'a été envoyé",
    en: 'Opening doors is disabled in the configuration: nothing was sent',
  },
  vedoOffline: {
    fr: "Alarme injoignable : rien n'a été envoyé",
    en: 'The alarm is unreachable: nothing was sent',
  },
  otherMode: {
    fr: "Le secteur est déjà armé dans un autre mode : désarmez-le d'abord. Rien n'a été envoyé",
    en: 'The area is armed in another mode: disarm it first. Nothing was sent',
  },
  delayInProgress: {
    fr: "Délai d'entrée ou de sortie en cours sur ce secteur : rien n'a été envoyé",
    en: 'An entry or exit delay is running on this area: nothing was sent',
  },
  alarmInProgress: {
    fr: "Alarme en cours sur ce secteur : rien n'a été envoyé",
    en: 'An alarm is in progress on this area: nothing was sent',
  },
  doorPending: {
    fr: "Cette porte vient d'être ouverte : rien n'a été envoyé",
    en: 'This door was just opened: nothing was sent',
  },
  doorMissing: {
    fr: "Cette porte n'est plus dans la configuration de l'interphone, relancez une recherche : rien n'a été envoyé",
    en: 'This door is no longer in the intercom configuration, scan again: nothing was sent',
  },
  intercomOff: {
    fr: "Interphone non configuré ou arrêté (jeton refusé) : rien n'a été envoyé",
    en: 'The intercom is not set up or stopped (token refused): nothing was sent',
  },
  intercomRefused: {
    fr: "Le pont de l'interphone a refusé le jeton : interphone arrêté. Corrigez-le puis enregistrez, ou cliquez sur « Tester la connexion ».",
    en: 'The intercom bridge refused the token: intercom stopped. Fix it and save, or click "Test the connection".',
  },
  refusedByBridge: {
    fr: (what, status) => `Refusé par le pont (${what}, HTTP ${status})`,
    en: (what, status) => `Refused by the bridge (${what}, HTTP ${status})`,
  },
  unconfirmed: {
    fr: (what) => `Envoyé, sans confirmation (${what}) : l'état va être relu`,
    en: (what) => `Sent, without confirmation (${what}): the state will be read again`,
  },
  doorUnconfirmed: {
    fr: (what) => `Envoyé, sans confirmation (${what}) : le pont de l'interphone n'en donne pas`,
    en: (what) => `Sent, without confirmation (${what}): the intercom bridge gives none`,
  },
};
