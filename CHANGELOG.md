# Changelog

All notable changes to this project will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/) and is generated with [cocogitto](https://docs.cocogitto.io/).

<!-- next-header -->

## Unreleased ([3886bac..4e6910c](https://github.com/codefuturist/email-mcp/compare/3886bac..4e6910c))

#### ✨ Features

- **(alerts)** add notification setup diagnostics and AI-configurable alerts - ([34e288a](https://github.com/codefuturist/email-mcp/commit/34e288acb3a3330fd4eca0a583540ec877d9912c))
- **(alerts)** add urgency-based multi-channel notification system - ([b2425df](https://github.com/codefuturist/email-mcp/commit/b2425df6c917436e056e5cc8002ce684fc898694))
- **(cli)** add notify command for testing desktop notifications - ([687f7d2](https://github.com/codefuturist/email-mcp/commit/687f7d26449d97d56bd9d94b7e67f3b798b8e13e))
- **(cli)** add interactive MCP client installation command - ([e2369c7](https://github.com/codefuturist/email-mcp/commit/e2369c7f03df1e506b0bb11e0e5c471a0313ec6b))
- **(cli)** add interactive account CRUD and config edit commands - ([aaa8af5](https://github.com/codefuturist/email-mcp/commit/aaa8af501e7738cf049bd0b4a29ee74f0dbee3bb))
- **(hooks)** add customizable presets and static rule matching - ([138c08e](https://github.com/codefuturist/email-mcp/commit/138c08e0708f49e795e036e2245022fe060a0950))
- **(watcher)** add IMAP IDLE monitoring with AI triage - ([5ed0388](https://github.com/codefuturist/email-mcp/commit/5ed0388ccb0a781220407b3800723bf8191eb2f9))
- add AI-optimised email tools and context improvements - ([d7b01a4](https://github.com/codefuturist/email-mcp/commit/d7b01a48e57491d68ac605583ede6c1a92b2b70d))
- add provider-aware label management (ProtonMail/Gmail/IMAP keywords) - ([85609e5](https://github.com/codefuturist/email-mcp/commit/85609e5f181ea3c01ef26b4fe27a69bafb549141))
- add IMAP move/delete reliability and find_email_folder tool - ([3886bac](https://github.com/codefuturist/email-mcp/commit/3886bacc83eb8b4200f16695468e9029ade32c40))

#### 🐛 Bug Fixes

- **(cli)** add TTY guard and fix IMAP STARTTLS display - ([d9bca69](https://github.com/codefuturist/email-mcp/commit/d9bca695af07e311ec249379827c175e8dac483b))
- virtual folder detection and find_email_folder reliability - ([3c44c22](https://github.com/codefuturist/email-mcp/commit/3c44c226e7b3bf2666479e4d5761c8777d8c5e9c))

#### 📚 Documentation

- update tool count to 42 in README - ([4e6910c](https://github.com/codefuturist/email-mcp/commit/4e6910c04a8dd46efc739079c8e6aa613a7edfaf))
- add pnpm install and usage instructions - ([13c8d4b](https://github.com/codefuturist/email-mcp/commit/13c8d4bf3006fa4fb5f014eb630006a478082a23))

- - -
## [v0.3.0](https://github.com/codefuturist/email-mcp/compare/03b3b0233e5e65b1fa30324f3859860e061b364d..v0.3.0) - 2026-06-15
#### ✨ Features
- (**bin**) add lifecycle wrapper to prevent orphan email-mcp processes - ([1d29290](https://github.com/codefuturist/email-mcp/commit/1d29290780faba7adb2812b28ac6eb86e45db6d5)) - David Young, Claude Opus 4.7
- (**db**) email_mcp schema migration 001 + forward-only migrate runner (#9) - ([fb40334](https://github.com/codefuturist/email-mcp/commit/fb40334f2ae221a5d898c22e35c531456e649162)) - David Young, Claude Opus 4.7
- (**drafts**) add attachment support to save_draft and new update_draft tool (#7) - ([c824407](https://github.com/codefuturist/email-mcp/commit/c824407de9809e3d783d185346d86a23001f14cc)) - David Young
- (**export**) export_search + save_attachment + batch attachment save - ([60c5de3](https://github.com/codefuturist/email-mcp/commit/60c5de3593f4c6e72b3bfc103190eb2e8c484902)) - Your Name
- (**routing**) minimal cross_account_move tool (D8/D9/D15/D18) (#11) - ([1d7112f](https://github.com/codefuturist/email-mcp/commit/1d7112f9560c183e16260b2c1c0388317cfd762a)) - David Young, Claude Opus 4.7
- (**search**) bounded deep search + restore body-in-default (PR-2) (#13) - ([c80303c](https://github.com/codefuturist/email-mcp/commit/c80303c0581ced1f55c36843cf32d89941509de4)) - David Young
- (**search**) auto-remap mailbox via SPECIAL-USE for cross-account - ([f2f75ea](https://github.com/codefuturist/email-mcp/commit/f2f75ea52b137a6f969b023ba322fe2992a5b08c)) - Your Name, Claude Opus 4.7 (1M context)
- (**search**) cross-account search + saved-search presets - ([52512ef](https://github.com/codefuturist/email-mcp/commit/52512efd5cf2d4de4a0cb7f2e3d5f0979b8a00da)) - Your Name, Claude Opus 4.7 (1M context)
- (**search**) attachment metadata filters + faceted counts - ([c9c8faa](https://github.com/codefuturist/email-mcp/commit/c9c8faa6e663f64030020a03812a5fe1efb3be5a)) - Your Name
- (**search**) server-side filter parity, perf fixes, Gmail fast path - ([27a070f](https://github.com/codefuturist/email-mcp/commit/27a070fbbf84f6e96ed18ea072bef2edd9557a61)) - Your Name, Claude Opus 4.7 (1M context)
- (**smtp**) add includeAttachments option to reply_email tool - ([3753fdd](https://github.com/codefuturist/email-mcp/commit/3753fddb6ee5fd6204e9d25d163d91ffb21e515a)) - David Young, Claude Sonnet 4.6
- (**smtp**) add includeAttachments option to reply_email tool - ([470ad56](https://github.com/codefuturist/email-mcp/commit/470ad560cad81a6ed77d46ec47bcc5b701970aeb)) - David Young, Claude Sonnet 4.6
- (**smtp**) append sent messages to IMAP Sent folder after send - ([ea74211](https://github.com/codefuturist/email-mcp/commit/ea74211a3a782ab3599398a5f17a79c3dd7170ab)) - David Young, Claude Opus 4.6
#### 🐛 Bug Fixes
- (**attachments**) unify attachment detection across all IMAP code paths (#14) - ([f91f427](https://github.com/codefuturist/email-mcp/commit/f91f42731b52f8ae7e3c0c34c1c0b0787c54bb78)) - David Young, Claude Opus 4.7 (1M context)
- (**bin**) use exec so wrapper does not break stdio JSON-RPC - ([df3bd37](https://github.com/codefuturist/email-mcp/commit/df3bd37e800914a97422ff16f5a154b7360e895f)) - David Young, Claude Opus 4.7
- (**drafts**) preserve attachments when sending drafts - ([02891fa](https://github.com/codefuturist/email-mcp/commit/02891fa7ab36f51698ce626919717de9c7defcaa)) - David Young, Claude Opus 4.8
- (**imap**) MIME-aware body extraction (empty multipart/Gmail/forwarded bodies) (#15) - ([9794101](https://github.com/codefuturist/email-mcp/commit/9794101e0b16ded3830b894dea4797892f66acae)) - David Young, Claude Opus 4.7 (1M context)
- (**imap**) harden envelope-date parsing against malformed Date headers (#6) - ([e77a1c7](https://github.com/codefuturist/email-mcp/commit/e77a1c7a492442db66f0dd7e836126d391e4701a)) - David Young, Claude Opus 4.7, Claude Opus 4.7, Claude Opus 4.7
- (**search**) never present a failed IMAP SEARCH as a clean zero (PR-1) (#12) - ([56b1f2c](https://github.com/codefuturist/email-mcp/commit/56b1f2cb6654c3b06037cba0933b6021e6bf85e8)) - David Young, Claude Opus 4.7 (1M context)
- (**search**) align has_attachment boolean with attachments[] helper - ([eb2c6ce](https://github.com/codefuturist/email-mcp/commit/eb2c6ce9b5045681d374f633143677505668d2b9)) - Your Name, Claude Sonnet 4.6
- (**smtp**) pass explicit SMTP envelope on reply (fixes "No recipients defined") - ([94a64a6](https://github.com/codefuturist/email-mcp/commit/94a64a6bfe33d356b6e1d0aae78d7a86efb910a6)) - David Young, Claude Opus 4.8 (1M context)
- (**smtp**) explicit /index.js suffix on MailComposer import - ([0209649](https://github.com/codefuturist/email-mcp/commit/020964924d646a414f352ce46b7be1a719ecbf93)) - David Young, Claude Sonnet 4.6
- (**smtp**) replace require() with ESM import for MailComposer - ([457d59e](https://github.com/codefuturist/email-mcp/commit/457d59e85dd2dfaaeb829579a470855f2e2687d9)) - David Young, Claude Sonnet 4.6
- (**smtp**) resolve correct Sent folder and harden RFC compliance - ([f54e8b7](https://github.com/codefuturist/email-mcp/commit/f54e8b7e3c8f286630e3a0e9d37fb8cb580ab099)) - David Young, Claude Opus 4.6
#### 📚 Documentation
- (**config**) add example config and cpanel sent folder troubleshooting - ([e3a39cc](https://github.com/codefuturist/email-mcp/commit/e3a39cca8b83667cec14d8712ce0ab71a2ebeb4d)) - Your Name
- (**db**) provisioning must reassign public schema owner to email_mcp (#10) - ([92f1409](https://github.com/codefuturist/email-mcp/commit/92f14097d0c9402f937606b28ce2c1774bdd9339)) - David Young, Claude Opus 4.7
- (**mcp**) teach the LLM to consider Archive folders and require date filters - ([768e1e2](https://github.com/codefuturist/email-mcp/commit/768e1e2af2e0ee1412bebf86ce5ad246870281be)) - David Young, Claude Opus 4.7
- add Mistral Vibe MCP client installation instructions - ([643fb18](https://github.com/codefuturist/email-mcp/commit/643fb18b9e0c3c241143991db6825d7ca174921a)) - Colin
- add scheduler daemon setup instructions and delivery requirements - ([cbc3042](https://github.com/codefuturist/email-mcp/commit/cbc3042bcc4ae8c33e7586519b7065ba2b0f264d)) - Colin
- expand VS Code Copilot setup (all 3 methods) and add Zed client - ([9e1f785](https://github.com/codefuturist/email-mcp/commit/9e1f78518833048c9fd56a37110d0dc54da538ce)) - Colin
#### Tests
- (**attachments**) regression for Apple-Mail inline PDF in nested MIME (#17) - ([ac2c535](https://github.com/codefuturist/email-mcp/commit/ac2c5352ad270fb3cecdb71cab790e4a7bd3f21f)) - David Young, Claude Opus 4.8 (1M context)
#### ♻️ Refactoring
- (**smtp**) extract fetchAttachment helper to satisfy biome pre-push check - ([a2d08a5](https://github.com/codefuturist/email-mcp/commit/a2d08a5d74dba6b89462cfc5c3bdd74541652f61)) - David Young, Claude Sonnet 4.6
#### Chores
- (**gitignore**) ignore stray config.toml inside repo dir - ([988773b](https://github.com/codefuturist/email-mcp/commit/988773b59813cf1c2ce2643b33a39472e5f900e8)) - David Young
- (**gitignore**) ignore scheduled task - skills/ - ([b766228](https://github.com/codefuturist/email-mcp/commit/b766228a8747856136fc68ad072a673a59c69805)) - David
- remove stray package-lock.json and ignore non-pnpm lockfiles - ([749179d](https://github.com/codefuturist/email-mcp/commit/749179d93a09adc9157ed0a5cb6ad9b648a6aa63)) - David Young, Claude Opus 4.7
- normalize server.json formatting - ([4034b78](https://github.com/codefuturist/email-mcp/commit/4034b78715f1ab20306f969ec963b9f0df0aae4d)) - Colin, Copilot
- fix cog post_bump_hooks to sync package.json and server.json versions - ([03b3b02](https://github.com/codefuturist/email-mcp/commit/03b3b0233e5e65b1fa30324f3859860e061b364d)) - Colin
#### Styles
- (**imap**) fix biome formatting in resolveSentFolder - ([293accc](https://github.com/codefuturist/email-mcp/commit/293accc8284272888a31cb87aadd31ab96a9ae7d)) - David Young, Claude Opus 4.6
- (**smtp**) disable implicit-arrow-linebreak for fetchAttachment - ([2a3a187](https://github.com/codefuturist/email-mcp/commit/2a3a1874757160e474d0b44d941c103107ff98de)) - David Young, Claude Sonnet 4.6
- (**smtp**) split fetchAttachment arrow to comply with biome line-length - ([3a0ea67](https://github.com/codefuturist/email-mcp/commit/3a0ea6799b3d7dfe3e3dedd7acf0718a171c89bc)) - David Young, Claude Sonnet 4.6
- (**smtp**) split fetchAttachment arrow to comply with biome line-length - ([9e9efe4](https://github.com/codefuturist/email-mcp/commit/9e9efe4597fbdacbd3ddee2d82a5efbfa8106b7e)) - David Young, Claude Sonnet 4.6
- (**smtp**) split fetchAttachment arrow to satisfy biome line-length rule - ([8d338f4](https://github.com/codefuturist/email-mcp/commit/8d338f4201eef401b409aeff05a8f1b7a09c3caf)) - David Young, Claude Sonnet 4.6
- (**smtp**) apply biome formatting for fetchAttachment arrow function - ([60e653a](https://github.com/codefuturist/email-mcp/commit/60e653abd44c823834a2a8bb005bee68e9e7d143)) - David Young, Claude Sonnet 4.6
- (**smtp**) fix biome arrow function line break - ([5094e97](https://github.com/codefuturist/email-mcp/commit/5094e97c3832f995508ea5761a872243bf97bc38)) - David Young, Claude Sonnet 4.6
- (**smtp**) apply biome formatting - ([a038e53](https://github.com/codefuturist/email-mcp/commit/a038e536f15563f2516d20e465027dbf095555b8)) - David Young
- (**smtp**) apply biome formatting - ([31ac61f](https://github.com/codefuturist/email-mcp/commit/31ac61fbb25d2fa96606e75cad360120b4176db9)) - David Young

- - -

## [v0.2.1](https://github.com/codefuturist/email-mcp/compare/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0..v0.2.1) - 2026-02-20
#### 🐛 Bug Fixes
- (**labels**) fix critical parameter swap and multiple label bugs - ([bd6f94d](https://github.com/codefuturist/email-mcp/commit/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0)) - Colin
- defer post-connect work until MCP handshake completes - ([7847da0](https://github.com/codefuturist/email-mcp/commit/7847da07b4241e73282b2a36a9dd1a362dfb8656)) - Colin
#### Tests
- (**integration**) expand plain connection tests to match STARTTLS and SSL coverage - ([8bd3d77](https://github.com/codefuturist/email-mcp/commit/8bd3d7752ca18037ca899899a1e14688b961c0b1)) - Colin
- (**integration**) add connection mode tests for plain, STARTTLS, and implicit SSL - ([ccbefb7](https://github.com/codefuturist/email-mcp/commit/ccbefb78248f0f08d31c5b227347f286f350c9f9)) - Colin
- (**integration**) add integration test suite with GreenMail and Testcontainers - ([1cc72fe](https://github.com/codefuturist/email-mcp/commit/1cc72fec8166842fa92ad8c7957c2ec28df327ac)) - Colin
#### Build
- (**docker**) add OCI manifest annotations for GHCR multi-arch images - ([2aeb938](https://github.com/codefuturist/email-mcp/commit/2aeb93857e95d99b2cf4435e4eee7cd7a47aecdc)) - Colin
- (**docker**) add docker and goreleaser scripts, fix build for dockers_v2 context - ([56102f4](https://github.com/codefuturist/email-mcp/commit/56102f42ce81bba8c9ab8f442926d1b9704d2ab4)) - Colin
- (**docker**) add GoReleaser dockers_v2 for GHCR and Docker Hub publishing - ([83483a8](https://github.com/codefuturist/email-mcp/commit/83483a8879228b3ec213414f2f7c53e9cce3f497)) - Colin
- (**docker**) add Dockerfile, docker-compose, and CI docker build - ([e9f0a9f](https://github.com/codefuturist/email-mcp/commit/e9f0a9f2179a59de064879456204c8c3b4f3945b)) - Colin
- add lefthook git hooks, report output, upgrade actions and node to v24 - ([8665419](https://github.com/codefuturist/email-mcp/commit/86654197b1a1f252d6c67d8a5fd67f09100f4fd4)) - Colin
#### CI
- (**docker**) enable docker hub publishing - ([f2a8d44](https://github.com/codefuturist/email-mcp/commit/f2a8d44fb8e503a0ef053a716e00b5814625daf8)) - Colin
- refactor workflows to use codefuturist/shared-workflows@v1 - ([815292c](https://github.com/codefuturist/email-mcp/commit/815292c91e6215592cd3172a91600cf42b2224e0)) - Colin
- add docker-sha workflow, workflow_dispatch, action upgrades and lint fixes - ([ddfbcdc](https://github.com/codefuturist/email-mcp/commit/ddfbcdc27af83175c3fec3c666ebd1f23d0631f4)) - Colin
- improve Docker tag strategy - ([99785a0](https://github.com/codefuturist/email-mcp/commit/99785a0ea5c01579046783c3fdf7347932e77fdb)) - Colin
- add weekly Docker rebuild workflow for base image updates - ([08f77f9](https://github.com/codefuturist/email-mcp/commit/08f77f9d06c8fd5b6de65a08c9ff89b556e7f2c0)) - Colin
#### Chores
- (**eslint**) exclude integration tests from eslint - ([e3bcc12](https://github.com/codefuturist/email-mcp/commit/e3bcc122bb9d71bfdfd77040d4419b96296a162d)) - Colin
- (**gitignore**) update .gitignore to include comprehensive rules for various environments and tools - ([4c55dea](https://github.com/codefuturist/email-mcp/commit/4c55dea709e592f3e9f8b01d449846742774c07f)) - Colin
- fix changelog separator for cocogitto - ([55510c3](https://github.com/codefuturist/email-mcp/commit/55510c34bb44ac377e91e1c628d7a810ed2e6d6e)) - Colin

- - -


## [v0.1.0](https://github.com/codefuturist/email-mcp/releases/tag/v0.1.0) — Initial Release

First public release of email-mcp.

#### ✨ Features

- Full IMAP + SMTP email server for MCP clients
- 42 tools, 7 prompts, 6 resources
- Multi-account support with XDG-compliant TOML config
- Guided interactive setup wizard with provider auto-detection
- Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX support
- OAuth2 XOAUTH2 for Gmail and Microsoft 365 _(experimental)_
- Email scheduling with OS-level scheduler integration
- Real-time IMAP IDLE watcher with AI-powered triage
- Urgency-based desktop / webhook alerts
- Provider-aware label management
- ICS/iCalendar extraction from emails
- Email analytics (volume, top senders, daily trends)
- Token-bucket rate limiter and audit trail
- MCP client auto-installer (Claude Desktop, VS Code, Cursor, Windsurf)
