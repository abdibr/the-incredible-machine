# 06: Candle lit/unlit state model

**Class:** incomplete implementation

**What to build:** A candle has a lit/unlit state machine. The flame sensor body only exists/activates while lit (so unlit candles don't burn ropes or pop balloons); extinguishing turns it off; lighting (relight) turns it on. State changes emit events (e.g., `candle:lit`, `candle:extinguished`) that later rows consume (fan blow-out — ticket 09; fuse ignition — ticket 17). Lit-by-default on placement preserves today's behavior; state is snapshot-safe. (Original: candles are portable flame/light sources that fan airflow can extinguish — objects.csv candle row; interactions I020.)

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Candle state (lit/unlit) captured and restored through the lifecycle contract
- [ ] Flame sensor inactive when unlit (no rope severing, no balloon pops from an unlit candle)
- [ ] Public methods to extinguish and light (event-emitting, callable from future matrix rows)
- [ ] Default placement is lit → all existing candle behavior/tests unchanged
- [ ] Full suite green