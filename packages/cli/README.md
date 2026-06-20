# @dolores/cli

Command-line interface for the dolores agent memory system. Provides `dolores init`, `dolores remember`, `dolores recall`, `dolores context`, and `dolores ingest` commands that talk to the dolores daemon over localhost HTTP.

Install globally and use from any terminal once the daemon is running.

```bash
npm i -g @dolores/cli
dolores init       # set up Postgres schema
dolores remember "We deploy on Hetzner."
dolores recall "where is production?"
```

→ See the [root README](https://github.com/yeneryigitcelik-debug/dolores#readme) for full documentation and quick start.
