from shop import outer, Cart, handlers
import threading
print(outer(1), Cart().total(1), handlers["outer"](1))
t = threading.Thread(target=lambda: outer(5)); t.start(); t.join()
