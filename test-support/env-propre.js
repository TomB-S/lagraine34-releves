// === Why this file? Tests must not depend on the terminal they are run from ===
// server.js reads some environment variables (CYCLOS_CHANNEL, PORT, COOKIE_SECURE...). If the person running the tests has
// exported one of them (for example CYCLOS_CHANNEL=main in ~/.zshrc), the test "CYCLOS_CHANNEL absent" fails although the
// code is correct. A test must give the same result on every machine, so we clean the environment ourselves.
//
// Two things matter here:
// 1. WHEN. server.js reads HISTORY_PAGE_SIZE and HISTORY_MAX_ROWS once, when the file is loaded (not at each start).
//    The cleaning therefore runs as soon as THIS file is loaded, and this file must be imported BEFORE server.js
//    (harness.js does it first). Each test file runs in its own Node process, so one cleaning per file is enough.
// 2. WHAT. Exactly the variables the program reads (list below). PATH, HOME, etc. stay: Node itself needs them.
//
// A test that wants a value sets it itself (`cyclosChannel: "main"` option of startServer, or `envEnfant({ ... })`
// for a child process). If you add a variable read by server.js, add it to the list: test/isolation.test.js checks
// that the list is complete by reading server.js.

export const VARIABLES_DU_PROGRAMME = [
  "CYCLOS_BASE_URL",
  "CYCLOS_CHANNEL",
  "PORT",
  "SESSION_IDLE_MINUTES",
  "SESSION_MAX_HOURS",
  "COOKIE_SECURE",
  "HISTORY_PAGE_SIZE",
  "HISTORY_MAX_ROWS",
];

// What the terminal had before the cleaning (kept only so that the isolation test can prove the variables were really there).
export const VALEURS_DU_TERMINAL = Object.fromEntries(
  VARIABLES_DU_PROGRAMME.filter((nom) => nom in process.env).map((nom) => [nom, process.env[nom]]),
);

// Removes the variables from process.env and returns a function that puts them back as they were.
// appTest calls it around each test, so a test that changes process.env cannot disturb the next one.
export function isolerEnv() {
  const avant = {};
  for (const nom of VARIABLES_DU_PROGRAMME) {
    if (nom in process.env) avant[nom] = process.env[nom];
    delete process.env[nom];
  }
  return function restaurer() {
    for (const nom of VARIABLES_DU_PROGRAMME) {
      if (nom in avant) process.env[nom] = avant[nom];
      else delete process.env[nom];
    }
  };
}

// Explicit environment for a child process (`node server.js`): the current environment WITHOUT the program's variables,
// plus the values the test wants. Instead of inheriting what the terminal exported, the test states what the child receives.
export function envEnfant(valeurs = {}) {
  const env = { ...process.env };
  for (const nom of VARIABLES_DU_PROGRAMME) delete env[nom];
  return { ...env, ...valeurs };
}

// Cleaning at load time (see point 1 above). The values of the terminal are kept in VALEURS_DU_TERMINAL.
isolerEnv();
