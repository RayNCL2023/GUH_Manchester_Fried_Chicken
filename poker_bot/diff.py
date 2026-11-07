"""
Offline (not submitted): plays two hero versions on the same decks against
one opponent and prints the deals where they differ most, with both logs.

    .venv/Scripts/python diff.py random model_v1:Model model:Model 200 6
"""

import random
import sys

from bench import build
from card_utils import full_deck
from engine import play_hand
from trace import Tracer


def play(hero_spec, opp, deals):
    out = {}
    for rot in range(2):
        hero = Tracer(build(hero_spec, 1))
        o = build(opp, 8)
        models = [hero, o] if rot == 0 else [o, hero]
        for d in range(deals):
            deck = full_deck()
            random.Random(f"1:{d}").shuffle(deck)
            res = play_hand(models, deck, [500, 500], 0, 10, 20,
                            ["hero", "opp"] if rot == 0 else ["opp", "hero"])
            acts = " ".join(
                (f"[{a.card}]" if a.kind == "reveal_card" and a.player_id < 0
                 else f"{'H' if a.player_id == rot else 'O'}:{a.kind}"
                 f"{a.amount or ''}")
                for a in res.actions if a.kind != "win" and not (
                    a.kind == "reveal_card" and a.player_id >= 0))
            out[(rot, d)] = (res.net[rot], [str(c) for c in res.hands[rot]],
                             [str(c) for c in res.hands[1 - rot]], acts,
                             list(hero.log))
    return out


def main():
    opp, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
    deals = int(sys.argv[4]) if len(sys.argv) > 4 else 200
    show = int(sys.argv[5]) if len(sys.argv) > 5 else 6
    ra, rb = play(a, opp, deals), play(b, opp, deals)
    ta = sum(v[0] for v in ra.values())
    tb = sum(v[0] for v in rb.values())
    print(f"{a}: {ta / 20 / len(ra) * 100:.1f} bb/100   "
          f"{b}: {tb / 20 / len(rb) * 100:.1f} bb/100")
    keys = sorted(ra, key=lambda k: rb[k][0] - ra[k][0])
    for k in keys[:show]:
        print(f"\n=== rot {k[0]} deal {k[1]}: {a} {ra[k][0]}  {b} {rb[k][0]}"
              f"  hero {ra[k][1]} vs {ra[k][2]}")
        for name, r in ((a, ra), (b, rb)):
            print(f" [{name}] {r[k][3]}")
            for line in r[k][4]:
                print("   " + line[:230])


if __name__ == "__main__":
    main()
