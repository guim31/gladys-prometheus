// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the configuration action reports, severities in
// scene variables and outputs, scene action messages. Four languages, the
// four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './prometheus/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the address of your Prometheus in the configuration.',
    fr: "Saisissez l'adresse de votre Prometheus dans la configuration.",
    de: 'Gib die Adresse deines Prometheus in der Konfiguration ein.',
    es: 'Introduzca la dirección de su Prometheus en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:9090',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:9090',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:9090',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:9090',
  },
};

// One short explanation per error kind (src/prometheus/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'access refused: check the user, password or token',
    fr: "accès refusé : vérifiez l'utilisateur, le mot de passe ou le jeton",
    de: 'Zugriff verweigert: Prüfe Benutzer, Passwort oder Token',
    es: 'acceso denegado: compruebe el usuario, la contraseña o el token',
  },
  [ERROR_KINDS.NOT_PROMETHEUS]: {
    en: 'no Prometheus or Alertmanager API at this address',
    fr: "pas d'API Prometheus ou Alertmanager à cette adresse",
    de: 'keine Prometheus- oder Alertmanager-API unter dieser Adresse',
    es: 'no hay ninguna API de Prometheus o Alertmanager en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.QUERY]: {
    en: 'query refused by Prometheus',
    fr: 'requête refusée par Prometheus',
    de: 'Abfrage von Prometheus abgelehnt',
    es: 'consulta rechazada por Prometheus',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// Why a query has no value (src/prometheus/model.js RESULT_ERRORS).
export const RESULT_TEXT = {
  not_number: {
    en: 'the result is not a number',
    fr: "le résultat n'est pas un nombre",
    de: 'das Ergebnis ist keine Zahl',
    es: 'el resultado no es un número',
  },
  range: {
    en: 'range vector: remove the [5m], or wrap it in rate()',
    fr: 'vecteur de plage : retirez le [5m], ou utilisez rate()',
    de: 'Bereichsvektor: Entferne das [5m] oder nutze rate()',
    es: 'vector de rango: quite el [5m] o use rate()',
  },
  empty: {
    en: 'no series for now',
    fr: 'aucune série pour le moment',
    de: 'im Moment keine Serie',
    es: 'ninguna serie por ahora',
  },
};

// The severity buckets (src/prometheus/model.js), in scene variables and outputs.
export const SEVERITY_TEXT = {
  critical: { en: 'Critical', fr: 'Critique', de: 'Kritisch', es: 'Crítica' },
  warning: { en: 'Warning', fr: 'Avertissement', de: 'Warnung', es: 'Advertencia' },
  info: { en: 'Info', fr: 'Info', de: 'Info', es: 'Info' },
  other: { en: 'Other', fr: 'Autre', de: 'Andere', es: 'Otra' },
};

export const NO_ALERT_TEXT = {
  en: 'No alert',
  fr: 'Aucune alerte',
  de: 'Kein Alarm',
  es: 'Ninguna alerta',
};

// Reports of the configuration actions ("Test the connection", "Add a
// query", "Remove a query"). Functions: the parts that carry a value.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    queries: (count) => `${count} query(ies)`,
    alerts: (count) => `${count} firing alert(s)`,
    noAlertmanager: 'alerts read from Prometheus (no Alertmanager)',
    added: (name) => `Query "${name}" added`,
    updated: (name) => `Query "${name}" updated`,
    removed: (name) => `Query "${name}" removed`,
    series: (count) => `${count} series`,
    capped: (max) => `only the first ${max} are kept`,
    discovery: 'add its device from the Discover tab',
    notFound: (name) => `No query named "${name}".`,
    tooMany: (max) => `${max} queries at most: remove one first.`,
    refused: (detail) => `Prometheus refuses this query: ${detail}`,
    notChecked: 'saved, but not checked',
    noQuery: 'no query yet: use "Add a query"',
  },
  fr: {
    ok: 'OK',
    queries: (count) => `${count} requête(s)`,
    alerts: (count) => `${count} alerte(s) active(s)`,
    noAlertmanager: "alertes lues dans Prometheus (pas d'Alertmanager)",
    added: (name) => `Requête « ${name} » ajoutée`,
    updated: (name) => `Requête « ${name} » modifiée`,
    removed: (name) => `Requête « ${name} » supprimée`,
    series: (count) => `${count} série(s)`,
    capped: (max) => `seules les ${max} premières sont gardées`,
    discovery: "ajoutez son appareil depuis l'onglet Découverte",
    notFound: (name) => `Aucune requête nommée « ${name} ».`,
    tooMany: (max) => `${max} requêtes au plus : supprimez-en une d'abord.`,
    refused: (detail) => `Prometheus refuse cette requête : ${detail}`,
    notChecked: 'enregistrée, mais pas vérifiée',
    noQuery: 'aucune requête : utilisez « Ajouter une requête »',
  },
  de: {
    ok: 'OK',
    queries: (count) => `${count} Abfrage(n)`,
    alerts: (count) => `${count} aktive(r) Alarm(e)`,
    noAlertmanager: 'Alarme aus Prometheus gelesen (kein Alertmanager)',
    added: (name) => `Abfrage „${name}“ hinzugefügt`,
    updated: (name) => `Abfrage „${name}“ geändert`,
    removed: (name) => `Abfrage „${name}“ entfernt`,
    series: (count) => `${count} Serie(n)`,
    capped: (max) => `nur die ersten ${max} werden behalten`,
    discovery: 'füge ihr Gerät im Tab „Entdecken“ hinzu',
    notFound: (name) => `Keine Abfrage namens „${name}“.`,
    tooMany: (max) => `Höchstens ${max} Abfragen: Entferne zuerst eine.`,
    refused: (detail) => `Prometheus lehnt diese Abfrage ab: ${detail}`,
    notChecked: 'gespeichert, aber nicht geprüft',
    noQuery: 'noch keine Abfrage: Nutze „Abfrage hinzufügen“',
  },
  es: {
    ok: 'OK',
    queries: (count) => `${count} consulta(s)`,
    alerts: (count) => `${count} alerta(s) activa(s)`,
    noAlertmanager: 'alertas leídas de Prometheus (sin Alertmanager)',
    added: (name) => `Consulta «${name}» añadida`,
    updated: (name) => `Consulta «${name}» modificada`,
    removed: (name) => `Consulta «${name}» eliminada`,
    series: (count) => `${count} serie(s)`,
    capped: (max) => `solo se conservan las ${max} primeras`,
    discovery: 'añada su dispositivo desde la pestaña Descubrir',
    notFound: (name) => `Ninguna consulta se llama «${name}».`,
    tooMany: (max) => `${max} consultas como máximo: elimine una antes.`,
    refused: (detail) => `Prometheus rechaza esta consulta: ${detail}`,
    notChecked: 'guardada, pero no comprobada',
    noQuery: 'ninguna consulta: use «Añadir una consulta»',
  },
};

