# Voice run results

`pnpm voice:report` wrote this at 2026-09-27 21:41 UTC, from 9 scripted calls since 2026-09-27 21:36 UTC.
Each call is a real GPT-Live session. The caller speaks with prerecorded clips through the test voice, so the end of each clip is exact.
The browser measures all times on the agent's audio.
GPT-Live finishes its current sentence before it yields to a caller who talks over it.

## Latency

| Measure | p50 | p95 | Samples |
| --- | --- | --- | --- |
| Tap to live session | 672 ms | 940 ms | 9 |
| Tap to first agent audio | 1886 ms | 1956 ms | 9 |
| End of caller's speech to agent reply | 1125 ms | 1253 ms | 16 |
| Caller talks over agent to agent quiet | 935 ms | 1623 ms | 2 |

## Scenarios

20 of 20 checks passed.

| Scenario | Runs | Ran to the end | Checks | First audio p50 |
| --- | --- | --- | --- | --- |
| happy | 1 | 1 | pass 1/1: name and need captured<br>pass 1/1: no re-ask of the need<br>pass 1/1: the agent ended the call<br>pass 1/1: recap text within 8 s | 1732 ms |
| spelled_name | 1 | 1 | pass 1/1: spelled name kept exactly<br>pass 1/1: recap text within 8 s | 1926 ms |
| interrupt | 1 | 1 | pass 1/1: went quiet within 2 s of the interruption<br>pass 1/1: did not guess the price | 1660 ms |
| interrupt_greeting | 1 | 1 | pass 1/1: went quiet within 2 s of the interruption<br>pass 1/1: still said it is an AI<br>pass 1/1: did not guess the price | 1920 ms |
| silence | 1 | 1 | pass 1/1: checked in after the silence<br>pass 1/1: the call ended<br>pass 1/1: carried on by text | 1804 ms |
| spanish | 1 | 1 | pass 1/1: replied in Spanish | 1956 ms |
| bot | 1 | 1 | pass 1/1: said it is an AI | 1918 ms |
| gotta_go | 1 | 1 | pass 1/1: hung up within 15 s<br>pass 1/1: recap text within 8 s | 1886 ms |
| drop | 1 | 1 | pass 1/1: classified as a drop<br>pass 1/1: texted within 8 s of the drop | 1741 ms |

## Runs with a problem

None.
