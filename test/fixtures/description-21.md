Low priority. Added 2026-09-30 when odev's backlog was re-sorted under the new build skills (skills-repo 218a930).

Those skills ask that every test guarding code that decides something is proved: break what it guards, watch that test fail by name, restore, watch it pass, and record one line per test:

    Proved: <test id> fails with <what you broke> and passes with it restored

odev was built before that rule, so no test here has a Proved: line. The code that decides things:

- internal/onedev: query quoting and references (query.go)
- internal/config: project and host resolution order, git remote parsing
- internal/cmd/pr, issue, build: query builders, commit qualification, state filters
- internal/cmd/cfgcmd: value normalisation for config set
- internal/cmd/auth: hint selection
- internal/cmd/pr: merge waiting for the head to land

Run it inline, one package per commit, with the Proved: lines in the commit message. Never commit a broken version. A test that stays green when its guard is broken is a finding: fix the test with a failing run first. Docs, config and wiring have nothing to prove.

Done when every package above has its Proved: lines, and any test that could not fail has been fixed.