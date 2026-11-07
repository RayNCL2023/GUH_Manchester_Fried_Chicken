"""
Offline (not submitted): solves the 25bb heads-up preflop game with
vector CFR+ over the 169 hand classes, and writes preflop_nash.py.

Abstraction (chips; blinds 10/20, stacks 500):
  SB first:            fold | limp | open 50 | shove
  BB vs limp:          check | raise 80 | shove
  SB vs limp-raise:    fold | call | shove          (BB vs shove: fold|call)
  BB vs open:          fold | call | 3-bet 150 | shove
  SB vs 3-bet:         fold | call | shove          (BB vs shove: fold|call)
  vs any shove:        fold | call
Terminals: folds; all-in showdowns (exact class-vs-class equity); flops
(the button, in position, realises eq + k * eq * (1 - eq) of the pot, with
k shrinking as the stack-to-pot ratio falls). Card removal is modelled with
a class-pair compatibility matrix.

    .venv/Scripts/python solve_preflop.py [iterations]
"""

import sys
import time

import handeval as H
import model as M

STACK = 500
N = 169
SIZE = H.CLASS_SIZE
EQ = M.EQ


def compat():
    """M[i][j]: share of (i combo, j combo) pairs that share no card."""
    mat = [[0.0] * N for _ in range(N)]
    for i in range(N):
        for j in range(i, N):
            ok = 0
            for a, b in H.CLASS_COMBOS[i]:
                for c, d in H.CLASS_COMBOS[j]:
                    if a != c and a != d and b != c and b != d:
                        ok += 1
            v = ok / (SIZE[i] * SIZE[j])
            mat[i][j] = mat[j][i] = v
    return mat


MC = compat()


def realize_k(pot):
    spr = (2 * STACK - pot) / 2 / pot
    return 0.3 * min(1.0, spr / 6.0) + 0.05


# Tree: ("d", player, name, [(action, child)]) | ("t", kind, data)
# player 0 = SB/button, 1 = BB. Terminal utilities are for the SB.
def T_fold(sb_net):
    return ("t", "fold", sb_net)


def T_allin():
    return ("t", "allin", None)


def T_flop(pot):
    return ("t", "flop", pot)


def build():
    vs_shove_bb = lambda sb_in: ("d", 1, None, [  # BB facing SB shove
        ("fold", T_fold(sb_in_bb_lost(sb_in))), ("call", T_allin())])
    return ("d", 0, "sb_first", [
        ("fold", T_fold(-10)),
        ("limp", ("d", 1, "bb_vs_limp", [
            ("check", T_flop(40)),
            ("raise", ("d", 0, "sb_vs_limpraise", [
                ("fold", T_fold(-20)),
                ("call", T_flop(160)),
                ("shove", ("d", 1, "bb_vs_shove_lr", [
                    ("fold", T_fold(80)), ("call", T_allin())])),
            ])),
            ("shove", ("d", 0, "sb_vs_shove_l", [
                ("fold", T_fold(-20)), ("call", T_allin())])),
        ])),
        ("open", ("d", 1, "bb_vs_open", [
            ("fold", T_fold(20)),
            ("call", T_flop(100)),
            ("raise", ("d", 0, "sb_vs_3bet", [
                ("fold", T_fold(-50)),
                ("call", T_flop(300)),
                ("shove", ("d", 1, "bb_vs_4bet", [
                    ("fold", T_fold(150)), ("call", T_allin())])),
            ])),
            ("shove", ("d", 0, "sb_vs_shove_o", [
                ("fold", T_fold(-50)), ("call", T_allin())])),
        ])),
        ("shove", ("d", 1, "bb_vs_shove", [
            ("fold", T_fold(20)), ("call", T_allin())])),
    ])


def sb_in_bb_lost(x):
    return x


def payoff_matrix(term):
    """K[i][j] = compat * SB utility, SB holding class i, BB class j."""
    kind, data = term[1], term[2]
    K = [[0.0] * N for _ in range(N)]
    for i in range(N):
        row, mrow, krow = EQ[i], MC[i], K[i]
        for j in range(N):
            if kind == "fold":
                u = data
            elif kind == "allin":
                u = row[j] * 2 * STACK - STACK
            else:
                e = row[j]
                share = e + realize_k(data) * e * (1 - e)
                u = share * data - data / 2
            krow[j] = mrow[j] * u
    return K


