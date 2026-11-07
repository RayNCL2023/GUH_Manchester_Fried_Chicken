"""
Offline sparring partners for bench.py (not part of the submission).

Styles the dummies in arena/dummies.py lack: a maniac, a loose-passive
station that folds air, a nit, a min-raiser, a pot-odds equity bot with
real preflop sense, and a push/fold bot (a common hackathon design at 25bb).
"""

import random

import handeval as H
from player_action import PlayerAction


class _Base:
    def __init__(self, seed=None):
        self.hand = []
        self.player_id = None
        self.rng = random.Random(seed)

    def seed(self, hand, player_id):
        self.hand = hand
        self.player_id = player_id
        self.ids = [H.to_id(c) for c in hand]

    def _co(self, gs):
        if gs.call_amount == 0:
            return PlayerAction.call(self.player_id)
        return PlayerAction.fold(self.player_id)

    def _r(self, gs, total):
        if not gs.can_raise:
            return PlayerAction.call(self.player_id)
        lo, hi = gs.raise_range
        return PlayerAction.raise_to(self.player_id,
                                     int(min(hi, max(lo, total))))

    def _eq(self, gs, n=200):
        board = [H.to_id(c) for c in gs.board]
        dead = set(self.ids) | set(board)
        deck = [c for c in range(52) if c not in dead]
        won = 0.0
        need = 5 - len(board)
        for _ in range(n):
            cards = self.rng.sample(deck, need + 2)
            full = board + cards[:need]
            a = H.evaluate_ids(self.ids + full)
            b = H.evaluate_ids(cards[need:] + full)
            won += 1.0 if a > b else (0.5 if a == b else 0.0)
        return won / n

    def _pre_strength(self):
        import model
        return model.EQ_RANDOM[H.class_of(self.ids[0], self.ids[1])]


class ManiacBot(_Base):
    """Raises pot-sized 60% of the time, otherwise calls; never folds
    preflop, folds air postflop facing big bets 30%."""

    def run(self, actions, gs):
        if self.rng.random() < 0.6:
            return self._r(gs, gs.current_bet + gs.pot)
        if gs.street != "preflop" and gs.call_amount > 0.5 * gs.pot and \
                self.rng.random() < 0.3:
            return self._co(gs)
        return PlayerAction.call(self.player_id)


class StationBot(_Base):
    """Loose-passive: plays almost every hand, calls with any pair or
    draw-ish equity, rarely raises (only the nuts-ish)."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            if self._pre_strength() > 0.62 and self.rng.random() < 0.5:
                return self._r(gs, 3 * gs.current_bet)
            if gs.call_amount <= 0.3 * gs.stacks[self.player_id] or \
                    self._pre_strength() > 0.55:
                return PlayerAction.call(self.player_id)
            return self._co(gs)
        eq = self._eq(gs)
        if eq > 0.85 and self.rng.random() < 0.4:
            return self._r(gs, gs.current_bet + 0.6 * gs.pot)
        if eq > 0.35 or gs.call_amount == 0:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


class NitBot(_Base):
    """Plays the top ~15% of hands hard, folds the rest."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            s = self._pre_strength()
            if s > 0.64:
                return self._r(gs, max(3 * gs.current_bet, 60))
            if s > 0.6 and gs.call_amount <= 3 * gs.big_blind:
                return PlayerAction.call(self.player_id)
            return self._co(gs)
        eq = self._eq(gs)
        if eq > 0.75:
            return self._r(gs, gs.current_bet + 0.75 * gs.pot)
        if eq > gs.pot_odds + 0.1:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


class PushFoldBot(_Base):
    """Shoves the top 45% preflop (calls shoves with the top 30%),
    then checks/calls with equity."""

    def run(self, actions, gs):
        s = self._pre_strength()
        if gs.street == "preflop":
            facing_allin = gs.stacks[1 - self.player_id] == 0
            if facing_allin:
                if s > 0.58:
                    return PlayerAction.call(self.player_id)
                return self._co(gs)
            if s > 0.5:
                return self._r(gs, gs.max_raise_to)
            return self._co(gs)
        return PlayerAction.call(self.player_id)


class SmartEquityBot(_Base):
    """Opens 70%, 3-bets strong, postflop bets for value by equity vs
    random, bluffs 25% with air, calls by pot odds."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            s = self._pre_strength()
            if gs.call_amount >= 0.5 * gs.stacks[self.player_id] + 1:
                return PlayerAction.call(self.player_id) if s > 0.6 \
                    else self._co(gs)
            if s > 0.62:
                return self._r(gs, 3 * gs.current_bet)
            if s > 0.45 or gs.call_amount == 0:
                if gs.current_bet <= gs.big_blind and self.player_id == \
                        gs.button:
                    return self._r(gs, 50)
                if gs.call_amount <= 3 * gs.big_blind:
                    return PlayerAction.call(self.player_id)
            return self._co(gs)
        eq = self._eq(gs)
        if eq > 0.7:
            return self._r(gs, gs.current_bet + 0.7 * gs.pot)
        if gs.call_amount == 0 and eq < 0.3 and self.rng.random() < 0.25:
            return self._r(gs, 0.6 * gs.pot)
        if gs.call_amount == 0 or eq > gs.pot_odds:
            return PlayerAction.call(self.player_id)
        return PlayerAction.fold(self.player_id)


class MinRaiseBot(_Base):
    """Min-raises a lot with anything decent; folds to big pressure."""

    def run(self, actions, gs):
        s = self._pre_strength() if gs.street == "preflop" else self._eq(gs)
        if s > 0.5 and gs.can_raise and self.rng.random() < 0.7:
            return PlayerAction.raise_to(self.player_id, gs.min_raise_to)
        if gs.pot_odds < 0.3 or gs.call_amount == 0:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


class BluffBot(_Base):
    """Hyper-aggressive postflop: bets pot 70% of the time whatever it
    holds, but folds to raises without a strong hand."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            if self._pre_strength() > 0.45 and gs.call_amount <= 40:
                return self._r(gs, 3 * gs.current_bet) if gs.can_raise                     and gs.current_bet <= 20 else PlayerAction.call(self.player_id)
            return self._co(gs)
        eq = self._eq(gs, 120)
        if gs.call_amount == 0 and self.rng.random() < 0.7:
            return self._r(gs, gs.pot)
        if gs.call_amount > 0 and eq < 0.6 and gs.bets[self.player_id] > 0:
            return self._co(gs)
        if eq > gs.pot_odds:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


