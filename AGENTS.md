# AGENTS.md

Shepherd is the shared library for the GitHub Copilot app's sessions: read them, message them, archive them.

- Belongs here: the app's socket and database, the session histories, the pure readers of a history, and `shepherd status`.
- Belongs in Housesitter, not here: quitting, relaunching and resuming the app, the Mac's processes, the keeper and the launch agents.
- Tests run against fakes: `test/fake-app.mjs` is a pretend socket, and sessions are in-memory. Nothing touches a real app, a real Mac or a real account.
- No machine names, account names or internal project names in code, tests, commits or PR text.
- Run `npm test`. CI also syntax-checks every `.mjs` file.
