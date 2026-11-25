# AGENTS.md

Shepherd keeps the GitHub Copilot app's sessions, as work: the one library and CLI that read them, message them, resume them and archive them, and the resident watch that runs their duties.

- Belongs here: the app's socket and database, the session histories and their readers, and every session duty: resume, the health watch, size and retirement, stuck resume, quota, the sidebar, wakes, and the agent verbs an agent such as Ouroboros calls.
- Belongs in Housesitter, not here: quitting and relaunching the app, the Mac's processes, the keeper, Housesitter's own launch agents and deploying a release (`housesitter deploy shepherd`).
- Tests run against fakes: `test/fake-app.mjs` is a pretend socket, and sessions are in-memory. Nothing touches a real app, a real Mac or a real account.
- No machine names, account names or internal project names in code, tests, commits or PR text.
- Run `npm test`. CI also syntax-checks every `.mjs` file.
- **The CLI follows [Ouro AX](https://github.com/ourostack/ouro-ui#ouro-ax).** The kit is vendored in `lib/ouro-ui` and pinned by `upstream-sources.lock.json`; never edit it by hand, copy the next Ouro UI tag instead. Teach the surface, not a doc.
- **[Images must load on the recipient's phone](https://github.com/ourostack/.github/blob/main/agents/images-load-on-mobile.md).** Attach images with the platform's own attachment (never a blob/ or raw.githubusercontent.com link, never a copy to a public place), and say only what was observed: a served upload is not a rendered page, and native Mobile and Teams rendering is unverified.

<!-- ouro-ui:bar -->
**The bar, for people and agents alike** ([design craft](https://ui.ouroboros.bot/docs/design-craft/#the-bar)): would the people who made the Mac and the iPhone ship it? Whenever you scope or design something a person or an agent meets (a screen, a menu, a setting, a command, an action, a tool, a line of output):

1. Start from the jobs people do, in their words. Read a reference product's items, a service's functions or an API's fields as evidence of jobs, never as the list to build.
2. Make the first cut restraint: for each thing, name the job it serves and ask what breaks if it goes; if nothing does, leave it out and say why. Give each job one way in, not one per item or function, and extend the one that exists before adding another.
3. Build what is left well, the basics people use daily among it, for the person and for agents, with a result that says what it did.
4. Write how fresh people or fresh agents doing a real job will prove it, and rerun them after each small change.
<!-- /ouro-ui:bar -->
