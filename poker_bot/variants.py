"""Offline (not submitted): parameter variants of model.Model for bench.py."""

from model import Model


class PureNash(Model):
    """Equilibrium preflop, no preflop exploitation."""

    def __init__(self):
        super().__init__()
        self.targeted_exploit = False


class NoRiver(Model):
    """Current bot without river re-solving."""

    def __init__(self):
        super().__init__()
        self.river_solve = False
