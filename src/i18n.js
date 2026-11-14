// -----------------------------------------------------------------------------
// Runtime texts, English and French: device and feature names, the status of
// the configuration screen, the answers of the test button. A metering point
// is only ever named by its last 4 digits.
// -----------------------------------------------------------------------------

const TEXTS = {
  deviceMeter: { en: 'Eloverblik meter …{suffix}', fr: 'Compteur Eloverblik …{suffix}' },
  featureConsumption: { en: 'Consumption (30 min)', fr: 'Consommation (30 min)' },

  // Status of the configuration screen.
  missing: {
    en: 'Enter the token you created on eloverblik.dk (Data sharing / API).',
    fr: 'Saisissez le jeton créé sur eloverblik.dk (partage de données / API).',
  },
  badToken: {
    en: 'This does not look like an Eloverblik token (a long text in three parts separated by dots): nothing is sent.',
    fr: 'Ceci n’a pas la forme d’un jeton Eloverblik (un long texte en trois parties séparées par des points) : rien n’est envoyé.',
  },
  malformed: {
    en: 'The token holds a control character or is too long: nothing is sent.',
    fr: 'Le jeton contient un caractère de contrôle ou est trop long : rien n’est envoyé.',
  },
  refused: {
    en: 'Eloverblik refused the token (it may have expired or been deactivated). Create a new one on eloverblik.dk and save it, or press Test. Nothing is asked until then.',
    fr: 'Eloverblik a refusé le jeton (il a pu expirer ou être désactivé). Créez-en un nouveau sur eloverblik.dk et enregistrez-le, ou appuyez sur Tester. Rien n’est demandé d’ici là.',
  },
  idKeyNotStored: {
    en: 'Gladys could not store the key of the device ids of this integration: nothing is read until it is stored. Next try at {time}.',
    fr: 'Gladys n’a pas pu enregistrer la clé des identifiants d’appareils de cette intégration : rien n’est lu tant qu’elle ne l’est pas. Nouvel essai le {time}.',
  },
  rateLimited: {
    en: 'Eloverblik asked to slow down (429): next request on {time}.',
    fr: 'Eloverblik a demandé de ralentir (429) : prochaine requête le {time}.',
  },
  server: {
    en: 'Eloverblik or DataHub is unavailable ({code}): next request on {time}.',
    fr: 'Eloverblik ou DataHub est indisponible ({code}) : prochaine requête le {time}.',
  },
  starting: {
    en: 'Starting: first read on {time}.',
    fr: 'Démarrage : première lecture le {time}.',
  },
  connected: {
    en: 'Connected: {count} metering point(s), read on {time}; next read on {next}.',
    fr: 'Connecté : {count} point(s) de comptage, lu(s) le {time} ; prochaine lecture le {next}.',
  },
  failing: {
    en: 'The read of {time} did not succeed: next read on {next}.',
    fr: 'La lecture du {time} n’a pas abouti : prochaine lecture le {next}.',
  },
  readProblem: {
    en: ' Reason: {code}.',
    fr: ' Cause : {code}.',
  },
  noMeteringPoint: {
    en: ' Eloverblik lists no consumption metering point for this token: link yours on eloverblik.dk.',
    fr: ' Eloverblik ne liste aucun point de comptage de consommation pour ce jeton : liez les vôtres sur eloverblik.dk.',
  },
  tooManyMeteringPoints: {
    en: ' {count} metering point(s) left out (10 at most).',
    fr: ' {count} point(s) de comptage laissé(s) de côté (10 au plus).',
  },
  createDevices: {
    en: ' Create the metering points in Discovery to receive their consumption.',
    fr: ' Créez les points de comptage dans Découverte pour recevoir leur consommation.',
  },
  meterUpTo: {
    en: ' Meter …{suffix}: complete up to {date}.',
    fr: ' Compteur …{suffix} : complet jusqu’au {date}.',
  },
  meterProblems: {
    en: ' Meter …{suffix}: {codes} (complete up to {date}).',
    fr: ' Compteur …{suffix} : {codes} (complet jusqu’au {date}).',
  },
  tokenUntil: {
    en: ' The token is valid until {date} (create a new one on eloverblik.dk before).',
    fr: ' Le jeton est valable jusqu’au {date} (créez-en un nouveau sur eloverblik.dk avant).',
  },
  storage: {
    en: ' /data cannot be read or written: the days already complete and the daily count of requests are not kept; reads wait an hour after a start.',
    fr: ' /data ne peut pas être lu ou écrit : les jours déjà complets et le compte quotidien des requêtes ne sont pas gardés ; les lectures attendent une heure après un démarrage.',
  },
  devicesUnread: {
    en: ' The devices could not be read from Gladys: tried again soon, nothing is published meanwhile.',
    fr: ' Les appareils n’ont pas pu être lus depuis Gladys : nouvel essai bientôt, rien n’est publié d’ici là.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: next try soon.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai bientôt.',
  },

  // Test button.
  testOk: {
    en: 'Token accepted. {count} consumption metering point(s): {list}.',
    fr: 'Jeton accepté. {count} point(s) de comptage de consommation : {list}.',
  },
  testNoPoint: {
    en: 'Token accepted, but no consumption metering point is linked to it: link yours on eloverblik.dk.',
    fr: 'Jeton accepté, mais aucun point de comptage de consommation n’y est lié : liez les vôtres sur eloverblik.dk.',
  },
  testRefused: {
    en: 'Eloverblik refused the token: create a new one on eloverblik.dk.',
    fr: 'Eloverblik a refusé le jeton : créez-en un nouveau sur eloverblik.dk.',
  },
  testNotReady: {
    en: 'Not ready yet (the configuration is being read): try again in a moment.',
    fr: 'Pas encore prêt (la configuration est en cours de lecture) : réessayez dans un instant.',
  },
  testTooSoon: {
    en: 'Tested less than a minute ago: try again in a moment.',
    fr: 'Testé il y a moins d’une minute : réessayez dans un instant.',
  },
  testTokenWait: {
    en: 'Not sent: Eloverblik allows few token requests; try again after {time}.',
    fr: 'Rien envoyé : Eloverblik limite les demandes de jeton ; réessayez après le {time}.',
  },
  testPaused: {
    en: 'Not sent: Eloverblik asked to wait until {time}.',
    fr: 'Rien envoyé : Eloverblik a demandé d’attendre jusqu’au {time}.',
  },
  testFailed: {
    en: 'Eloverblik could not be read ({code}): nothing changed.',
    fr: 'Eloverblik n’a pas pu être lu ({code}) : rien n’a changé.',
  },
};

/** A text in a language, with its {placeholders} filled. */
export function t(key, language = 'en', values = {}) {
  const entry = TEXTS[key];
  const text = entry?.[language] ?? entry?.en ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

/** Both languages of a text: { en, fr }. */
export const both = (key, values) => ({ en: t(key, 'en', values), fr: t(key, 'fr', values) });

export const ALL_TEXTS = TEXTS;
