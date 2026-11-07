# Manchester Fried Chicken poker bot

Heads-up no-limit hold'em bot for the Manchester AI Society competition
(https://poker-arena-site.vercel.app). This folder is a copy of the
organisers' starter repo (github.com/Manchester-AI-Society/poker_bot) with
our bot added. Run everything from this folder with `.venv/Scripts/python`.

## What the competition actually is (read from the engine code)

| Question | Answer |
|---|---|
| Format | One heads-up round robin. Each pairing is a **duplicate match**: 200 deals (organiser default), every deck played once per seat. Score = pooled **bb/100** over every hand against every opponent (`evals/score.py`). |
| Stacks / blinds | 500 chips, blinds 10/20: **25 big blinds**, reset every hand. Button = small blind, acts first preflop. |
| Memory | The model is unpickled **fresh for each seat rotation**, then keeps its attributes for that rotation's 200 hands. Opponents are identified by `game_state.teams`. |
| What we see | `seed(hand, player_id)`; `run(actions, game_state)` with every action since our last turn; `end_game` with showdown cards (`reveal_card` by a player) and `win`s. |
| Faults | Exception / illegal move / > 10 s: the engine checks or folds for us; a timeout kills the bot for the rest of the match. |
| Submission rules | Bot files must be **flat .py files next to model.py** (no packages); `getattr`/`hasattr`/`type()`/`os`/`sys` are flagged for review; numpy isn't guaranteed, so the bot is pure Python. |

## Files

Submitted (what `python -m submit` lists):

- `model.py`: the bot.
- `handeval.py`: a fast hand evaluator on integer cards (a prime-product table for non-flush hands, a bitmask table for flushes), built in memory on import in ~0.2 s. It matches `card_utils.evaluate` on 20,000 random hands with 0 mismatches and is ~50x faster (2.3M evals/s).
- `preflop_table.py`: a 169x169 all-in equity table (20,000 Monte Carlo samples per pair), embedded as a hex string (124 KB).

Offline tools (not submitted): `build_preflop.py` (regenerates the table on every core), `bench.py` (parallel duplicate-match benchmark), `sparring.py` (6 extra opponent styles), `trace.py` / `diff.py` (decision traces), `model_v1.py` / `model_v2.py` (earlier versions kept for A/B tests).

## Strategy

Every decision is **expected-value maximisation against an explicit opponent range**.

**Opponent model (per team name, learned within each rotation).** At each decision node (`sb_open`, `bb_limp`, `bb_raise`, `pf_3b`, `pf_allin`, `post_open`, `post_bet`, `post_raise`, `post_allin`), the opponent is modelled as acting by hand strength *u*: aggressive if *u > Ta*, continue if *u > Tc*, else fold. Ta and Tc are fitted by bisection from every observed action **together with the range they held at that moment**, plus 4 prior pseudo-observations. So "folds 50% to a 3-bet" is learned relative to how strong their range already was. This was the fix for v1's biggest leak: shoving junk into tight 3-bet ranges.

The model also learns a **noise/bluff rate** for each action type in two ways: from showdowns (did their shown hand fit their thresholds?) and from aggression frequency (more value-raising than is plausible means the excess is bluffs). This widens their range after raises against maniacs while keeping it narrow against honest bots.

**Preflop.** The opponent's range is a strength band (an equity-vs-random ordering) that is narrowed by each of their actions. The candidates are fold, call/limp, an open (2.5bb) or 3-bet (3x), and all-in. Each is scored from the equity table: their fold, call and re-raise shares come from the fitted thresholds; calls apply a position-dependent equity-realisation factor; and when they re-raise, we take whichever of folding or calling all-in pays more.

**Postflop.** The opponent's 1,326-combo range is built from the preflop band, then reweighted by each postflop action on that street's board, using combo strength (made-hand percentile, lifted for flush and straight draws) and the fitted thresholds. Monte Carlo (≤2,500 samples, time-capped) records each sample's opponent strength. That gives equity against the part of their range that **continues** after a bet of each size (⅓, ⅔, pot, all-in), so bet and raise EV includes fold equity, re-raise risk and realisation. Near-equal options are mixed (softmax), so play isn't fully deterministic.

**Safety.** All of `run` is wrapped in try/except, then the action is checked with `validate_action`. The fallback is check, or fold when facing a bet. Monte Carlo stops at 1.5 s, but real decisions take 10–30 ms on average and 0.19 s at most. The bot plays 3+ player tables with a simple equity fallback.

## Results

`bench.py`: 32 matches × 200 deals × both seats per opponent (12,800 hands each), with the arena's seat swapping.

| Opponent | bb/100 | ±95% | As button | As BB |
|---|---|---|---|---|
| fold | +75.0 | 0.0 | +100 | +50 |
| call | +416.7 | 14.7 | +401 | +432 |
| random | +223.6 | 19.2 | +270 | +178 |
| shove | +165.1 | 21.0 | +156 | +174 |
| tight | +66.0 | 4.6 | +95 | +37 |
| equity | +111.8 | 13.5 | +100 | +123 |
| maniac | +196.4 | 20.2 | +188 | +205 |
| station | +177.5 | 14.7 | +183 | +172 |
| nit | +47.0 | 6.4 | +52 | +42 |
| pushfold | +89.3 | 15.7 | +153 | +26 |
| smarteq | +64.0 | 14.6 | +53 | +75 |
| minraise | +133.4 | 4.1 | +110 | +157 |
| v1 (first version) | +26.0 | 13.2 | +41 | +12 |
| v2 (no noise model) | +0.9 | 11.8 | +36 | −34 |

0 faults across every run. Max decision time 0.19 s, average 2–31 ms.

Official `python -m evals --deals 500`: ahead of all six dummies (fold +75, call +402, random +128, shove +176, tight +58, equity +73), 0 faults, slowest move 0.03 s.

Version history (head-to-head and the key opponents):

- v1: frequency-based opponent model. Tight +18, nit +5, smarteq +5.
- v2: threshold opponent model. Beats v1 by +33 ± 16. Tight +65, nit +43, smarteq +57, but random fell from +354 to +204.
- v3–v5: showdown, aggression and looseness noise rates. About equal to v2 against the field (+1 ± 12 head to head); kept for robustness against bluff-heavy bots.

## Known weaknesses

1. **Over-folds to random-sized aggression.** It folds to big raises from bots like RandomBot because it rarely sees a showdown of those raises. v1 made +354 against RandomBot vs our +224. Fixing this needs exploration calls, which cost chips against honest tight bots.
2. **Sizing is not modelled.** Opponent ranges don't depend on their bet size (a min-raise and a 15bb raise are read the same way), and our fold-equity size adjustment is a heuristic.
3. **Single-street EV.** There's no explicit multi-street planning (implied odds, barrelling plans); later streets enter only through realisation factors.
4. **Not a GTO solver.** There's no CFR equilibrium baseline. At 25bb a push/fold Nash chart plus the EV engine would be a natural next step. Mixing exists, but a strong adaptive opponent could exploit our preference for the max-EV action.
5. **Big-blind defence against shove-happy bots** is only +26 (pushfold).

## v6: research-driven upgrade (equilibrium + safe exploitation + re-solving)

Based on Libratus, DeepStack, DecisionHoldem and Pluribus (blueprint plus real-time subgame solving) and on safe-exploitation work (restricted Nash response, data-biased response).

- **Preflop blueprint** (`solve_preflop.py` → `preflop_nash.py`): vector CFR+ over the 169 classes for the real 25bb game (fold / limp / open 2.5bb / 3-bet 7.5bb / iso 4bb / shove). It converged to 0.03 mbb/hand exploitability within the abstraction. Any raise size maps to the nearest abstract action.
- **Targeted exploitation** (data-biased): the bot plays the equilibrium and deviates only on deviations it has *measured directly*:
  - **steal**: limps become opens when their fold-to-open rate is at least 55%;
  - **isolate**: checks become raises when they fold to limp-raises;
  - **respect**: best-response play against their raises when they are aggressive less than 60% as often as equilibrium.

  Blending the equilibrium with model-based best responses was tested and was worse than both extremes.
- **River re-solving** (`river_solver.py`): range-vs-range CFR+ over 20 strength buckets. Our range comes from our line, theirs from the model. It plays the solver's strategy unless the model's best response gains more than 0.3·pot·√(30/(n+30)). It's verified on textbook spots (2:1 value-to-bluff with a pot bet; calls vs over-bluffing) and takes <1 s.

| bb/100 (24 matches × 200 deals × 2 seats) | v5 (exploit only) | pure equilibrium preflop | **v6 targeted** |
|---|---|---|---|
| head-to-head vs v5 | – | +22.7 ± 15.6 | **+21.6 ± 15.5** |
| field mean (tight, nit, smarteq, equity, pushfold, random, maniac, station) | 122 | 131 | **136** |

The river solver was added last and has not yet been A/B-tested at scale; switch it off with `self.river_solve = False` if a benchmark shows it hurts:
`.venv/Scripts/python bench.py --opps variants:NoRiver,model_v5:Model --matches 24`.

## v7: bot-vs-bot exploitation

- **Punish over-aggression**: when an opponent raises or shoves at a node more than 1.5× as often as the equilibrium, the bot answers with the best response to their (wide) fitted range, calling and re-shoving wider. This mirrors v6's "respect" rule for tight bots.
- **Bet-size tells**: the strength each opponent shows down after small / medium / large bets is recorded separately. Their range after a bet of that size is centred on what they have actually shown with it (from 3 showdowns on).
- **Faster detection**: measured exploits switch on after 6 observations (was 8–10). A 1.6× pot overbet was added to the value sizes, so calling stations pay more.
- **River solver A/B**: with vs without it, +4.2 ± 8.8 bb/100 (positive, within noise; kept).

v7 vs v6, same opponents (12 matches each): station +241 (v6 +218), maniac +228 (+193), smarteq +76 (+64), tight +52 (+48), pushfold +139 (+138); head-to-head −3.6 ± 15.1 (even). 0 faults; max decision time 1.33 s.

## v8: wider style coverage

7 new sparring styles were added to `sparring.py` (bluff, checkraise, limp, sizetell, riverfold, overfold, donk), making 19 opponent styles in total. The bot beats all 19 (8 matches each, bb/100): bluff +178, checkraise +48, limp +131, sizetell +55, riverfold +295, overfold +52, donk +59, shove +133, random +269, equity +149, nit +36, minraise +133, plus the earlier tight / smarteq / station / maniac / pushfold results (all +52 to +241). 0 faults.

A measured postflop rule was added: against an opponent whose observed fold-to-bet rate is at least 60% (6+ observations), the bot bets whenever it is checked to; against one at 15% or less, it never bluffs. Its effect is neutral to slightly positive (even with v7 head-to-head, +2.6 ± 9.2).

## v9: weak-spot pass

A benchmark across all 19 styles (6 matches each) showed everything positive (mean +150 bb/100). The weakest matchups were nit +34, checkraise +45, overfold +54, tight +55, sizetell +56 and donk +58.

- **Steal trigger:** it now also fires when the opponent folds its small blind at least 50% of the time, which detects tight bots within about 12 hands. The equilibrium never folds there.
- **"Respect" cut-off raised from 0.6 to 0.8:** we give tight raisers' 3-bets credit sooner. Tight improved from +55 to +66.5; nit, smarteq and the v8 head-to-head (+1.7 ± 14.8) were unchanged within noise.

## Tried and reverted: faster learning

MIN_OBS 6 to 4 and PRIOR_N 4 to 3: nit +32 to +43 and check-raiser +45 to +57, but smarteq +88 to +65 and tight +67 to +59. Even head-to-head with v9 (+4.5 +/- 22.4). Net neutral, so v9 is kept.
