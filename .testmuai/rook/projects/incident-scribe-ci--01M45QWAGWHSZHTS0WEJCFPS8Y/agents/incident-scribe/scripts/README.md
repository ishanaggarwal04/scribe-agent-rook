# scripts

The runners this agent's profiles execute. One file per phase, or one file
switching on its argument — rook only ever runs the one a profile names.

`rook profile add` writes them here and proves them against your agent, so
most of the time this fills itself. Writing one by hand is equally supported:
put it here, point a profile at it, and rook cannot tell the difference.

    hooks:
      execute: scripts/staging.mjs

The contract is one JSON object on stdout — `agent_reply` is the answer, and
the goal arrives on stdin. `rook profile fix <name>` will read what you wrote,
run it, and repair it if it does not work.
