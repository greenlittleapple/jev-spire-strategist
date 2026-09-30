# Jev Game Lab

When working on TypeSafe/Jev integration, question design, uncertainty handling, or game decision logic, read and use the project-local [TypeSafe skill](.agents/skills/typesafe-ai/SKILL.md). Follow its targeted links to current official documentation as relevant to the change.

The selected game is Slay the Spire 2. Live Jev 1.13.0 has selected and executed a starting-relic choice. Start testing at Ascension 0; Ascension 10 strength remains unverified. Keep the user's existing gameplay mods enabled. See docs/STS2.md and docs/STS2-VERIFICATION.md for current integration and evidence. The plan of record is docs/PLAN.md (benchmark decisions, ordered next steps, open items); read it before continuing the work and update it whenever the plan changes.

Claude strategy layer: while the STS2 runner is active, a Claude Code session acts as strategist through `npm run sts2:strategy -- wait | show | answer`. Follow docs/STS2.md#claude-strategy-layer. Plans must use only the brief's information and keep strings short. Running the watcher does not authorize starting Autoplay or a new run.

Strategist brief: the agent that answers STS2 strategy requests works from docs/STS2-STRATEGIST.md (the loop, request reasons, brief, plan fields and how code enforces them, checked examples). The parent session spawns a `general-medium` agent with it rather than answering itself.

Tests: CI runs `npm test` on a Windows checkout with CRLF line endings, so a test that parses a committed text file must accept CRLF (normalize `\r\n` to `\n` when reading). Committed files must not contain local user paths, drive paths, personal emails, Steam IDs or keys; `integration/sts2/privacy.test.mjs` checks this. Every commit on `main` publishes to the public repository.
