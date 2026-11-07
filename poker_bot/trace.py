"""
Offline (not submitted): prints the biggest losing hands against one
opponent, with the hero's EV table at every decision.

    .venv/Scripts/python trace.py tight 200 5
"""

import random
import sys

import handeval as H
from bench import build
from card_utils import full_deck
from engine import play_hand


class Tracer:
    def __init__(self, m):
        self.m = m
        self.log = []

    def seed(self, hand, pid):
        self.log = []
        return self.m.seed(hand, pid)

    def run(self, actions, gs):
        a = self.m.run(actions, gs)
        self.log.append(f"  {gs.street:<7} pot={gs.pot:<4} call={gs.call_amount:<4}"
                        f" -> {a.kind} {a.amount or ''}   EVs {self.m.last_info}")
        return a

    def end_game(self, *a):
        return self.m.end_game(*a)


def main():
    opp = sys.argv[1]
    deals = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    show = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    hands = []
    for rot in range(2):
        hero = Tracer(build("model:Model", 1))
        o = build(opp, 8)
        models = [hero, o] if rot == 0 else [o, hero]
        hs = rot
        for d in range(deals):
            deck = full_deck()
            random.Random(f"1:{d}").shuffle(deck)
            res = play_hand(models, deck, [500, 500], 0, 10, 20,
                            ["hero", "opp"] if rot == 0 else ["opp", "hero"])
            acts = " ".join(
                (f"[{a.card}]" if a.kind == "reveal_card" and a.player_id < 0
                 else f"{'H' if a.player_id == hs else 'O'}:{a.kind}"
                 f"{a.amount or ''}{str(a.card) if a.card else ''}")
                for a in res.actions)
            hands.append((res.net[hs], rot, d,
                          [str(c) for c in res.hands[hs]],
                          [str(c) for c in res.hands[1 - hs]], acts,
                          list(hero.log)))
    hands.sort()
    for net, rot, d, hh, oh, acts, log in hands[:show]:
        print(f"net {net}  hero {'BTN' if rot == 0 else 'BB'} {hh} vs {oh}")
        print("  ", acts)
        print("\n".join(log))


if __name__ == "__main__":
    main()
