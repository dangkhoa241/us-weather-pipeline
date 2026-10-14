# Previous Runs gap fill: validation

Question: can Open-Meteo's Previous Runs API fill the empty accuracy slots of the 4 backfilled models (gfs_hrrr,
gfs_global, ecmwf_ifs025, icon_global) without changing the scores? Gate: the lead-day-1 MAE of the two sources on the
same city-hours must differ by at most **0.1 °F** for every model before anything is filled
(`MAX_DAY1_DIFF_F` in `src/stage1/openMeteoGapFill.js`).

## Method

`node fetchWeather.js om-gap-fill --from 2026-07-12 --to 2026-10-09 --validate` (run 2026-10-14 18:02 UTC):
- For every model and city, the days that already have collected lead-day-1 rows (Single Runs backfill or live
  `om-forecast`), sampled as at most the last 14 days of each run of such days: 379 requests, 379 weighted calls.
- On each city-hour that has a collected row, a Previous Runs `temperature_2m_previous_day1` value and an observation:
  collected MAE = the average over every collected run (as the accuracy views score them, up to 4 runs per hour);
  Previous Runs MAE = one value per city-hour. Nothing is written.

## Result

| Model | City-hours | Collected rows | Collected MAE | Previous Runs MAE | Difference | Within 0.1 °F |
|---|---|---|---|---|---|---|
| ECMWF (ecmwf_ifs025) | 14,454 | 44,460 | 1.951 °F | 1.744 °F | **−0.207 °F** | no |
| HRRR (gfs_hrrr) | 11,100 | 38,892 | 2.824 °F | 2.697 °F | **−0.127 °F** | no |
| ICON (icon_global) | 14,700 | 45,444 | 2.168 °F | 2.080 °F | −0.089 °F | yes |
| GFS (gfs_global) | 14,610 | 45,084 | 3.049 °F | 2.971 °F | −0.078 °F | yes |

Previous Runs is better for every model. That points to a different lead time, not to bad data. Our lead day 1 is
24–47 h after the run (`floor(lead_hours / 24)`), and its error grows with the lead: ECMWF 1.90 °F at 24–29 h, 2.00 at
30–35 h, 2.06 at 36–41 h and 2.13 at 42–47 h (ClickHouse, same 90 days). Previous Runs "day 1" is lower (1.74 °F) than
even the shortest of those buckets, so it is probably taken from a run closer to the target than 24 h. Open-Meteo
doesn't report which run each value comes from. Not investigated further (time-boxed).

## Decision

**Not used: failed validation (ECMWF -0.21 °F, HRRR -0.13 °F).** Filling would make ECMWF look about 0.2 °F better
than it is on the filled days. Decision (2026-10-14): leave accuracy to the Single Runs backfill and fill no model from
Previous Runs. The code stays as a documented experiment: `node fetchWeather.js om-gap-fill` (with `--dry-run` or
`--validate`) runs by hand only, is in no schedule and not in `refresh:snapshot`, and writes nothing unless the latest
validation passed for every model. Its supersede pass (which excludes a filled row once a collected row lands in its
slot) runs only inside a fill, not in the pipeline: even with no filled rows its check scans the whole collection
(11 s), too much for every 3-hour run.

The Single Runs API keeps runs back to 2026-04-02 for all 4 models (probed 2026-10-14; 2026-04-01 is "not
available"), so the backfill can still reach every day of the 90-day window; 64,689 runs were left, about 3-4 weeks of
daily running.

Options that were considered:
- compare Previous Runs day N with collected rows of lead 24·N … 24·N + 5 h only, and fill as a separate lead
  definition;
- fill only the models that pass (GFS, ICON), which would need its own gate per model;
- leave accuracy to the Single Runs backfill (chosen).
