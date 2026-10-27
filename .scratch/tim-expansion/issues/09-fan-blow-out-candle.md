# 09: Fan blows out a lit candle + fan on/off state

**Class:** missing interaction (+ fan incomplete implementation)

**What to build:** Fan gains an on/off state (today it is always-on), and its airflow extinguishes a lit candle when the flame is inside the effective airflow zone (interactions.csv I020: fan_airflow extinguishes lit_candle). Uses the impulse-field primitive from ticket 01 for reach detection and the candle state model from ticket 06 for the extinguish path (`candle:extinguished`). After the flame goes out the candle stops behaving as a flame source (no rope/burn interactions).

**Blocked by:** 01 (discovery/field seam), 06 (candle state model).

**Status:** ready-for-agent

- [ ] Fan can be toggled off (no airflow, no candle influence) without removing the object
- [ ] Fan airflow reaching a lit candle extinguishes it (one-shot; no repeated events)
- [ ] An unlit candle is unaffected by airflow
- [ ] Snapshot/restore preserves fan state and candle state consistently
- [ ] Matrix row documents the I020 mapping; fan regression tests green