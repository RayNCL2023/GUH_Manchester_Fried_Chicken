"""
Manchester Fried Chicken poker bot: heads-up no-limit hold'em.

Architecture (see BOT_NOTES.md):
  * handeval.py      fast integer hand evaluator (prime-product tables)
  * preflop_table.py 169x169 all-in equity table (precomputed, embedded)
  * this file        EV-maximising decisions over opponent ranges that are
                     narrowed by each observed action, with per-opponent
                     action frequencies learned across hands (by team name).

Everything is plain data; tables are computed in memory on import. No files,
no network, no engine internals.
"""

import math
import random
import time

from card_utils import Card
from game_state import GameStateView
from player_action import PlayerAction

import handeval as H
from preflop_table import EQUITY_HEX

# --- preflop tables (built on import, from the embedded hex string) --------

_HEX = "".join(EQUITY_HEX)
EQ = [[int(_HEX[(i * 169 + j) * 4:(i * 169 + j) * 4 + 4], 16) / 65535.0
       for j in range(169)] for i in range(169)]
del _HEX
_TOTAL = float(sum(H.CLASS_SIZE))
EQ_RANDOM = [sum(EQ[i][j] * H.CLASS_SIZE[j] for j in range(169)) / _TOTAL
             for i in range(169)]
# Strength order used for "top x%" ranges: equity vs a random hand.
ORDER = sorted(range(169), key=lambda i: -EQ_RANDOM[i])
CUM_LO = [0.0] * 169  # each class's slice [lo, hi) of the combo space
CUM_HI = [0.0] * 169
_acc = 0.0
for _i in ORDER:
    CUM_LO[_i] = _acc / _TOTAL
    _acc += H.CLASS_SIZE[_i]
    CUM_HI[_i] = _acc / _TOTAL

# --- opponent model priors: node -> (aggressive, call/check, fold) ---------
PRIORS = {
    "sb_open": (0.55, 0.15, 0.30),   # first action as button/SB
    "bb_limp": (0.35, 0.65, 0.0),    # BB after SB limps: raise / check
    "bb_raise": (0.12, 0.45, 0.43),  # BB facing an open raise
    "pf_3b": (0.20, 0.30, 0.50),     # facing a re-raise preflop
    "pf_allin": (0.0, 0.35, 0.65),   # facing an all-in preflop
    "post_open": (0.45, 0.55, 0.0),  # postflop, nothing to call: bet / check
    "post_bet": (0.12, 0.48, 0.40),  # facing a bet
    "post_raise": (0.15, 0.40, 0.45),  # facing a raise
    "post_allin": (0.0, 0.45, 0.55),  # facing an all-in postflop
}
PRIOR_N = 8.0
STREETS = ("preflop", "flop", "turn", "river")


def _sig(x):
    if x > 30:
        return 1.0
    if x < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-x))


def band_weights(lo, hi, floor=0.02):
    """169 class weights (per combo) for the strength band [lo, hi]."""
    w = [floor] * 169
    for i in range(169):
        a, b = CUM_LO[i], CUM_HI[i]
        ov = min(b, hi) - max(a, lo)
        if ov > 0:
            w[i] += ov / (b - a)
    return w


