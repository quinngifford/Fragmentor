import sys, importlib.abc, importlib.util, contextvars, functools, runpy, time
seen = []
within = contextvars.ContextVar("within", default=None)
def wrap(name, fn):
    @functools.wraps(fn)
    def w(*a, **k):
        seen.append((name, within.get()))
        tok = within.set(name)
        try: return fn(*a, **k)
        finally: within.reset(tok)
    return w
TARGETS = {"shop": ["inner", "outer", "Cart.total"]}
class Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name not in TARGETS: return None
        sys.meta_path.remove(self); spec = importlib.util.find_spec(name); sys.meta_path.insert(0, self)
        orig = spec.loader.exec_module
        def exec_module(module):
            orig(module)
            for t in TARGETS[name]:
                owner, attr = module, t
                if "." in t: c, attr = t.split("."); owner = getattr(module, c)
                setattr(owner, attr, wrap(t, getattr(owner, attr)))
        spec.loader.exec_module = exec_module
        return spec
sys.meta_path.insert(0, Finder())
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
print("seen:", seen)
