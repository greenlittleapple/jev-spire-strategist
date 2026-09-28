# Jev Game Lab

When working on TypeSafe/Jev integration, question design, uncertainty handling, or game decision logic, read and use the project-local [TypeSafe skill](.agents/skills/typesafe-ai/SKILL.md). Follow its targeted links to current official documentation as relevant to the change.

The selected game is Slay the Spire 2. Live Jev 1.13.0 has selected and executed a starting-relic choice. Start testing at Ascension 0; Ascension 10 strength remains unverified. Keep the user's existing gameplay mods enabled. See docs/STS2.md and docs/STS2-VERIFICATION.md for current integration and evidence. Existing confidence thresholds in the separate generic harness remain provisional.

Claude strategy layer: while the STS2 runner is active, a Claude Code session acts as strategist through `npm run sts2:strategy -- wait | show | answer`. Follow docs/STS2.md#claude-strategy-layer. Plans must use only the brief's information and keep strings short. Running the watcher does not authorize starting Autoplay or a new run.
