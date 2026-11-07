"""
Offline benchmark (not part of the submission): duplicate heads-up matches
exactly as the arena plays them (200 deals per rotation, seats swapped,
fresh models per rotation, stacks 500, blinds 10/20), in-process and on
every core.

    .venv/Scripts/python bench.py --hero model:Model --opps all --matches 24
    .venv/Scripts/python bench.py --hero model:Model --opps v0 --matches 48

Opponent names: arena dummies (fold call random shove tight equity),
sparring.py bots, or module:Class.
"""

import argparse
import importlib
import math
import multiprocessing
import random
import time

from arena.dummies import DUMMIES
from card_utils import full_deck
from engine import play_hand
from sparring import SPARRING


def build(spec, seed):
    if spec in DUMMIES:
        return DUMMIES[spec](seed=seed)
    if spec in SPARRING:
        return SPARRING[spec](seed=seed)
    mod, _, cls = spec.partition(":")
    obj = getattr(importlib.import_module(mod), cls or "Model")()
    obj.debug = True
    return obj


class Timed:
    def __init__(self, m):
        self.m = m
        self.max_s = 0.0
        self.total_s = 0.0
        self.calls = 0

    def seed(self, *a):
        return self.m.seed(*a)

    def run(self, *a):
        t = time.perf_counter()
        try:
            return self.m.run(*a)
        finally:
            d = time.perf_counter() - t
            self.max_s = max(self.max_s, d)
            self.total_s += d
            self.calls += 1

    def end_game(self, *a):
        f = getattr(self.m, "end_game", None)
        if f:
            return f(*a)


def play_match(args):
    hero, opp, seed, deals = args
    nets = [0.0] * deals
    faults = 0
    first_fault = None
    stats = [0.0, 0, 0.0]  # max s, calls, total s
    seat_nets = [0.0, 0.0]  # hero as button (seat 0) / as big blind
    for rot in range(2):
        h = Timed(build(hero, seed))
        o = build(opp, seed + 7)
        models = [h, o] if rot == 0 else [o, h]
        names = ["hero", "opp"] if rot == 0 else ["opp", "hero"]
        hs = 0 if rot == 0 else 1
        for d in range(deals):
            deck = full_deck()
            random.Random(f"{seed}:{d}").shuffle(deck)
            res = play_hand(models, deck, [500, 500], 0, 10, 20, names)
            nets[d] += res.net[hs] / 2 / 20
            seat_nets[hs] += res.net[hs] / 20
            if hs in res.faults:
                faults += 1
                first_fault = first_fault or res.faults[hs]
        stats[0] = max(stats[0], h.max_s)
        stats[1] += h.calls
        stats[2] += h.total_s
    return nets, faults, first_fault, stats, seat_nets


def measure(hero, opp, matches, deals, base_seed, pool):
    jobs = [(hero, opp, base_seed + 1000 * k, deals) for k in range(matches)]
    nets = []
    faults = 0
    ff = None
    mx, calls, tot = 0.0, 0, 0.0
    seat = [0.0, 0.0]
    for n, f, first, st, sn in pool.imap_unordered(play_match, jobs):
        nets += n
        faults += f
        ff = ff or first
        mx = max(mx, st[0])
        calls += st[1]
        tot += st[2]
        seat[0] += sn[0]
        seat[1] += sn[1]
    m = sum(nets) / len(nets)
    var = sum((x - m) ** 2 for x in nets) / max(1, len(nets) - 1)
    ci = 1.96 * math.sqrt(var / len(nets))
    return {
        "bb100": 100 * m, "ci": 100 * ci, "faults": faults,
        "first_fault": ff, "max_s": mx, "avg_ms": 1000 * tot / max(1, calls),
        "btn_bb100": 100 * seat[0] / len(nets),
        "bb_bb100": 100 * seat[1] / len(nets),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--hero", default="model:Model")
    p.add_argument("--opps", default="all")
    p.add_argument("--matches", type=int, default=24)
    p.add_argument("--deals", type=int, default=200)
    p.add_argument("--seed", type=int, default=1)
    a = p.parse_args()
    opps = (list(DUMMIES) + list(SPARRING)) if a.opps == "all" \
        else a.opps.split(",")
    print(f"hero={a.hero}  {a.matches} matches x {a.deals} deals x 2 seats")
    print(f"{'opponent':<22}{'bb/100':>9}{'±95%':>8}{'BTN':>8}{'BB':>8}"
          f"{'faults':>7}{'max s':>7}{'avg ms':>8}")
    total = []
    with multiprocessing.Pool() as pool:
        for opp in opps:
            r = measure(a.hero, opp, a.matches, a.deals, a.seed, pool)
            total.append(r["bb100"])
            print(f"{opp:<22}{r['bb100']:>9.1f}{r['ci']:>8.1f}"
                  f"{r['btn_bb100']:>8.1f}{r['bb_bb100']:>8.1f}"
                  f"{r['faults']:>7}{r['max_s']:>7.2f}{r['avg_ms']:>8.1f}",
                  flush=True)
            if r["first_fault"]:
                print("   first fault:", r["first_fault"])
    print(f"{'MEAN':<22}{sum(total) / len(total):>9.1f}")


if __name__ == "__main__":
    main()