class CheckRaiseBot(_Base):
    """Checks strong hands to check-raise big; calls medium; folds air."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            s = self._pre_strength()
            if s > 0.6:
                return self._r(gs, 3 * gs.current_bet)
            if s > 0.42 or gs.call_amount == 0:
                return PlayerAction.call(self.player_id) if                     gs.call_amount <= 60 else self._co(gs)
            return self._co(gs)
        eq = self._eq(gs, 150)
        if gs.call_amount > 0 and eq > 0.75:
            return self._r(gs, gs.current_bet * 3 + gs.pot)
        if gs.call_amount == 0:
            return PlayerAction.call(self.player_id)
        if eq > gs.pot_odds + 0.05:
            return PlayerAction.call(self.player_id)
        return PlayerAction.fold(self.player_id)


class LimpBot(_Base):
    """Limps / calls every preflop hand, then plays fit-or-fold."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            if gs.call_amount <= 100:
                return PlayerAction.call(self.player_id)
            return PlayerAction.call(self.player_id) if                 self._pre_strength() > 0.62 else self._co(gs)
        eq = self._eq(gs, 150)
        if eq > 0.7:
            return self._r(gs, gs.current_bet + 0.5 * gs.pot)
        if gs.call_amount == 0 or eq > 0.45:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


class SizeTellBot(_Base):
    """Bets 1/3 pot with weak/medium, pot with strong: a sizing tell."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            s = self._pre_strength()
            if s > 0.55:
                return self._r(gs, 3 * gs.current_bet)
            return PlayerAction.call(self.player_id) if                 gs.call_amount <= 40 else self._co(gs)
        eq = self._eq(gs, 150)
        if gs.call_amount == 0:
            if eq > 0.75:
                return self._r(gs, gs.pot)
            if eq > 0.4 or self.rng.random() < 0.3:
                return self._r(gs, gs.pot / 3)
            return PlayerAction.call(self.player_id)
        if eq > gs.pot_odds + 0.05:
            return PlayerAction.call(self.player_id)
        return PlayerAction.fold(self.player_id)


class RiverFolderBot(_Base):
    """Calls down flop and turn with anything decent, folds most river
    bets without a strong hand."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            return PlayerAction.call(self.player_id) if                 (gs.call_amount <= 60 or self._pre_strength() > 0.6)                 else self._co(gs)
        eq = self._eq(gs, 150)
        if gs.street == "river":
            if gs.call_amount > 0 and eq < 0.75:
                return PlayerAction.fold(self.player_id)
            return PlayerAction.call(self.player_id)
        if eq > 0.25 or gs.call_amount == 0:
            return PlayerAction.call(self.player_id)
        return PlayerAction.fold(self.player_id)


class OverfoldBot(_Base):
    """Plays many hands preflop but folds to any postflop bet unless it
    has a strong hand (the classic weak-tight bot)."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            return PlayerAction.call(self.player_id) if                 (gs.call_amount <= 40 or self._pre_strength() > 0.6)                 else self._co(gs)
        eq = self._eq(gs, 150)
        if gs.call_amount > 0 and eq < 0.7:
            return PlayerAction.fold(self.player_id)
        if eq > 0.8:
            return self._r(gs, gs.current_bet + 0.6 * gs.pot)
        return PlayerAction.call(self.player_id)


class DonkBot(_Base):
    """Leads out half-pot every street with any pair or draw; otherwise
    check-folds. Opens 3x with a wide range."""

    def run(self, actions, gs):
        if gs.street == "preflop":
            s = self._pre_strength()
            if s > 0.5 and gs.current_bet <= 20:
                return self._r(gs, 60)
            return PlayerAction.call(self.player_id) if                 (gs.call_amount <= 40 or s > 0.6) else self._co(gs)
        eq = self._eq(gs, 150)
        if gs.call_amount == 0 and eq > 0.45:
            return self._r(gs, 0.5 * gs.pot)
        if gs.call_amount > 0 and eq > gs.pot_odds + 0.1:
            return PlayerAction.call(self.player_id)
        return self._co(gs)


SPARRING = {
    "maniac": ManiacBot,
    "station": StationBot,
    "nit": NitBot,
    "pushfold": PushFoldBot,
    "smarteq": SmartEquityBot,
    "minraise": MinRaiseBot,
    "bluff": BluffBot,
    "checkraise": CheckRaiseBot,
    "limp": LimpBot,
    "sizetell": SizeTellBot,
    "riverfold": RiverFolderBot,
    "overfold": OverfoldBot,
    "donk": DonkBot,
}
