import functools
def inner(x): return x + 1
def outer(x): return inner(x) * 2
class Cart:
    def total(self, x): return outer(x)
handlers = {"outer": outer}   # captured before wrapping
