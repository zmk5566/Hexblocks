# Extension board reference

`extension-board.js` contains the curated `new-ver-hub` pin snapshot used by
both the chat prompt and connector diagram. This first version offers wiring
guidance in the existing LLM panel; it does not run retrieval tools, compile
firmware, flash a board, or register a proposed module.

Use **＋ 自定义模块** or describe a custom module in chat. Wiring follow-ups
remain in extension mode until **结束接线讨论** is selected. Full `.ino` drafts
are offered only on request and are not represented as tested firmware.

When the board changes, check connector pad nets against
`hexhardware/new-ver-hub/new-ver-hub.kicad_pcb`, update the snapshot date and
prompt restrictions, and recheck the diagram. Old review documents describe
different connector revisions. The diagram shows pin numbering, not physical
position or mating orientation.

The firmware summary references
`hardware/firmware/module_led/module_led.ino`; its default child detection
pins must not be copied unchanged to this board. Recheck this summary when
the example changes. This text-only chat does not accept board photographs.

Run conversation routing and mocked streaming checks from the repository root:

```sh
node --test frontend/test/extension-module.test.mjs
```