class Solver:
    def __init__(self, root):
        self.root = root
        self.reg = {}
        self.avg = {}
        self.mats = {}
        self._index(root, "r")

    def _index(self, node, path):
        if node[0] == "t":
            self.mats[path] = payoff_matrix(node)
            node_key = path
            return
        acts = node[3]
        self.reg[path] = [[0.0] * N for _ in acts]
        self.avg[path] = [[0.0] * N for _ in acts]
        for a, child in acts:
            self._index(child, path + "/" + a)

    def strategy(self, path, regs=None):
        R = regs or self.reg[path]
        out = [[0.0] * N for _ in R]
        for i in range(N):
            s = sum(r[i] for r in R)
            for k in range(len(R)):
                out[k][i] = R[k][i] / s if s > 0 else 1.0 / len(R)
        return out

    def avg_strategy(self, path):
        A = self.avg[path]
        out = [[0.0] * N for _ in A]
        for i in range(N):
            s = sum(a[i] for a in A)
            for k in range(len(A)):
                out[k][i] = A[k][i] / s if s > 0 else 1.0 / len(A)
        return out

    def term_value(self, path, player, opp_reach):
        K = self.mats[path]
        if player == 0:
            return [sum(k * r for k, r in zip(K[i], opp_reach))
                    for i in range(N)]
        # BB values: -sum_i reach_sb[i] K[i][j]
        out = [0.0] * N
        for i in range(N):
            ri = opp_reach[i]
            if ri == 0:
                continue
            row = K[i]
            for j in range(N):
                out[j] -= ri * row[j]
        return out

    def cfr(self, node, path, player, opp_reach, my_reach, t, fixed=None):
        if node[0] == "t":
            return self.term_value(path, player, opp_reach)
        acts = node[3]
        actor = node[1]
        if fixed is not None and actor != player:
            sigma = fixed[path]
        else:
            sigma = self.strategy(path)
        if actor == player:
            vals = []
            for k, (a, child) in enumerate(acts):
                nr = [m * s for m, s in zip(my_reach, sigma[k])]
                vals.append(self.cfr(child, path + "/" + a, player,
                                     opp_reach, nr, t, fixed))
            v = [sum(sigma[k][i] * vals[k][i] for k in range(len(acts)))
                 for i in range(N)]
            if fixed is None:
                R = self.reg[path]
                A = self.avg[path]
                for k in range(len(acts)):
                    rk, vk, ak, sk = R[k], vals[k], A[k], sigma[k]
                    for i in range(N):
                        rk[i] = max(0.0, rk[i] + vk[i] - v[i])
                        ak[i] += t * my_reach[i] * sk[i]
            return v
        v = [0.0] * N
        for k, (a, child) in enumerate(acts):
            nr = [o * s for o, s in zip(opp_reach, sigma[k])]
            vk = self.cfr(child, path + "/" + a, player, nr, my_reach, t,
                          fixed)
            for i in range(N):
                v[i] += vk[i]
        return v

    def best_response(self, node, path, player, opp_reach, avg):
        """Best-response values for player against avg strategies."""
        if node[0] == "t":
            return self.term_value(path, player, opp_reach)
        acts = node[3]
        if node[1] == player:
            vals = [self.best_response(c, path + "/" + a, player, opp_reach,
                                       avg) for a, c in acts]
            return [max(v[i] for v in vals) for i in range(N)]
        sigma = avg[path]
        v = [0.0] * N
        for k, (a, child) in enumerate(acts):
            nr = [o * s for o, s in zip(opp_reach, sigma[k])]
            vk = self.best_response(child, path + "/" + a, player, nr, avg)
            for i in range(N):
                v[i] += vk[i]
        return v


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    root = build()
    s = Solver(root)
    base = [float(x) for x in SIZE]
    total = sum(base)
    start = time.time()
    for t in range(1, iters + 1):
        for player in (0, 1):
            s.cfr(root, "r", player, list(base), list(base), t)
        if t % 100 == 0 or t == iters:
            avg = {p: s.avg_strategy(p) for p in s.avg}
            br0 = s.best_response(root, "r", 0, list(base), avg)
            br1 = s.best_response(root, "r", 1, list(base), avg)
            # Game value bounds, chips per hand (normalised by combo pairs).
            norm = total * total * (1326 - 101) / 1326 / 1326 * 1326 / total
            v0 = sum(b * x for b, x in zip(base, br0))
            v1 = sum(b * x for b, x in zip(base, br1))
            pairs = sum(base[i] * sum(base[j] * MC[i][j] for j in range(N))
                        for i in range(N))
            expl = (v0 + v1) / pairs / 2 / 20 * 1000
            print(f"iter {t}: exploitability {expl:.2f} mbb/hand "
                  f"(SB BR {v0 / pairs:.2f}, BB BR {v1 / pairs:.2f} chips) "
                  f"{time.time() - start:.0f}s", flush=True)
    avg = {p: s.avg_strategy(p) for p in s.avg}
    names = {}

    def walk(node, path):
        if node[0] == "t":
            return
        names[path] = node[2]
        for a, c in node[3]:
            walk(c, path + "/" + a)

    walk(root, "r")
    with open("preflop_nash.py", "w") as out:
        out.write('"""Generated by solve_preflop.py: 25bb heads-up preflop '
                  'equilibrium (CFR+).\n\nNASH[path] = (actions, probs) with '
                  'probs a hex string, 2 digits per action\nper hand class '
                  '(/255), classes in handeval order."""\n\nNASH = {\n')
        for path, strat in avg.items():
            acts = [a for a, _ in _node_at(root, path)[3]]
            hexs = "".join("%02x" % round(strat[k][i] * 255)
                           for i in range(N) for k in range(len(acts)))
            out.write(f'    "{path}": ({tuple(acts)!r},\n')
            for k in range(0, len(hexs), 96):
                out.write(f'        "{hexs[k:k + 96]}"\n')
            out.write("    ),\n")
        out.write("}\n")
    print("wrote preflop_nash.py")
    # Summary: share of combos taking each action at each node.
    for path, strat in avg.items():
        acts = [a for a, _ in _node_at(root, path)[3]]
        tot = [sum(strat[k][i] * SIZE[i] for i in range(N)) / total
               for k in range(len(acts))]
        print(f"  {path:<32} " + "  ".join(
            f"{a}={x:.2f}" for a, x in zip(acts, tot)))


def _node_at(root, path):
    node = root
    for a in path.split("/")[1:]:
        node = dict(node[3])[a]
    return node


if __name__ == "__main__":
    main()
