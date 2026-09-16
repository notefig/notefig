// Run a fixture's async main: any failure goes to stderr with its stack and
// exits non-zero, so the spawning test sees why.
/* eslint-disable */
module.exports = function runMain(main) {
  main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(1);
  });
};