class Model:
    def __init__(self):
        self.hand = []
        self.player_id = None
        self.ids = []
        self.hist = []          # every action seen this hand
        self.init_stacks = None  # stacks at the start of this hand
        self.opp = {}           # team name -> node -> [agg, call, fold]
        self.rng = random.Random(20261107)
        self.hands_seen = 0
        self.time_budget = 1.5  # seconds of Monte Carlo per decision, max
        self.mc_samples = 2500
        self.last_info = None   # debugging: last decision's EVs
        self.debug = False      # True: re-raise errors (testing only)

    # ------------------------------------------------------------------ API

    def seed(self, hand, player_id):
        self.hand = hand
        self.player_id = player_id
        self.ids = [H.to_id(c) for c in hand]
        self.hist = []
        self.init_stacks = None

    def run(self, actions, game_state):
        start = time.perf_counter()
        try:
            self.hist.extend(actions)
        except Exception:
            pass
        action = None
        try:
            action = self._decide(game_state, start)
        except Exception:
            if self.debug:
                raise
            action = None
        return self._safe(action, game_state)

    def end_game(self, actions, game_state):
        try:
            self.hist.extend(actions)
            self._learn(game_state)
        except Exception:
            if self.debug:
                raise
        self.hands_seen += 1

    # ------------------------------------------------------------ safety

    def _safe(self, action, gs):
        me = self.player_id
        if action is not None:
            try:
                gs.validate_action(action)
                return action
            except Exception:
                pass
        try:
            if gs.call_amount == 0:
                return PlayerAction.call(me)
        except Exception:
            pass
        return PlayerAction.fold(me)

    def _raise(self, gs, total):
        """A legal raise_to near total (int), or None if raising is not
        allowed. Totals close to all-in become all-in."""
        if not gs.can_raise:
            return None
        lo, hi = gs.raise_range
        total = int(round(total))
        if total >= hi - 0.25 * (hi - gs.current_bet) or total >= hi:
            total = hi
        total = max(lo, min(hi, total))
        return PlayerAction.raise_to(self.player_id, total)

    # --------------------------------------------------------- history

    def _replay(self, button, sb_amt, bb_amt, init=None):
        """Events for every player action this hand, with context."""
        bbp = 1 - button
        bets = [0, 0]
        bets[button] = sb_amt
        bets[bbp] = bb_amt
        contrib = list(bets)
        cur = bb_amt
        nraises = 0
        nboard = 0
        street = 0
        allin = [False, False]
        events = []
        for a in self.hist:
            kind = a.kind
            if kind == "reveal_card":
                if a.player_id == -1:
                    nboard += 1
                    if nboard in (1, 4, 5):
                        street = 1 if nboard == 1 else nboard - 2
                        bets = [0, 0]
                        cur = 0
                        nraises = 0
                continue
            if kind not in ("fold", "call", "raise"):
                continue
            p = a.player_id
            if p not in (0, 1):
                continue
            ev = {
                "p": p, "kind": kind, "street": street,
                "to_call": cur - bets[p], "nraises": nraises,
                "pot": contrib[0] + contrib[1], "nboard": nboard,
                "facing_allin": allin[1 - p] and cur - bets[p] > 0,
                "is_button": p == button, "amount": a.amount,
                "bet_before": bets[p],
            }
            if kind == "call":
                add = max(0, cur - bets[p])
                if init is not None:
                    add = min(add, init[p] - contrib[p])
                bets[p] += add
                contrib[p] += add
            elif kind == "raise":
                add = a.amount - bets[p]
                ev["raise_size"] = a.amount - cur
                bets[p] = a.amount
                cur = a.amount
                contrib[p] += add
                nraises += 1
            if init is not None and contrib[p] >= init[p]:
                allin[p] = True
            ev["allin_after"] = allin[p]
            ev["node"] = self._node(ev, button)
            events.append(ev)
        return events, contrib

    @staticmethod
    def _node(ev, button):
        if ev["street"] == 0:
            if ev["facing_allin"]:
                return "pf_allin"
            if ev["nraises"] == 0:
                return "sb_open" if ev["is_button"] else "bb_limp"
            if ev["nraises"] == 1 and not ev["is_button"]:
                return "bb_raise"
            return "pf_3b"
        if ev["facing_allin"]:
            return "post_allin"
        if ev["to_call"] == 0:
            return "post_open"
        if ev["nraises"] <= 1:
            return "post_bet"
        return "post_raise"

    # ------------------------------------------------------ opponent model

    def _stats(self, name):
        st = self.opp.get(name)
        if st is None:
            st = {k: [0, 0, 0] for k in PRIORS}
            self.opp[name] = st
        return st

    def _freq(self, st, node):
        """(agg, call, fold) frequencies at node, prior-smoothed."""
        a0, c0, f0 = PRIORS[node]
        a, c, f = st[node]
        n = a + c + f
        return ((a + a0 * PRIOR_N) / (n + PRIOR_N),
                (c + c0 * PRIOR_N) / (n + PRIOR_N),
                (f + f0 * PRIOR_N) / (n + PRIOR_N))

    def _learn(self, gs):
        if gs.num_players != 2:
            return
        me = self.player_id
        opp = 1 - me
        st = self._stats(gs.teams[opp])
        events, _ = self._replay(gs.button, gs.small_blind, gs.big_blind,
                                 self.init_stacks)
        for ev in events:
            if ev["p"] != opp:
                continue
            node = ev["node"]
            k = ev["kind"]
            idx = 0 if k == "raise" else (1 if k == "call" else 2)
            st[node][idx] += 1

    # ----------------------------------------------------------- deciding

    def _decide(self, gs, start):
        me = self.player_id
        if gs.num_players != 2:
            return self._simple(gs)
        opp = 1 - me
        if self.init_stacks is None:
            _, contrib = self._replay(gs.button, gs.small_blind, gs.big_blind)
            self.init_stacks = [gs.stacks[i] + contrib[i] for i in range(2)]
        events, contrib = self._replay(gs.button, gs.small_blind,
                                       gs.big_blind, self.init_stacks)
        st = self._stats(gs.teams[opp])
        ctx = {
            "gs": gs, "me": me, "opp": opp, "st": st, "events": events,
            "contrib": contrib, "start": start,
            "E": min(gs.stacks[me] + contrib[me],
                     gs.stacks[opp] + contrib[opp]),
        }
        if gs.street == "preflop":
            return self._preflop(ctx)
        return self._postflop(ctx)

    def _choose(self, options, pot, ctx):
        """options: list of (ev, action). Picks the best, mixing between
        near-equal ones so play is not fully deterministic."""
        options = [o for o in options if o[1] is not None]
        best = max(o[0] for o in options)
        temp = 0.015 * pot + 1.0
        weights = [math.exp((ev - best) / temp) for ev, _ in options]
        self.last_info = [(round(ev, 1), a.kind, a.amount) for ev, a in options]
        r = self.rng.random() * sum(weights)
        for w, o in zip(weights, options):
            r -= w
            if r <= 0:
                return o[1]
        return options[-1][1]

    # ------------------------------------------------------------ preflop

    def _pf_band(self, ctx):
        """Opponent's preflop range as a strength band [lo, hi]."""
        lo, hi = 0.0, 1.0
        for ev in ctx["events"]:
            if ev["p"] != ctx["opp"] or ev["street"] != 0:
                continue
            a, c, f = self._freq(ctx["st"], ev["node"])
            width = hi - lo
            if ev["kind"] == "raise":
                hi = lo + max(0.03, a) * width
            elif ev["kind"] == "call":
                if ev["node"] == "bb_limp":
                    lo = lo + a * width  # checked: not the raising hands
                elif ev["node"] == "pf_allin":
                    hi = lo + max(0.05, c) * width
                else:
                    new_lo = lo + a * width
                    hi = min(hi, new_lo + max(0.05, c) * width)
                    lo = new_lo
        return lo, hi

    def _eq_vs_weights(self, w):
        h = H.class_of(self.ids[0], self.ids[1])
        dead = set(self.ids)
        num = 0.0
        den = 0.0
        row = EQ[h]
        for j in range(169):
            wj = w[j]
            if wj <= 0:
                continue
            n = 0
            for a, b in H.CLASS_COMBOS[j]:
                if a not in dead and b not in dead:
                    n += 1
            if n:
                num += wj * n * row[j]
                den += wj * n
        return num / den if den else 0.5

    def _eq_band(self, lo, hi):
        return self._eq_vs_weights(band_weights(lo, hi))

    @staticmethod
    def _realize(eq, ip):
        r = (1.0 if ip else 0.88) + 0.35 * (eq - 0.5)
        return max(0.6, min(1.15, r))

    def _preflop(self, ctx):
        gs, me, opp = ctx["gs"], ctx["me"], ctx["opp"]
        st = ctx["st"]
        contrib = ctx["contrib"]
        E = ctx["E"]
        pot = gs.pot
        to_call = gs.call_amount
        ip = gs.button == me  # button is in position after the flop
        c_me = contrib[me]
        lo, hi = self._pf_band(ctx)
        width = hi - lo
        eq_all = self._eq_band(lo, hi)
        opp_allin = gs.stacks[opp] == 0
        options = [(0.0, PlayerAction.fold(me))]

        # Calling (or checking).
        call = PlayerAction.call(me)
        my_after = gs.stacks[me] - to_call
        if opp_allin or my_after <= 0:
            ev_call = eq_all * min(2 * E, pot + to_call) - to_call
        elif ip and to_call > 0 and gs.bets[opp] == gs.big_blind and \
                not any(e["street"] == 0 and e["kind"] == "raise"
                        for e in ctx["events"]):
            # Limp from the button: BB may raise.
            a, c, f = self._freq(st, "bb_limp")
            eq_chk = self._eq_band(lo + a * width, hi)
            eq_r = self._eq_band(lo, lo + max(0.03, a) * width)
            pot_l = pot + to_call
            raise_extra = 3 * gs.big_blind
            v_face = max(0.0, eq_r * self._realize(eq_r, True) *
                         (pot_l + 2 * raise_extra) - raise_extra)
            ev_call = -to_call + (1 - a) * eq_chk * \
                self._realize(eq_chk, True) * pot_l + a * v_face
        else:
            ev_call = eq_all * self._realize(eq_all, ip) * (pot + to_call) \
                - to_call
        options.append((ev_call, call))

        if gs.can_raise and not opp_allin:
            a_ai, c_ai, f_ai = self._freq(st, "pf_allin")
            # All-in.
            eq_c = self._eq_band(lo, lo + max(0.03, c_ai) * width)
            add = E - c_me
            ev_shove = f_ai * pot + (1 - f_ai) * (eq_c * 2 * E - add)
            options.append((ev_shove, self._raise(gs, gs.max_raise_to)))
            # A normal raise.
            nraises = sum(1 for e in ctx["events"]
                          if e["street"] == 0 and e["kind"] == "raise")
            if nraises == 0 and ip:
                size = 2.5 * gs.big_blind
                rnode = "bb_raise"
            elif nraises == 0:
                size = 4 * gs.big_blind
                rnode = "pf_3b"
            else:
                size = gs.current_bet * 3
                rnode = "pf_3b"
            if size < 0.4 * E:
                act = self._raise(gs, size)
                if act is not None and act.amount < gs.max_raise_to:
                    X = act.amount
                    a, c, f = self._freq(st, rnode)
                    add = X - gs.bets[me]
                    eq_cl = self._eq_band(lo + a * width,
                                          lo + (a + c) * width)
                    eq_rr = self._eq_band(lo, lo + max(0.03, a) * width)
                    pot_called = pot + add + (X - gs.bets[opp])
                    v_called = eq_cl * self._realize(eq_cl, ip) * pot_called \
                        - add
                    # Re-raised: assume all-in; call or fold, whichever pays.
                    v_rr = max(-add, eq_rr * 2 * E - (E - c_me))
                    ev_raise = f * pot + c * v_called + a * v_rr
                    options.append((ev_raise, act))
        return self._choose(options, pot, ctx)

    # ----------------------------------------------------------- postflop

    def _opp_range(self, ctx, board_ids):
        """Opponent's combos and weights now: preflop band, then every
        postflop action applied in order on the board of its street."""
        lo, hi = self._pf_band(ctx)
        cw = band_weights(lo, hi, floor=0.01)
        dead = set(self.ids) | set(board_ids)
        combos = []
        weights = []
        for a, b in H.ALL_COMBOS:
            if a in dead or b in dead:
                continue
            combos.append((a, b))
            weights.append(cw[H.class_of(a, b)])
        st = ctx["st"]
        opp = ctx["opp"]
        cache = {}
        for ev in ctx["events"]:
            if ev["p"] != opp or ev["street"] == 0:
                continue
            nb = ev["nboard"]
            if nb not in cache:
                cache[nb] = self._strengths(combos, weights, board_ids[:nb])
            pct = self._pcts(cache[nb], weights)
            node = ev["node"]
            a, c, f = self._freq(st, node)
            k = ev["kind"]
            for i in range(len(combos)):
                s = pct[i]
                if node == "post_open":
                    if k == "raise":
                        m = 0.2 + 0.8 * _sig((s - (1 - a)) / 0.1)
                    else:
                        m = 1.0 - 0.7 * _sig((s - (1 - a)) / 0.1)
                elif k == "raise":
                    m = 0.12 + 0.88 * _sig((s - (1 - max(0.05, a))) / 0.08)
                elif k == "call":
                    m = 0.08 + 0.92 * _sig((s - f) / 0.1)
                    if a > 0:
                        m *= 1.0 - 0.5 * _sig((s - (1 - a)) / 0.08)
                else:
                    m = 1.0
                weights[i] *= m
        return combos, weights

    @staticmethod
    def _strengths(combos, weights, board):
        """Per combo: made-hand score on board, and a draw value in [0, 1]
        (flush draw, straight draw) that lifts its percentile."""
        ev = H.evaluate_ids
        n = len(combos)
        made = [ev([a, b] + board) for a, b in combos]
        draws = [0.0] * n
        if len(board) < 5:
            bmask = 0
            bsuits = [0, 0, 0, 0]
            for c in board:
                bmask |= H.CARD_RANKBIT[c]
                bsuits[c & 3] += 1
            sh = H.STRAIGHT_HIGH
            for i, (a, b) in enumerate(combos):
                d = 0.0
                sa, sb = a & 3, b & 3
                if (bsuits[sa] + 1 + (sb == sa) == 4) or \
                        (sb != sa and bsuits[sb] == 3):
                    d = 0.55
                mask = bmask | H.CARD_RANKBIT[a] | H.CARD_RANKBIT[b]
                if sh[mask] < 0:
                    outs = 0
                    for r in range(13):
                        if sh[mask | (1 << r)] >= 0:
                            outs += 1
                    if outs >= 2:
                        d = 0.75 if d else 0.5
                    elif outs == 1 and not d:
                        d = 0.3
                draws[i] = d
        return made, draws

    @staticmethod
    def _pcts(strength, weights):
        made, draws = strength
        n = len(made)
        order = sorted(range(n), key=made.__getitem__)
        total = sum(weights) or 1.0
        pct = [0.0] * n
        acc = 0.0
        i = 0
        while i < n:
            j = i
            group = 0.0
            while j < n and made[order[j]] == made[order[i]]:
                group += weights[order[j]]
                j += 1
            mid = (acc + group / 2) / total
            for k in range(i, j):
                idx = order[k]
                pct[idx] = mid if mid > draws[idx] else draws[idx]
            acc += group
            i = j
        return pct

    def _mc(self, combos, weights, pct, board, deadline):
        """Monte Carlo: list of (pct, result) samples against the range."""
        rng = self.rng
        ev = H.evaluate_ids
        hero = self.ids
        need = 5 - len(board)
        dead = set(hero) | set(board)
        deck = [c for c in range(52) if c not in dead]
        n = len(combos)
        cum = []
        acc = 0.0
        for w in weights:
            acc += w
            cum.append(acc)
        picks = rng.choices(range(n), cum_weights=cum, k=self.mc_samples)
        out = []
        base = hero + board
        for t, i in enumerate(picks):
            if t & 255 == 255 and time.perf_counter() > deadline:
                break
            a, b = combos[i]
            if need:
                run = []
                for c in rng.sample(deck, need + 2):
                    if c != a and c != b:
                        run.append(c)
                        if len(run) == need:
                            break
                full = board + run
                sh = ev(hero + full)
                so = ev([a, b] + full)
            else:
                sh = ev(base)
                so = ev([a, b] + board)
            out.append((pct[i], 1.0 if sh > so else (0.5 if sh == so else 0.0)))
        return out

    @staticmethod
    def _eq_cont(samples, f):
        """Equity against the part of the range that continues when the
        bottom f folds (soft edge)."""
        num = 0.0
        den = 0.0
        for p, r in samples:
            w = _sig((p - f) / 0.07)
            num += w * r
            den += w
        if den < 1e-6:
            return sum(r for _, r in samples) / max(1, len(samples))
        return num / den

    def _postflop(self, ctx):
        gs, me, opp, st = ctx["gs"], ctx["me"], ctx["opp"], ctx["st"]
        board = [H.to_id(c) for c in gs.board]
        combos, weights = self._opp_range(ctx, board)
        if sum(weights) <= 0:
            weights = [1.0] * len(combos)
        strength = self._strengths(combos, weights, board)
        pct = self._pcts(strength, weights)
        deadline = ctx["start"] + self.time_budget
        samples = self._mc(combos, weights, pct, board, deadline)
        if not samples:
            return None
        eq = sum(r for _, r in samples) / len(samples)
        pot = gs.pot
        to_call = gs.call_amount
        E = ctx["E"]
        c_me = ctx["contrib"][me]
        river = gs.street == "river"
        ip = gs.button == me
        opp_allin = gs.stacks[opp] == 0
        R = 1.0 if river else self._realize(eq, ip)
        options = [(0.0, PlayerAction.fold(me))]
        call = PlayerAction.call(me)
        if to_call == 0:
            options.append((eq * R * pot, call))
        else:
            if opp_allin or gs.stacks[me] <= to_call:
                ev_call = eq * min(pot + to_call, 2 * E) - to_call
            else:
                ev_call = eq * R * (pot + to_call) - to_call
            options.append((ev_call, call))
        if gs.can_raise and not opp_allin:
            nraises = sum(1 for e in ctx["events"]
                          if e["street"] == STREETS.index(gs.street)
                          and e["kind"] == "raise")
            node = "post_bet" if nraises == 0 else "post_raise"
            a, c, fold_base = self._freq(st, node)
            _, c_ai, f_ai = self._freq(st, "post_allin")
            if to_call == 0:
                sizes = [0.33 * pot, 0.66 * pot, 1.0 * pot]
            else:
                sizes = [gs.current_bet * 2.5 + 0.5 * pot]
            totals = [gs.bets[me] + s for s in sizes] + [gs.max_raise_to]
            seen = set()
            for X in totals:
                act = self._raise(gs, X)
                if act is None or act.amount in seen:
                    continue
                seen.add(act.amount)
                X = act.amount
                add = X - gs.bets[me]
                allin = X >= gs.max_raise_to
                bet_frac = (X - gs.current_bet) / max(1.0, pot)
                if allin:
                    f = f_ai
                else:
                    f = fold_base * (bet_frac / 0.66) ** 0.25
                f = max(0.02, min(0.92, f))
                eq_c = self._eq_cont(samples, f)
                if allin:
                    ev_r = f * pot + (1 - f) * (eq_c * 2 * E - (E - c_me))
                else:
                    pot_called = pot + add + (X - gs.bets[opp])
                    Rc = 1.0 if river else self._realize(eq_c, ip)
                    # When re-raised we mostly give up the extra chips.
                    rr = a * (1 - f) * max(0.0, 0.5 - eq_c) * add
                    ev_r = f * pot + (1 - f) * (eq_c * Rc * pot_called - add) \
                        - rr
                options.append((ev_r, act))
        return self._choose(options, pot, ctx)

    # ---------------------------------------------------- 3+ players

    def _simple(self, gs):
        """Fallback for tables of 3 or more: equity vs random hands."""
        me = self.player_id
        board = [H.to_id(c) for c in gs.board]
        dead = set(self.ids) | set(board)
        deck = [c for c in range(52) if c not in dead]
        opps = max(1, len(gs.players_in_hand) - 1)
        rng = self.rng
        won = 0.0
        n = 300
        for _ in range(n):
            cards = rng.sample(deck, 5 - len(board) + 2 * opps)
            full = board + cards[:5 - len(board)]
            mine = H.evaluate_ids(self.ids + full)
            rest = cards[5 - len(board):]
            best = max(H.evaluate_ids(rest[2 * k:2 * k + 2] + full)
                       for k in range(opps))
            won += 1.0 if mine > best else (0.5 if mine == best else 0.0)
        eq = won / n
        if eq > 0.75 and gs.can_raise:
            return self._raise(gs, gs.current_bet + gs.pot)
        if gs.call_amount == 0 or eq > gs.pot_odds + 0.05:
            return PlayerAction.call(me)
        return PlayerAction.fold(me)