// Why "Add a query" refuses its fields (src/queries.js QUERY_ERRORS).
export const QUERY_FIELD_TEXT = {
  name: {
    en: 'Give the query a name (60 characters at most).',
    fr: 'Donnez un nom à la requête (60 caractères au plus).',
    de: 'Gib der Abfrage einen Namen (höchstens 60 Zeichen).',
    es: 'Dé un nombre a la consulta (60 caracteres como máximo).',
  },
  promql: {
    en: 'Enter a PromQL expression (2000 characters at most).',
    fr: 'Saisissez une expression PromQL (2000 caractères au plus).',
    de: 'Gib einen PromQL-Ausdruck ein (höchstens 2000 Zeichen).',
    es: 'Introduzca una expresión PromQL (2000 caracteres como máximo).',
  },
  type: {
    en: 'Choose a type in the list.',
    fr: 'Choisissez un type dans la liste.',
    de: 'Wähle einen Typ aus der Liste.',
    es: 'Elija un tipo de la lista.',
  },
  label: {
    en: 'A label name has letters, digits and _ only, e.g. instance.',
    fr: "Un nom d'étiquette n'a que des lettres, chiffres et _, ex. instance.",
    de: 'Ein Label-Name hat nur Buchstaben, Ziffern und _, z. B. instance.',
    es: 'Un nombre de etiqueta solo tiene letras, cifras y _, p. ej. instance.',
  },
};

// Scene action messages (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No Prometheus is configured.',
    fr: "Aucun Prometheus n'est configuré.",
    de: 'Kein Prometheus ist konfiguriert.',
    es: 'No hay ningún Prometheus configurado.',
  },
  noAlertmanager: {
    en: 'Silences need the address of Alertmanager in the configuration.',
    fr: "Les silences demandent l'adresse d'Alertmanager dans la configuration.",
    de: 'Stummschaltungen brauchen die Adresse von Alertmanager in der Konfiguration.',
    es: 'Los silencios necesitan la dirección de Alertmanager en la configuración.',
  },
  silenceDisabled: {
    en: 'Silencing is turned off in the configuration of the integration.',
    fr: "La mise en silence est désactivée dans la configuration de l'intégration.",
    de: 'Das Stummschalten ist in der Konfiguration der Integration ausgeschaltet.',
    es: 'El silenciado está desactivado en la configuración de la integración.',
  },
  badMatchers: {
    en: 'Other labels: write name=value, separated by commas.',
    fr: 'Autres étiquettes : écrivez nom=valeur, séparés par des virgules.',
    de: 'Weitere Labels: Schreibe name=wert, durch Kommas getrennt.',
    es: 'Otras etiquetas: escriba nombre=valor, separados por comas.',
  },
  noAlertname: {
    en: 'Enter the name of the alert to silence.',
    fr: "Saisissez le nom de l'alerte à mettre en silence.",
    de: 'Gib den Namen des Alarms ein, der stummgeschaltet werden soll.',
    es: 'Introduzca el nombre de la alerta que se silenciará.',
  },
  silenceRefused: {
    en: 'Alertmanager refused the silence: check the user or token rights.',
    fr: "Alertmanager a refusé le silence : vérifiez les droits de l'utilisateur ou du jeton.",
    de: 'Alertmanager hat die Stummschaltung abgelehnt: Prüfe die Rechte von Benutzer oder Token.',
    es: 'Alertmanager rechazó el silencio: compruebe los permisos del usuario o del token.',
  },
  noPromql: {
    en: 'Enter a PromQL expression.',
    fr: 'Saisissez une expression PromQL.',
    de: 'Gib einen PromQL-Ausdruck ein.',
    es: 'Introduzca una expresión PromQL.',
  },
  defaultComment: {
    en: 'Silenced from Gladys',
    fr: 'Mis en silence depuis Gladys',
    de: 'In Gladys stummgeschaltet',
    es: 'Silenciado desde Gladys',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
export const severityName = (severity, language) =>
  SEVERITY_TEXT[severity] ? pick(SEVERITY_TEXT[severity], language) : pick(NO_ALERT_TEXT, language);
/** The parts of a report, in one language: "a, b, c." */
export const sentence = (parts) => `${parts.filter(Boolean).join(', ')}.`;
