# -*- coding: utf-8 -*-
"""钥匙 · 电脑端

双击就进聊天。内部做三件事：
  1. 起一个本地 Web 服务（托管内嵌的聊天界面）
  2. 用 pywebview 把界面装进一个内嵌 WebView2 的窗口
     —— 窗口属于本进程，不起浏览器、没有地址栏
  3. 组播广播，让手机 App 自动发现这台电脑

关掉那个窗口，服务和进程一起退出。

窗口技术选型：pywebview 的 edgechromium 后端，直接创建 WebView2 控件。
WebView2 运行时是 Windows 10/11 系统自带的，和 Edge 浏览器本体互不相干——
不启动 msedge.exe、不占浏览器配置文件、任务管理器里看不到浏览器进程。
（早先用的是 msedge --app 应用模式，虽然看着像独立软件，但本质还是开浏览器。）

兜底链：pywebview 不可用 → Chrome/Edge 应用模式 → 系统默认浏览器。


前端代码内嵌在文件末尾的 ASSETS_B64 里（由 embed_assets.py 生成），
所以 --onefile 打出来的 exe 不需要任何外部文件。
"""

import base64
import binascii
import hashlib
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys

# 控制台编码兜底：CI（以及某些 Windows 环境的）stdout 是 cp1252/ascii，
# 直接 print 中文会抛 UnicodeEncodeError 把整个构建弄挂。
# 只放宽 errors，不改编码 —— 本地 GBK 能显示中文，行为不变。
for _stream in (sys.stdout, sys.stderr):
    try:
        _enc = (_stream.encoding or "").lower().replace("-", "")
        if _enc not in ("utf8", "utf8mb4"):
            _stream.reconfigure(errors="replace")
    except Exception:
        pass
import threading
import time
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, quote

APP_NAME = "钥匙"
# 由 embed_assets.py 从 package.json 写入真实版本号，源码里保持占位。
# 这样 exe 里的版本号永远和前端一致，不会再出现「关于页显示旧版本」。
APP_VERSION = "1.5.1"
APP_REPO = "h9837732/ai-tool"


def _dev_version():
    """开发模式（直接跑 .py）时版本号还是占位符，去 package.json 读一个，
    否则本地调试时「关于」页永远显示 0.0.0-dev。"""
    global APP_VERSION
    if not APP_VERSION.endswith("-dev"):
        return
    try:
        import json as _json
        path = os.path.join(base_dir(), "package.json")
        if not os.path.isfile(path):
            path = os.path.join(os.path.dirname(base_dir()), "package.json")
        with io.open(path, "r", encoding="utf-8") as f:
            APP_VERSION = str(_json.load(f).get("version") or APP_VERSION)
    except Exception:
        pass
DISCOVERY_GROUP = "224.0.0.167"
DISCOVERY_PORT = 53317
DEFAULT_PORT = 8787
APP_TAG = "keyapp"

# 本机免令牌开关（自测会把此设为 False 来验证令牌校验真的生效）
LOCAL_FREE = True

# ---------- 限额 ----------
MAX_JSON = 2 * 1024 * 1024        # 同步用的 JSON
MAX_FILE = 64 * 1024 * 1024       # 文件传输

# ---------- 配对码限速 ----------
# 6 位数字只有 100 万种，不限速的话局域网里跑一会儿就试出来了。
PAIR_MAX_FAILS = 5
# 锁定时长。可用环境变量覆盖（自测设短一点，不然两分钟内不能重跑）
try:
    PAIR_WINDOW_MS = int(os.environ.get("KEYAPP_PAIR_LOCK_MS") or 0) or 10 * 60 * 1000
except ValueError:
    PAIR_WINDOW_MS = 10 * 60 * 1000


# 自动更新只接受 https。自测需要一个本地 HTTP 服务，用这个开关放开（仅测试用）。
UPDATE_ALLOW_HTTP = False


class TooLarge(Exception):
    """请求体超过上限。"""

    def __init__(self, size):
        Exception.__init__(self, "too-large: %s" % size)
        self.size = size

# 内嵌的前端资源（zip + base64），由 embed_assets.py 生成
ASSETS_B64 = (
    "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"
    "aEWSiijEjeMMTeX2Nunf+uCCRr/VobpInh1/h0QNKNQ9it0IM6GlUKZLQ+oVkrHgqdNIJSiRDdkYk4QiF0CYGGLIV7BoU6wlx7P5"
    "OMMpVjC354rsm1iNraTByd0yJMeje9dMbyaz1PDeyX2ZcDi3QL13zPw0f204tZk9FMnQraVT+Hkv0q3B1YT5vLtW79P1ISyTIUAh"
    "ZVIo8yltWmSTe/JiH62gYX1DR1tmSBkNamIvoljBv4i/KXrAJEM2s8x0U9/UYIgoJASKZxrQIVB8UOCX+NuIoIq1KG2IUJ+BX8hV"
    "5NlAhHf889xyoO8xXjmC2iYFXBfTsMzdEHaPRKawcVxAMyiuRh2XJ4w6HaxKMhNtaUiSuudsLYawG5S3GiGSkkTG3oRJiltul7oK"
    "bn21Rag9uBozWo2Tst6vPFbFhAWxUzVYxWUrDgm6LcJOFF9dPpY69Ml0xK2nq8rWHusV28mVijEl2G18LSVjhd8ERlu5p1ZpixXd"
    "42PFUonsVWFfmTE+EA3cfToedSrj3NiIU652OjXQM40GmQ5RR0woFRgn8eWf7LAzozDkm23rJs+gb9vtA526FqQ9xQSAPaAHacMi"
    "+hw3GSxX4Szo4iHWYaSJrbSM2IO1N453qBnaxUY8Np1e6x/QwS94G0fqgxIhq3tJfIja3UfrFXFUI8uY/HAIhIEUfUt1OMdGKMkK"
    "AX5FZUDSRIRGNMh0XcxY4YIxxJMEOPYriSmefB9VHE0buyRxSwxGNtBApIKxDxKQOForQFGjjkLsjETdmAYlqzexOcFsretKSWZr"
    "SjnbwWw9Vq7vKb7tpEdn6o6RLZNewLJjklil2PFLtNVv1O7K6EVFWllVQ3zs5rfhQ443NpopKI3SSZW2b4yhkUBudo5F7vIVNacX"
    "/ARoieYPvqCayqVMq2ORQjkDpTOqsGG7SNk0zauuypcyiohD3mZA2DdrpTSeFIYshhgsTeQ309OVcaazLJRC4d2UjGoiD+kWgLab"
    "QoRpl3NgU6DPBbqaGg6ZQe40Gk4Nk6lhmGZ0LNAr8132aG3sRhpb5bBuqfadRyIVO8XySoUAaePevY3HnZx3iwtTQs7/r81QMOjI"
    "9OC9T8r3zGmeVdZnygmNlz+ffGP9667hP6orn+TrtGGd1TxxAuNOvHvL/+CUOvttfvB+a+5oyHrsTcBQJ7eWMWRazMzHIG84r55X"
    "i2Yz7rhg4ch4xfK4WCzuhh7orjyesFYvmAHu8OoRFq4gdbZLfy4W5EluUGbCLPO6o8vNSnYGXdgJHfuGUnJ3B2dO01lrwoyeR6rR"
    "tH4u1WucRE0DRaQ2YqpNJFebiK9G7o7cYzq4+v3vUToEpRRoOFDgdSqvt47duGBhR2KtF1MdVKu8XZmyvZTRh/xUbhqnG+XX6dCH"
    "CZpj/BJZjXwddVEoA8IASYawC1J9hRDs+gG8klrag7I+Cga/G6P/UnGFduPu4yPN/DQe1kdAFWr2NOMY4AGffcaWJQ+OhoEbnKUW"
    "XnKnKQMzEbZUEQF27686aFk20q5nzNnVk9QyIFgJs4hcIvisdehgeEMk0R99fUOV4KVoMJTeLo4a24UCTdMWuoXO+TQ1NipcHvnm"
    "d2BUIs7ItiSqYkRkSgrZqUXzcV0MKxHJLt8lIyXX63Z+AvHQM1w1KDIP1sUj0ZgEwLCZhqiqjE8TaeFgfFA+PYrNq9S9gO6IKaAi"
    "6pCcikTctUUaddfdbldmzJ5Qt0MO2xSGwx31JHTzKHgsQmoNAh4hzgWm3DrBjM5mKJejEUd7sgiKtcVInpJ+7WOBP6r4oFVG2tOv"
    "0y7RBzmVf8Cz5fUZPGSj9/3yR4DvekTbmJSnSclaeUwqNE9CX+nK/Vo9kevB0JG4TDaLmIxLEZlVfRFQCRsKJjOdWUGawHi/MRlR"
    "Av0Tp4oYyDhy+b3i/ok+dIhilLU2aIEI4zc3ihz//94O7+1OezrIj+u6G4vjslgkXMKY5tAxxmz4VerUyPC/jby18d9HhvcMKDzD"
    "jjC8+IgC4thSFIkSgqAhugcT+KhkrVQSHRotjuPKqw3i9Yt2DurBFMIkbiXjfGUwcaDLoYh2RPA8pE+XnyN7lKP//kqyJ86AI5Rk"
    "jKYwQvR4JrKUm7if/v2n0zTqyS8maRHyFaua4blyUCaa2Tyorgxf+jxHkMfWkMcOrucMaD5JsVQ1ouLjFZQ9U+PhiCapV7ypcWuq"
    "6ExvdA8Mru4BJb5vHfxvtUUeh2xuHVyNRqbVr75SBU5lFQZXb+9dZ619/UW7z+qzsEpPF/ya6l0XvIC/fRO9PfqLrr4/vfT26u4Q"
    "lKn1E+vxZTf049UYkwDMzg634KThb5bnFy+PRE9qVhCKAg3QxikGwExpMQvhMYfIzAcAggOCmoDvI8JBoI0ltQxfA9KCcmW47a76"
    "RKM8mtKLsOipNah/tCnNFn5UKM0qb6KJHWrFn+1S7/MdOo+me633+Wjni3nteAgK6IdfOr4l9i0f9R0PH3p26BQda0Y6hW9TWoHk"
    "uBBY2jzAMCY2IaVsFAZSMYYRjz+vyUVi/1+80fXxseblb+gRG5FmRKxNzAGa74k5QAnPH53u6hE3w3uDp/TAc5z+HUg6/Yvum64D"
    "2sdQBJ7/Oq9965QXtfXlo6WLNyw1eWr22faqhV84gLcThqfoKM2DdoBGpvIljPKbjWh2IRKMgPkmZSIqHoi7+QWFkg4SDGqrX+aC"
    "cVbZBs1EHY1jVWmrhp/LxUyKynZ0Q5+qmne6Q3JaqIh2bz75bmiMIGkeTjBQfaIkMY4A2FvcJ4I1G1OJPkJ/rMnYYTF+aHEzGccp"
    "9+5bntvhzcgTJxh1micutJ99wslpFp98GLkUSbi6C+/2kfCTRarqUe4jyrdiGMJxH4fvScKO0l/FTTJOVijrX8y5vc0UXQ/lRKwo"
    "nhEFbIh7xXKZbd7YCdcnwYyrs6CHnTdraiR4rEFhOLGkfvYZF/aS4CTGvUQAg+JwAUvu3c9XM1VnqSW8YzLGh6R8vzLI5y3udep1"
    "1U3O//iP/yCyDW2swYp6wbp6i6WiURrF1IXydYxR5A09/c4ymXf0K7QCpCmE22HjbTk4UglWkv3f0t3/E1/0p/f+z4F9azIDbJvO"
    "pnN/yPxLdyibyaqy6nQQLsTI+YFUXDNEeG6jlocX6gNDhy9ldNF7i9+W9/buY0MD/u7bByLDweRsOQPRi7gKvNAEWLKnxT0YvkRA"
    "1SK4x5a+5SYzdphvNWrIUtRvHC39UTMdjEf2Bppbcc9Fo8LSGXf/l6JMthaut84e7XBoWHGmgVNOpfF8VD8zFFfo68CgyxRw3Ku7"
    "1T8io6NcUVKMioZj1K5/BTmgAu1MarZ4aYlux43atRx2YsKup9RnERoypfQ07B5mVMG/8l1s0AX5kS/eJ3yUN9EwgcILmpVW3Pqn"
    "QXdIpcavKFyM+WqjTVGfzSij2g04nuTonAF/LlaqjXokY0GUJw0k8TFY/aXrPzavzfvzf198+uXPjy+1/vZQpJY4j5Gj/blji/e/"
    "h98UwBx/LN4/x6FJ/aNH/IUH8KZ54SnGG3x2xb99IcSjwiPUb8rwYgcD1UaPj5pTLt1ZpSP3mJAwKkSBPeUkl4kGMCTqjgtESX9j"
    "IqAGfLLoIWC67KxWRAZq7bbUjMHs8VT8NCvmyuq2mrc/9x/PY8BGitX6QtKAVlFfgjmgx9g5MOVU0bfX5K7Avu2syDhF+AYvUtul"
    "ncaVWAXM8MJQsOKvD5q9EBcI49ofKYa6IF+OjcV2ooN0HW7RZPUw+wopFUaqZWCM/PnxHKM4cFP/xDV//l57/rJ/+qPF+zf8G4eX"
    "3nvSfu+JLHlcS1pBCBUMEBMwaUuUhHOrRMXYUpEAbzg3nviaysTXCS5q6qVhNhMqdL5xGYGhER2MpuxUGhIS+a3pL+JHGRfaBUs/"
    "12ZHIS1uD5pWQ7X51JblnagC8QbkUu4bxJBHZ3gTtp98I2nZJXjZ+v4z//FH/gen+OB88f7t5okn7R/uGvk4WREjZkfQVSpOybMo"
    "2rkaGj1F7V8HNPvXAWn/EvB0lS6IB0E+KmkNaChKK/ZI9x6LHj8JOhBvOYlyk3gAuGFjggCGWVYiuwtdqTXCYCCS0MQ+L6Ks0tY5"
    "CT003RFQoH39JgfLhb3eXrjBCRJalw43rx1b+uyC2YLYcRIhxf4bHIyIHTFFUhiel3hBqnMQrVh+ExdFyyiIfnAY/JTboktGFKY7"
    "XEZohlGniZo9HUjvidW0rKPemm68w2WFwuQIUUobPIIOjlf61gFDwDfBdeJ1pA39Y/YLZCtp7AgHuzWm1ABvhOSyYqP4RdF4xVLW"
    "ClA2siUoCMyIi/sulUnIdUUYHRjMn0Mq1tA/iKMjwUWFIzN1nFufoCtnIj8JXkuYSsWdhS0je4e2nBnr3QzIkDERL2Lf+O0k4niS"
    "h9GrqAkRu3DEFVYr423g9BO6DMfzoIgPCc0yrqFwyeQi+LKmLUBiqIooRYrCQdoWxE8MFgN2SGxYc325nrunmhYRE4wjmdLqfDS6"
    "JCGEosJKcYpJTcTRUTbpmI0bSfHU0N0dSlSHqp/gj1mp9gXkRmUBCAL+Z3XdLdQlLfgUkuCu3pAxiJPEwJ9XDC4uqXIlPtwcFdpb"
    "UdcfpXiAvUfvtlD40eAkmr1MM3pbmMJlkEY/wHxa70ej4k0Ux+rSVB4SPTjhr2ZiyFqjmrSRHtUmgm3yXWhYC70MhBBera1Cqlle"
    "ICE8E8uLvFnUzUTzK8ZG898QzqEYv9e1WDPJhCLuFDMgx1bB3W28Gohaxe2yE6Lfz0eUw3tMBK0U90k5tB1OBbqlOegOWqHAn1kN"
    "tzWgXFvcvzCBa9EwkyKNRiUjGbkPKynGvEFOf/LOTDa+mxul2GmjmPeEQ19k14J+hi/VJBJdMwqwRoyjIEMMR0BfHsXjUNJEnbI9"
    "M+rsdqgZlG2MqxlJRNgcluhwiKPQu1VxwmdSQUMEDeOjF0h/2MvlBb2YCfVCYp6XJOR5CVw+LufJ/e+aVz/sYHA0gAT3n7BjcdGb"
    "O/Bo2mNxsqcRmeOLR/7jWVYWeTL946eb82eXjn6AuiO/J2MDJth5fKn97BNOiRkyfwGnZj1n69gOxyk4hXRFc1JZARdW4n1d2CDi"
    "leR3tASE1HXu6+KDq6DPMgW22miUOt28cAdhjBVrZeVD3jx/zZ8/vfTFXJAjLkS01TiQVq3tC5FsHFPyfSWWp0P5lWLSxgo3iKJx"
    "UibzwOJrtnJzdHuMBqrlS35BHRsFBWWuJV5qrQ4l91G1DMgi6JrIvKFiUtXToSCAwRXBgRXHZSWKHhoJxb/iiLNac5WVC5vx84Lf"
    "tuOl44zuyCbChHECq7i0qp1SjmsiNyYo3FaMpKyhrrA3GnsFxFUJhSyjPx2ildEKxkRErNKV++UWmO2PYWwRMxKNsWvoKUa0xxVJ"
    "H+pqn1MrugX4lrwlAlYS9cMUVC24qC1yZnc8cdf58G+XpAj70bWC9G1CmiHraMrwJuyUa2jlCYU6SBlUHsMGD4ZEit8qoxDNgZ5V"
    "aEXCCF4ppHAoWgoiJnnaXUethyJ38Eo9XLB4TDfxdcooY6Q/Er0yCiR7FsmBdxExDPyLCIoykUUMOCtKVqRgo0oTAl0OkvZl9OzV"
    "ddBtKbooF1P6y4pSF+FYzQQw5cLG+vNMOZWPmXNM95IyC6kkkzGTziU6eRNt3xxuNOSXBAUSMzRh+V+b6CZ+jJ3S2XAboZH+8iQ1"
    "z5MKp2NCmwgFMjPaxCauETYrLR0FG5PiCHDw1Ug2VGJKSKwh898T6VQ7JYzpEZQnfycRBTVrFeNs+oq9xcZGZrvdSqW4Cdt7w5nh"
    "6NBVTvVuZN8WZbbzlCw7I8tkqnxVi1UfTL12WrVKtKXFx+QXgYYUcFTuuzGnGtD4OBdVSdmoZBeIywUjOyu9ZgEEZemCIpTVEJUM"
    "AcJtkAiI3DySAPHOltBG65WuKqh1dm1mNXmJwCsqsJpcZbpgIQdXI5HswjyyiS1iti/ZINeXJDfGMXeZdO5CIUX5a8cykvNvuQZ4"
    "g+DXrMHyQqeW0leMTsuALt5ISV90zVADMtJ3TIPTSQnQwQt4cYpAFCrdIeog81P64dHaq3GARcJ11O002HGzCeKVYvuYD2x1R0TF"
    "IrEYitc9B1dHlhNf94qVjFltBNcbQdnfuP2+zu33/SbtBzuU8SShsbWdG+uG1Xg1lcQCy5MgPqSJQ2etsYpxO2HFQkRC7KVwQjNq"
    "RX7q4BVdMT3XRmMDCXBgf8JhZHJGKFSQMIsUqD5R/ucSKiIXP5pikGpDU72goSCpwE4UMFVdIc4H/kfyQ3Sg7C8R8f+OAKd4cAF0"
    "017vNcpI2jvdOeAScpDiMSYTt95ueEqMVJMMIZoHa0U3WIAEG/NbnyhWMIZmYSalFTF7Z3RNd+qN6x4lRDEwR5SKDSE+lOdMzxWg"
    "4VlsKGtp4cQ5jiKZpbBAOJRcDsrj9vT00HGr8IUeVbHurVQFxbKhlJKygUANh24YHu15cZFLuawjkCSjAc6kchGgkoa0SFQgELnz"
    "bnUGzX4mguJbuoenAxsIrjZHdsgKWxpBTFimOS2VR0yDyj8CZhC2mV1ht3GTh8LyUqEOUmUXR1dYFTm91xe143hqzjgf8tMRT/CU"
    "SVRCNEk9goK46B1wyK7Vi/kgEyGhSBiL+I6KOUvsRfKa/IF+1W7dgBIYEQ5oqSoLB3Tb4oRDATtWgOBYMore+FYLNTg94a7wAhWU"
    "NKHBi1TwKYaEREYuyN6M2yCXRZqfwAoxtNXoub7e0EAI+exQTJrpiY52HfN6GhYOU2Rl9BDQZdmYvjiVSCQ6rMTiAmJy8BRrKfQm"
    "V9xTbzK6gkJ81YpEmEu8tTvSLR2EOHPSykTvO0fmwpsMeYn+wWo/u9i8cr3541zz0J3FByfxNOfyN8LP+fRn7WfHmreu+5+eRNfR"
    "a8fYVaw5f7Z146E6JPE/+bR1+SSe+3xyt/ne+/KoJGoONF1mdAKDOLWHclaT94ypLDlT5DzRMxD2GisLzb8cGESj4JQ5oBzyIVNp"
    "upNq7i0HxlIxnGnANLzcLZBOuA0gDaUvr4reZoJe0wczCKwKtIwlBPbZdU7HRO9eDTfQhak+erQSkS6ssdZjMpDw6Ebs8RWjrsXl"
    "l8VfWS4qIeHkeTnOPc76T1AniooIJBIeN5aHY139JmSIe0bKx8i94er67TO1BDF383QqIC7/rUhU4at1UVmlrskqCo9tgce2MGHF"
    "3tyzQ+ibfHkvBGGvjYYtOj7KZMKYGJk7Ahu9NfZrRFgcONUHtVodYVExXQwrF0bc1+vlki42CWP3QDxaCEnWWFeKBpQxubOMEKRH"
    "UkwWbQ3RGL/FBmKHTtBcYwHNJBpnYwt0nXgbJIEIrqHsId+8NN21TPIJeHTJP3Grg0+ABgeQLO/oThf0gjJis38crkEh8ytdBt0K"
    "m4dFo8adWR2M4ftHLZPd14COgVC0TuAT6LyADfwZ03X0rutJmBq+EdphaoaqRQ5Ix0evWXl3CZO0KOcUULo8mVY3JWsIzKFvXFnw"
    "joanfRHgyGeNfmnf2McY/uXOW6ozQXCZIAEj77B06Hs46V8xP7nHqU05te3cWsTFhp5lLAg5BIzfpVE2vPL5r3t27shRziICoZ/p"
    "7Rc7COik+ClHqSCH3pu1o4Vji6lGcJzumITJEqlHsnUq3KAJgRVZVUbB4fcGIBBu1ft+Hjx/KY7NBJCkBVePVob3wq58SlUAt8wr"
    "5boDUeD6E+u9St0nvQ1+mekc3LFOBwhJxmN41okhQMW5RAdo5SwXoLLJ2SYr7jRSqr3renow8E0v/oO5rHrW4j/r4J9e/NWH7/pe"
    "zqKsgf/04T9rjQPlOt8KFq7XE/V6lTyveZv0U3fE3jHj4VAX+Ih651g6KJYRHqEmXDLwBWV0QN1/GSU55C+j3UUQUTyaX7UrxeEp"
    "TExyg69YhiBltkywN9qFwJ9cB38wwl8lKvKVZaMv6kL0Gglc5Ui0Z7ykBtigHLn0HL/co26tLhdc9kTp4OhqXw1yJwr/yKniuI35"
    "Rt0KeqXo1ciXfmyMksLEYFrabHsENh83jZNuftvh1Kfd2mTwuXvMgQ2WvGAZ03lyOfO8vnxm//NuzRM1OoQNS1pEhlHh3mN91UoM"
    "nCAiEt7G7me3IpFzdSyH7+iePw6wKxWOVPTCC9F2Q/cY9CVXFBagCRpEVCUu5Bn6ML5eRF/jGTr21GlPOKdlEOirTpH/e37JyStX"
    "XjMo6XE446ROlrVo/KFiArYWfD9EtEPlzXOyg1qMMewN6E+cs1LOcVmdgXI+B03hnAYpzZEVXxVzhP6GUMgYN4gqfeFhd5nDhjor"
    "G7hecGVD12uEDwnh25o1+kyIMcUNoVfoQwIiGYVWKaNQRoelzZ1gd3kRqzOUEK8Bcu5u568N3N0TjHsrZXkyDOAY8IAJdFcKQgrL"
    "/eiKKqnMitlkfDp0fWdSMgeiM8FzkBJdcw/uXvMv3aE8las4T3pifzfCZ+N6KQ1Q+gEk19NdOoNqxJI61AqcOsMOF508KcQyJfuW"
    "oWOZKBSKbVIOIw1hlPYyMD9Hs5AL/4cRwXXF3ondMwxWfAnVH6oHkRulwamsa8UZrp0UbDHweKCeIHdhqNEeE/qH4ufhWPvFmANG"
    "ILrab8anKZvabtbsVZaxUAWuiXAK2QXSNEOkXV/yaOT92MD8oQj8LNPRvdGYWtE0F0EadfLCzcjKvdqR3IxHlw/ovLzAWQZ0AZc9"
    "jaPpxTEHtxnAJZiWzlFchPEiWB5xRyrYPsEawUS8VaeZ6A/mLKtJg2rE/ZYePEMPgoFzn9UNNaD59pMd4IVQEGMyKs7ApJM5hJMw"
    "oFY54ylXLTXW4IQvcbBiuI3CuEPov2Pk9d07d23d9NbGNzf/cXhkL0/tPrIZmpZNUedVU/aVp4148kQNB0FZhFcKppiiqmrSBKSD"
    "+n3V7m7Lfzzrn73TnL3Snn0Pwz8Mye5b/vxXzTM3/fnzlplTovfnx6dan3wP3xbvn/bn328/u7h4/yv/9vnmwg8abJkMg49FFYCB"
    "8CCChdUjiwdLLDu+hmKEZ/UEKuYd21CUGlWCotEQQ8HczxIbtMiYExR6H6ZIn2CZJasL5zUFE4uZK4p5uv7avd/D8LZ66QNdwCXQ"
    "FSkl0JeZhlFGYUbXFF5+BBAAtq+nb21Xz4aunt5UQmF2Y3QbXlehWHPy9S4hYVNWR89DIGRAC6ZEE3Fhhvvp3+xKNhnjYb/4a24K"
    "PVyQLd3gZjB94N53BF1N8UZJZQOKiiUOkvwDUyfk2v6QVOfaG01CkNjDYCtzF7IvRLdyNrhY0l74W/Pyaf/Edf+jo/7lW83LgOpn"
    "+KjEyk80KpPW0rFT/v0vFu+fsAgFrda5W0vH5hHBz91afHimefmb5uWHrUdX2wvXg5sm3NpbbpXslBjwqFjJlxoF560G9o67EaxC"
    "ImmKJWkyTM8LnWhMwXGqnuNMhuhpASWrzcPDu/YMD7/x1vCWLTt3K9qiU7bCVEZMegD4LUXeC1OGg1xSH9Cnwy6GekCy3c5dwzuG"
    "tnZo3+3Yvruy9t+eKFYboebfxub/x+tbd73ZofW3p3RSmtyPt6cGwqU6EVwtaFeMrigbNIlRfsKudyPHBVKJuKRIQAxJeh6ChDlC"
    "J9xa8W36ioU3OnbNqdHppUaeXggRDCYXPNjscpsxhljEZL2dsCuFkoP+QENbN+GeS+8H8jBq2EL3R28Z7pcnBkptU2K0shTHGUDz"
    "ZPcHPkoms44mUpTqFHloPzvnf/Lp0rmL7Tt3UoYMh9ENLx9ffPiJKts8ccKinW41T70boivN765DaaAuLqhdntW6dFhQGqQx2gHs"
    "/hxDQH11NOdW3uQ+Bb9lCT3SAgEF3Nufk/BpXOJB5KaVt3vpZfQ+ZYESXeA39Eyv2xQShJ812847B7Xo3yzrF7Q9kiT1x5QRYyIn"
    "mXTcd+0mXHxrnVpJgp6J6X5yp0NdReNv8DIJpZWg9FxYzWcJ2ANH2P9iEPs3wN1wa6LmW7TmKYYZi4Fyv2mY+I6mKElSpRiXAJNz"
    "G/VqQ0qbmlyO1pbOhWM1p6T+g5ZTq4v+S3zVH1Y+KIvvtmt9M0BwoDopmXbunECVt8jF2Jhi+m0aScVLrToaoaO1RMzQACWN95HA"
    "ozFgBbOKAy0+Gdsn8jHk8mV7M5W8mQ1L3D1hgSiI4qpvBbrNRtyMTuXozBLEeTPdFbu95kWGJRztZgcpeS2datTHul7S80OPNsZC"
    "WV4LfGFQi58kzGir8Es05ZY9bRfrolPkXZ82TipqOa5mBPPBVtegQ2seZgm7BsUoiCGfogTip2amJhe4UuArRX1KV9BgC+DUGQdG"
    "Uc3I8xRTY0Sbviitjq0qJd3KVTOMXLKnehVoD9PAhUKZEmSgIvgXGAgGX0xD84Q4/THmH5mRouIE/aaQpVAWbUc9cVU4UuuMSI1F"
    "lblP66OxmdhuxoWTmlewsJd7N+/cMbwvxWEyaJo4PrMRwkSdpAaAOElS6GhVNjwQOlRU/dDgdY5S24E5BH2gXZskGcW53nCnBcrm"
    "7UreKaUjncVMbM+etD66Kc8/I17DGxveTHoU/jFDPitPUUIcb8ZIw8luAhiuz6mIq3Kj8l4h5eVkf/B0Cs+tyOzgST/m0c4XB7Ek"
    "OzOymx3WFzeg+QU0GFx6r5tXP7HyC9I0/3zJFFCJtqDYi6utGfqXUoMNru7tWW1xMjD+XYMyvTktScIL0s7/S5M39Fm9L/9p/fYN"
    "Vm9vaUPXBgv+r1MKhnDQrUiALkRP9Mdwahkr/CZnj6r74NIhg001LCn4s4/RfjP72H96vnnuASi8/pmrrXNX2VNj6djp9p2P0Lnw"
    "h/n2l3P+xVvte7f8q1e7W0/ebz26zLkCKcDquUAuBm35yk3/7rcAt/XoorVp5+49ln/j+0g2P7dRKozUZvhQEE/E2JhqSE/qSg9G"
    "6OGfOf7zer1exeTwu0qN8WIF87PKSNIBA3iuo9cV1QtO6I1abERTU9C6fBVj9J24CXO8+PAoumLSRC4+uAr6QfPaPV0nxJuGeBrC"
    "Z4/hk1Nj4RYfnfEXTjU/+p79G5aOnWqeuIYxAW9/3vz4mP/BKTbgtZ8da906ieFDr3za/OGQ/3j+58fHQ9MPzLVm5+sYzQgJTlzk"
    "dQ4H/Y4Ix4ymb5IJ8KelKQaBhBskolt5CG8SljzWZgI7+959Ax1iEHKdpOCD8tYPl9obdhJdNUq4xLd9kljMaEgug05jtGr2ExgU"
    "d4L0qxyGEDYaI35JCPgoQEgrggEmdKitZvRgVP9LJyqAGV15k6dBUfUurADKGmqoy53wvKZ96FeDCMY5iGcsEXURWirHX4iJifId"
    "EjdJ8NeIIXsHjrr17eggKA68IjcQ0KAxXOp0DYZu8GjipS2lUKIUmxQ5jYQXEu/pfDTWfS7wL5ScV/kOhq4p6PzXCLVAAhRwQf6k"
    "J5dQjma2HqtG7D+uYaqflgbIjDJNx79DlWKZJnZLDWheQtqn2K6oiatvdOt1N4hrwRMxYNiih0vxvqW8jrHupbTBKl6jhilyGXOM"
    "xQ/JkLIbmVinzRhnDlZQ/moNakH9xUG1oGLK1hn10uOKsefoatoDOMul2FPHZuqQSW9LdtVTKgx556ShD7lGrZQ1ji/KTn3Cxexg"
    "u3buGTFOFpRpEeuJh2zoUCbiyYBlya3XzCc2XrEx0n8+xz9jEolJb0fHy7mTSdFdpULmEfExI7bGmEewoPQSjXe0ZKfR6CGR1hsa"
    "TfLhPGu2wek8eQErvVHovRKOrvnqI2TFvV+7GEa2QJTVQwi/ZpDNhANyQw/opzgEiTlwFJRWypJgNduZlY68U5FKuEkDADNKo3MZ"
    "1SejJDG9FW5MKzyaN/mgJBhNQ5uUhnDUbehal+b9JZUeoiT6DICgNFStonS0dOiYP3cX5dsjh9oL91l2RclMCmoo2Z570P7hri70"
    "guC0iLHSPmueOR4Sn7TZCcuv1I3ssps7I7GNymtopZ+EHxwI5J5JKGmpjUdtCxfkIOUliME7pyvQSNWp4X1qTJ0nq2StyQwfYO+d"
    "xFid8j08mURZ8J94sl4JLCZRKVwwj4AE6TTF0m60Bo6MtdA0hL4SlYjZ85Vahy1fqbFRLGvJX2EbBOj4hbAJgN+adgBVP6Ra610O"
    "mRZE3h5drGbImmxtDhNrsJyUiduwwWd9mQxyIQtBo5EyknaF+LwV3sUHdUeG0JYnv5pw1/SdFumPIJyhgFrW8hc+lJ1DzXetZooz"
    "y+tx77zQkXzFdTbe1zaIyRchz7pPcFLlUEiRmGkyvct/0TSNFYHTlgKxQPhZxAuUAy/8StmLtBoTscIqV8WtrzBem0VlzUtIFbeL"
    "e9uF31KhopG7bCLcYYVo0A5XD6wUcxMJYUS8hlfEs2LEfD3nk5To+faWIubkc3BXeA0IV4I5f/4r9iAIWQlaj9BEIBwPmh/dhVeS"
    "DWlMR1uAhnmYIWgbBUoLcxtW6jJacCuhGmCIt41FoB12ocAHIVWMV220oCe2wkhKVA4vT3kx1CNyYUuqZMGdrfjcDfpdKDGL8TfM"
    "49dLC5rBublMUhU+9uRcpbFaYCR4hCAiWkBorh1zfdHwbuQL5YmaJl0YNzYW1QDSRncwMSTpnuJoKbg6Wax4wNU3OoDxDuDAgWy0"
    "oHEMFHMR70AkbbuQNDATY7iTWkgLbSZY+lguuoUWMDRBsx2UBE3e69To8wEZf0QJIGHTdaWQ7pifILzewophJpyKxp2uSyfS5DSQ"
    "Rrit5/CKfofCFe5x6nXooJdOYZgqmFd6K2ptcWvlNBLbSAp1xym84cxsKdY4bUNMcnDTNTmpsSS4TqnQEa7wXX4OsMqbOQ6mHk9a"
    "JmLTnWATQgqzWSEhYzOfJGmWG3RpBspDlkvhj0Zezpo3mkw5qedK0y2a2JhaeAEvlBATi2gRylUIDnI0FlXkrdHgOqqMkiEKZK2k"
    "+B3yuMMIz62JtHGJ0oKQFmx6kCHEFfjIVHFcjM4ZxDjul0jvHo51ZuYI9LTo/Z7K864T37pYmBd0N2zN31xbI/K0jvgchRZNOf5R"
    "h/q1zsq5fE0fQD8x77DjUnKMZD1XXswyG7JCEJ9AWHj4QVsWEQZF4kCUQYbvLYu6idnyzKx4VpAYRNkhV2oqjYtNJWO+dCK4ZEn/"
    "Bak65P2WOOyPpAVK2iP7YiPmaF4e5oq51XTEe2PV8pm74jLCrOQe6P9Bews2SYCwFn/+f2yfrZiALbchf+GW+402knntffH+jebt"
    "m63rC+2FG9p7niAMxP/0SvuHj2W2DRXl/tJwYdwh58GuLuiphaFeHs8v3j/pL7znz9/B9H/3T/uPH7S+Ov/z41MMDfSN5ty91rsP"
    "mqeOL32wsPj4kv/efPO76/78af/huZ9m322ee9CcO8tf28e+8u99izkAjtz8afaU//QI9/Gn2dOtEz82Zw8psGut1pcfYOKAo6cB"
    "Nh5ifnO9efx08/iX7eunfn78SfvHI5hPc+5j+OrPfe3fOIywT9zyb5z2z1yFZqN3/rVTjU08YuLZiJWEPhRDqNZv9WQtt1Ycl8eO"
    "kRzWuwwYBrkyweeckuZIapjUIwXDYdvN79ifQD0SqncUhhR/xYJGLJfSXaN94l2cNlpR/9537c++FpnZ1QX2g9H8SaHm6loGpUhP"
    "DLU1rqK8TqkOmjWE/RmzRKBrITs2ta/fat14CJ1dfHSTlz+a3RsBb5zZSGEU06P1Sla+HCHJq9aoGEoblCDy1qikYwXHUS02dV6i"
    "ilIkNIofhw7qhKtRSXcI4t6hbtx0QpdiPyJm8GcdgwLflcgwDPPOaCRotjZvHVdPS80VM5KstbZHD3OQTJ2A2PgLny5dPMJLi7nb"
    "k4N1FNzNhPqS/ZnJh6oG1iUHyRcWc2+5bDyyXCghzzvUUKRIYhKrVfGZzkTNCKgVpsTUs2EGXXYKRVSZxPxsDTqdL7meo6t/ktXY"
    "Spjw0hFwLGxoYN4xzFTB5/iZRSZtTlMPzWS/5n4Q5BQaMiQbs4WYINyiYDT1lZ6VMCaVXkiHZFpaiE1SKNGNRCQN2YRQyuHiBo3H"
    "32L1qLnw2tHL8MpJ2c2QHPHdP3dWdofyhb0QmwRWZf36tdlf9claWZa1FaXAis++pWRylaFSz5ZB+BuyfgV2heVSsz3HJLO+XSqB"
    "tOqlTbzTKIf0WopsR7m/4rZ30o5T1vckWvHr9l2c/WmFs4JXYT6+TWmmzrTO/dA+/D7arJ992jxzE49ODdEBMzeBSBoRbcPuaLY3"
    "ubnoweeKkzezy4ya2S5C1srfcewpYXu29lLI6VKxMjm42h0bW70vFWgLUaEEBolFcwXVsuCXkTCukjrOVPJa6bSWMqYyuSWEBbDc"
    "mGwacYGNUY0Kmkj72bqZJXdlkm7pcgT9GnMblUI/QAhukQnUpVHuKRacmKzHoTE4gbfsQWPR/LlrIFTyii3eP4Hn4B8fW3z0Y2TR"
    "4haH0ACHSMn9shbLbMlzm/qv86+l4mdRuJBP7lbq+4Tr1Y0DPHZpSXXb1WI3fuxGPO2muEIVdLt/c/fWTXhDvYJnS5Q1kAKvSG+X"
    "zcPbhkeGMYus5m6Qq084FdOlSW4VaEHMreGzYjpOHTSQwJyPDAOvOWM1x5sgTIhdAt43zatn/fm7zeMnm5cfwuSLPfT1nejMTxbz"
    "MPVTqPZixKvlpx3QAecrhxWXQebIHE9y5HLtHn6C91BwLXEF1xGj95BDTkXvWDi0fvo3WLGDmfB61RwvcsYrHYrCDjyp10dGdtE1"
    "x8BLKLKw9A37qJ1nRVrdbwSbkltOzbEIVFTBi0PMbAt0fT8I76xR5ADNguZIFUxwtIs2twXmCNdzXZB8VPNkSxLw/W9n0e/lyftM"
    "pCMWiPazi4CP7YWn/o1jeMnx/o3Wl6fbX37QPv4d3oH+6NTSlc/8Z0eWrj/y544C/oJGKPuo4e4c9hJQGH1q6OjTv/tt88IdPu6k"
    "EqeaF56C7rh05LR/50Hr2qGfZg+BuisegRrRhpCQ+YkhM5Fn2DAGf+7rxYcPlR+PDrt5/Ovm/LzVbTFU+OGfPQWkTZxT+nM3YAs2"
    "P35ATj2XMKn6HRjUXYt2AVIWi3tt8WDmlt79HK9zYgCEz/35r9iPiIfXXni2dH4BOvXT7LsvaF0m5yPMXrjJrtr5IrAp6B00g7aa"
    "ubsqaoL/5IPF+w8tHhoaSAKrSEAcWYGSQRqYTlr/aaW4VkqUx9dbK2OupnDJ10w8ArYkwWvMSsWAYG7A6SCZJ8DM+ke+Bf4NoxSV"
    "fx1Pizr0FoCM5us4WsNyI6dAuZbLF4FUKUQKNcsoW6qHnLw4sKtk10H3LHf+mtZCmGmzL+fZNBuE+nIwNmhj1EEzpXCMSEbezk+g"
    "hZY8H0AETIVC7kV9JWUsyMBP0iRe4mKhcAbXIp9Gx0WIpDvmaSi03wgN8gdBHXA/X7wV3dKA1e07N/2jp3+aPcXkhY2KP82eVvtC"
    "/uefOerPfweiR/OHk+07H7U+urh4/ySaN0tu3i5hFywB4otDzftHmmdgv5/yz37hz11Ei+PxDzFKCfUArWRUUmwc050UfbeJSwuJ"
    "qGjOkkhSivPU/T8xBmL/X7r/0p1WnfjP3r4X/5Lrof/1Zvb2d+/r5sh3efRuy4SdLROFQtPlNAF7zOAl8ebBs0+QRDEuBjbBRDyN"
    "aScuM9Y2+L7Lrpj7bpVTymFFyiwZvbm8KtiX7xhbV8o/OmDDliePshAAMsIgAK8ax6pBEzNFaZZ9k8obI9c7H07bEhU4+dIZSc94"
    "WvI6C6H9xktuXEsJGsCXpryqY08mNiDyglr9pkd/oggcLymQZhuvCcSwe40nX1K8FkShKK+N2vYit3vN7mh6WdFkOCungCRrYu3n"
    "IoOiuXjaZ2wZWTncP80EiN+MPGnYp03osRJKWchzkxowS75Zi8nzRzJao1JzYEB4kpfKhGptd8StbQ1+KtkgrVFk7G5wGJzQVyxE"
    "VJ9jVuodT+w21WnI6HlG4ZjeykFi7ksp9aYJREFIGXRzS0Y3pIVUQwkEkWgNw2wRlJWrq8srVJntLZGqWww7SGxGZx14iOppnYyh"
    "e9rXSPR5s3IoM6nKyYZJZI3cVzSXFVdU05O6JSNFh6b09+bZsWZdk5Gm9eRmOJuY03R1h7ynVAYV3WAEBbGGhDv8M7WyJKoEzCu+"
    "rU+HShdSoFQkQRbVWGhm6jHM8tmFZiIOkRWbhQyVpyALWiHHkajDuc+UnvUcycgyIrFHKjEcfKDIXBLqyRqpniyXN16n9iF8ZcYX"
    "w6fp6mZFikBFb5M0C+nuCQkikkpPHwAPEQG3orFNzeKk8U0tCnEMuBDbJHgduKRbMTYaQ+IQ/hHqZPYJz8wMcwYjab+VF5hLvscc"
    "4FeLVAKYiEUAteo4QUN1HK9CT/2DPuaKM4XhV18I31JRXf7zhFMLd5nkyUhJYctMSBZpon6JXDXrlVicZzMoMnQDyam/+HaHOx3B"
    "c9XSml/SFppcI00FonFCCk7OvAB65Z9rdjUuMQPSrcCwFjB9w81+RchRceubDPxY2UKlUv/0VYLhx6xS3q78xktUtisNuxRtit8/"
    "3woZ94SghDyIWDELFFvHKWwKIUg1yPUYnCJJy0NOWB3M7MHia8NLWHosUKEj8QZ5Q70jjBUBWHxWlovgNUeKPpiJhKMLipCNI04u"
    "WFGvtmBtKVDFA+3cvBnfZqXNDuuXdKKbaUUw9DRC+lHbHvjWWRQLSmgZq8U7A3/CE2LKNlXMCf3PEG+qObtUtL1fLNFUc8Uq1u2n"
    "WHu5qlurP688E7uLcTqqSpgpRkQYWpqG54xMFL1fJ8WEVcFGBdfMdAeNbsmInzznrmC9jSSOkl3ZBfS8eCAg5QlGRYrjuaJzsuXI"
    "U5zuHLpBX3PHgcV46f9d3pc3R3kd/f6fTzEk780zk0hC4CWOiONidahYhkIQ3/c6XNcwegaNmZln3lmEZYcqYZt9EbbZDMIYYmxi"
    "m82xDQhkqu79JrFmJP2Vr3BPd5+lz/KMRoBdb9VNXGies699+vTp7h+jAqDcx8Ew7R2Hr5LV2HvsG1Du+PGvH42NR+/crvr6kxEy"
    "i3zZREvamZQsewZ/n3LcufmvvwaZ241rgmttHzgsGFeS681PX+4cmWxPXwfTpdkPOje/+/fDw51jj9o/nGsfvt2+fQf8BYvEj1Bk"
    "B7HH24++YrZMaCwphwAwPizv+S/xhYLkQKw48NFG62UIcvRlaqhP+sLvXvgdKpaRWmlhYijz++dJazBpNYdFYnSgl8AzN07tkJ5k"
    "88w0hHdI3umZ49Rpav7ie7Pgy/HYRRLdtw+eEJ1r37u38MX+9s3v509fpzFQ20qMxcLdW/On74Cs9OHk3MzB9mcXKMmPk/s7h8/S"
    "ZQBeB559OTP/3g1Q1Dy3n/J0zn0/9/DC/NXbc/eOsgFDhj98wuBY5svlXfnCHsXQr98yPLzl1Te2btu4afP/3DjiK3XUmFIHB1mp"
    "IbbKGmfRqOK9ujN6FpeYMlVC7/P2zHPp8xb0rurRIXv3+3sP/6aTBg8/C5Ql8qU6akpgz8plhAfRR1dNxgapj4wH+YvS4TeFOLIX"
    "SIjSHVfbX4IS6qp52mJSaDUsYSGrkkWG6PpoAj2zRHsgEXrRa7VlNkXK/ahd7TXat69q4ViFGuVoMQAvKKLTDIjko0aw74GSIN4p"
    "Sg2zOF6h23A5QbV7FwhOxYdJMFTOLAVtj4K4ESBFFm3hC6gtLpUG1LUzm8ut6dIUe+10bwvNnwX5s6JuvRxJSAkwXeSYXbvyo/34"
    "GsUu9CKMBo2hmViZFLoOy6OCQnlgbccMnc3VWsFtA2/aGjcHGrovhxhWg13Udf1imNpLcD+a6U1TqQEOR0xTtisLhAm4KMaXsqCn"
    "gMBiVFccd2nbaaFKXFt9mVXP6TEILDF5hbc2mj3xVDCUulEbnNeVR2UxNbxKexb8+cNJeb77pNiahaTYBv4USTfQ0kVzdfHSdNb8"
    "WfJHi3QwlI1xqyz2EPRAHBitcnOAAlApo49j/7AkxCxBCskM98ERFIKFs8eS+ShQHgpwk9RjcLwdBZ+Uufm4+w63xgO0oncoWZx9"
    "zSIATFlaSOzIdLv0Oz55p1ZP/Ee6yB+LFTHqb8fZKj8Yxg3OSDXHYCqg9+PguhSwGTK/wT/65V7ErKQI+pMT471JsAaj2VWEpTy8"
    "LgoU4+f3Mv55nf3iOY6h66K0O6d5IHBkqUpwkfLguYkpUVv37McUeCRYYM8S/2Atpl32hbj4k9yGi2ir9diXYbWYigMQnnsqF+HR"
    "spHns+b5w707bna/CC//NaFeSan7/557SpdtS94Z0Iux9SYDeowB7il8UnlvZ07WwMlTFgktUSx/oYMjSHAHdflKN7T0I53T91YN"
    "zoztyVYxtqWyBY67ggL4LrGPA8oLxyeK0/Igy4c8CjoQ4T4Hc0u9wr9jHHnwx3SpuHXwY3kVFjfgizfbs2ekmvODKXC8iY5RjU5K"
    "L67bHD3XaNk+3N4B5BnICt2MhkJKsmYU4EwnPDbbHRcpZ0LM0g7clqlvubTmUmgalW4lzuKbagp7UasMqAOEq7C5Hss5Jud7bHXL"
    "IK1+mgxhYMvJ5oK+sZ7JPpysAPvXQ1dTGDzqaFf+NDA3dXzUcybIf7IJ3z73VrF19aQiNjyR0nd6253oF2Kwi8+hvHneyQ8OjIkW"
    "wfG8DKVylls1FFg4sL5WbpdU1egZxYJ7H+TZC+VSYY9ZoXY2aaXjZvOZgcDC0AOoVdGXXA86y2OvCCMk2LHtFTnq5JROfIsrxq5y"
    "sos7U+1ljvJqgvSbaD486F2GXBdlDXeXwc5pz6zKetK2D4Du1ePxZA/rHggzwC8jv56FB9jaJHx3BJW2wE/U3L2TC99+3j5xJmwu"
    "vWHtf77x6trhjSNv/K8/gfJu1P7geufcNVEL/BLMvfo1c1yHHZG/2hcv6tjTKuzAjYjEnwCbfeX7zqdgXd45ex/Vnic7l66A9Hfq"
    "y/b09R8nj2+I49pIHO8RG2b+HzOL574Bi++b34nPzjdXwGgZTc/bB/7ZOXnkx8kTIrZ9aGb+5G3HpkHaLcX1UjK6Ll/3mPGaivHV"
    "GmrdPC7sKqEHPsHugWcrBAwFzwYatnkzWjoWWo1mUrHFJTXyCA3+sJJicWuc36OETKopjhghwF1x3EWdbUux2HtJ1g5H51wK34vG"
    "Kmv8MbA9XkdFimXWEk7qSCwxAWo9+JInilSjhYoETsbhxHtFh/t2JV+qDpeqraZgglbQbViL/k25lE6wgKJwolBDcCGVGbNOQTku"
    "zo9Sb39yFNOWW1CPptYL1Lv0n2Hh2OakE4ynsTydhWmun6zprsLCvyZP60ul9E/gZOB6OGvcMkG84c86IeJUky3UlgBENw2FROoe"
    "As0aWxeGSn816NPPKd326hdgtpa1VXAGatKnN8SyJIKAvZD5TeaZ5wcHUXZhCd1G8xPSRyEnvq/vqsG9csf29RvyE9nczjXevvLn"
    "hHYqrXPqK3wrzSmJiCRH1t1NQdUpXaB0qDak9Kjc1nSfzb2bG+zGIfo7pDqt5WUl4vLGxiqVPm5yPrS8TmkrpV9wp5HcZtKiaL8w"
    "HiClgxerElogDmZPkMLwW0CotFa1WSqLZdcbqXGfoGzNiVD5CV/RT63BvRPHIJZMqNyxpFwSc78+Py54NEucnrZvqRQSZ2SigMSU"
    "tazCSS948JB9VXKqfgbmNKZQYIvlRNwvK5mVmef5tqyA64xK5n+IULNyxgA4ftCAxldQHii9tVIPK6VqlLOEhmN+orGkVSftUwzv"
    "Wk7opOGeMp3TpqWjlnHYKLcVjPSbcnqWPar9/ud4YmQsqTd7kz8iq6+oLDC10l2oMbxHOpzsxW0si3kns4ftf+keugFPGuNDCs29"
    "pcNRkMyEEXZuwmeTecVqerVVEXkpNDWTQahzM5qY1Mz4HODmw8CcHJSdemOkzAOMhyOYrXcXzAI9/eUfLUEqBPXvMXNYH9jDJad+"
    "2nGedtxKu5T8ke9X6PByxf74P1dkT4Faar8aWzQcBTL7OV1h/x5b1C8X0XjqHhwWy38Cnlb8PVjRUT/xDUObyjTjinvKIVNXjwFz"
    "DRhPTCJh6qEBQ/CKRJGCxiNUlrWjZFTOcluCZRaSagMNtAJFyrhAiSrGLnAFlRF4+TBjuGz6s15V1ePzR0pV1DR7j5WagU22DBVZ"
    "MUpSr64J7jv0e4LxCi66IuJw9Kj5j4cA9mzmubHnxp8bXvX7zHPl/hcyLwyvWpV57k/P51dnVmeglMF+8Wt81SoTIP6uHrMD+leP"
    "9xtcMldpt+s2ZweVZQP4FC89oLmQLwNI3WtjietPTWTPmpsCHK//5y6esOJkIT+EZAJiMZL87NJ1NFvNRIx1OVBJ8EJiOU+RV0KG"
    "+kXqFkYEwdY8j3CqSrv9W7faxliyVwQr5liGijUSY6ivRet73PZp2xqLtMkBF4tRXxZAYSgetTtiUi1v88qMpPXrb19TdIBTjKKl"
    "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"
    "tTP93JaBy9zLkDevQGnZNmmISkL1E1/g147honZ1j8gxrK9vzrcv/gDgZVdAE2D+q1uZ9c16+bd/+ffDI3P3TnaOne2c/kHpznSp"
    "oib42LgbPVben7Ix0InariRfH90gyCcp/VtBA5g2Z+uFIciXdK5vQkOSXe6tyZHkSq8BkAAUMMHCmWiNpJrcFh4rVB6WILVYkmsb"
    "m5jdJoMHy1HbSMxYzAVM5DmYmK3xlEFdBxjODXExD0YS4ui0yZLc/uolQM3f60C4dyeAudsHRDypRTsFW1jfmLctMsZt8GDw7t2I"
    "62Al7E1kPJ4yh5lQM61hjcdR+5Pagb6EyX52O9yCi3E9EDRgD4W91eQUwISvrdfzE+SDA1526XlwoJAXB0ioQOfBqFTZDYUUGz4K"
    "XJEJlFf+bzx3/7py5QAYxWSLqEKQW2P5/5d+Mpo9lLeipwJxQYoG6kGwZx6iXMcToiye2hwZENPtPpC2eQWPvdRREA+IRLRXNsLR"
    "EZHmwkBjrFRsgsMU+gThLqwuEBRCiCfs7XVBcRKXcdc93AuRVAb6QpJo1J8ewTQjGIAGzOK+XBqPCVHTKi0GxR0y2XwMVjPt0Fqh"
    "rdJCZ1HT4h5xZIH76qcLj2hu+B5kvzd3L4oeg0xh+lbSvRDQ/rPmyRVa2UnNpLlyqq7XVW9KC/IJ9kmn4HF4fZqu7tM0GsvnJ9S6"
    "AEbUjltqWCujSOz9Z1krSVopRtqjuRNwZDiOFkKRta+CEgelvIOLHJ9+teYmPnSVRpF6m7aURu3zcAmRBa4wZ1TgLdkidvvCk09e"
    "DeJGA1RX6koxfqlF0QMTy+x2elodA2xEQyuEjAbtRWI1PFX9po6gNDg+CXcJQEPUl3l+tZYXhkkVnfeyz60aHPjyowDeKsosANZn"
    "b4xA2tjaXACJOOJ8XXXNdJkan9befYzRJK1twlxj/GTNaEL+N9/3ZAivXHcsb+uDDp7aI1zp2EnRA3VHE2uXofVTMJMlcjmyebR7"
    "/bpovw2oVLbWclwSypem2OIoBoZpv7g5rR0dlcX3LIMKafI7QqetxfW4PZaSO7NinPwgC11CDhrMXCsqZdCexQCpeqTa1s5pm1GC"
    "Xd6VE7YOKL3Se26ayiwXN7B4nfMl8FnWaOxN6qNksexk6qqnawqxtXCZWi7p6Yak2ko5t0uvIR7FvIhoyOgQKrh0HnzQuXSF0SGS"
    "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"
    "8zPBubvB5TNoJ3hb537GnZ3/pTW/Aj3oRx/0bTk4cFmNnCaFU12JVti9uoDitzq28WYiTVmuWo2PaPMe/dQ9ey6vQyT7Z9JS81Ot"
    "hZcbqz+175zUEf2eJnfuDrAlLVhMNARyRwMCmzaWJ4O5B7ByHpxnCKdJzQI5c/IssK41cQGUdjAOLWZaZ09Bz635RQ2LsHOaZrC8"
    "AG1gsvAfPD9qyq35SR4FeNK9dw2ciaSFa4B9cUuNmlE2q06tYrrEGpJoMGatk4s4JbDoaw9ZRuGf/VVryBe/E/x1a+Ze5+50QjVz"
    "n7R7dKDmf+6Oz8CJDBbPgJhpSfc7FTaiSAza/PHd4McpDSVqo/2Ge0SnSkOiwZpTPmJWPrVsEluUx4VXofQBR4Pxk52F5dbLuc6j"
    "ieD6YxDSzvqPzN2QvUOglf0SOU+RpQjergQrD2ObwFSOVI4pGy1/rTkjbIlmMz/VrQqvJNuqag2TOuo+uZZtZtCxb10Ff+J8wnRL"
    "gqbtNRsN+MR2lDkAC+8s3I8vJJg71bq8BFsKLN9YObPx5rZ00uC8nl0JZleTEsd924ZvHTUPOGzsuetg/rHY3WigMwnqvvNyKZi9"
    "DQqLVQL0DzMFT7b18iTobxSusytJbjeMGoiyRwvuXLwFvuF/vQ7uP+qcetB99jaaAZINuoZHary7+n334nzyx2+MCrsgt35oX3yd"
    "/E06Mu3bz4N7j5M/jUjHsL16sv3iSfI3sz4oD8XL+93rr5I/lpugpOvKp1y4sfFmMrYqz6g3ambJd0PHlP1n0OOdqWfIiqlnYEKi"
    "LqMGVSm74Ot3FlZAs/997CRwFpRH8PR8QuqjNoNOZVRaUIwcJl63V6+ju33j++DMeLDwRjs4uFh7XMsH3qvgAxwtNOjrt9qXr8M2"
    "wtigTMCjb69ebP34PfwEnXcWZ4IfpltTb2F+3ZMvg3c/yz4ffd+ZPs3eRufhye69W8H9K6zrEqIkJ23YXsgasEowXxgE1qslVCzp"
    "zo9B18H6k+7Y7WDifuvKUx0/sIViCHaNuneMda9kC40kQ5Znl8HHa58/0770DF0X+gBqOZg4A3YEGIgivDhHLs1M59U4OIwby/dB"
    "7QExrxT4gF7i/EqwcC94cBVG0a23DFouXDDrZ2gLNqPz+oKeOCYHTM9yIAabw0K3bGqk1g0LlUbg6iteNAYCl18Ec4ud9fMwfVgZ"
    "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"
    "ZJaa6BIWODFYLMuWqJSnZhj8nr8QlmnT0xrMuPPsNKuXne72oylurMzKU5lDHKY4iDzP3maaRBvHArRIFa98rUIPqp6D48/PuvC9"
    "0vkzsl5JvVrkreWVcPVr/no+iaqjLgU3f8TyJnU3zTIOxp57gtBOr1TiPambXNnk9a8YMy+tkWF+1F59yhoA7d+9JyHzW1M/tFdv"
    "aUV5j+R6w0odDjnL8V/wBkFNMXexYUexM4Gpt9nVaBKzjzBvCP7w/BT3Rs4nFn/RQLk9w970V+XVfvbpbpK65pRlIpnuikPbnToK"
    "/9k0PZ/zfvQiFG9pL2cMCDADWB69Pxa+c8S0vczBcbBGyZd3o/yaNIeU4jMOkyZADeRQUYqNq0wxq6b9WQU7RJF6ncDFkZS5xuWD"
    "+xhuAnhanXeYZe28eBjMXKZ7vKtcR6rhPXEz8XbjNsxaXsPTk1w4JxvLl8LuqdhyBpQ4iDnLO5ZT0Cqlv4FDE8sxsTpzT815pv1i"
    "saNKAlJ6z7FN+WpyPBh7ixnEhbtwJrNsKVcNl302kDumzu6V7Tm1mF8H3TErMuoWhw3XTp3hBQzRSuGefxypNwVbEEp5FK7HrBqc"
    "n86jhxtrVMN5aXFj9drG+t3WyUWt3PdFc029GE+dzWjM2CFKCV7Td1xLHg2KGVpT6xA0ZdEGkvQHG+xYgoKFY5tHFd3MxLuOKRNC"
    "tNGPNOz48ZXKGGXhWuJiJzncIdc6apRHI3LkwbXFSAqpNRfrYoEdvtaCyPQN16IAe+hBmSpnCV8jxV/3xN9aYmWTF0K7yFdlqYIm"
    "SeSZhluucgEl34KGzxoSZlSSZ0PfmMVkmybbUxmerouyunyi/A+XmORM7qhlHKCn8pxcnIs/ic8Q285+Qz0kYmmbfoOaFzgde6iR"
    "bEPPijhexldFE0ubTIjoQxPOz5VyTLhabfi8nS8KJS5E7oySbx7i54e1U7gcLJ+FqHMCi2LaK+ucz0DvlhjPD65lagUCT6r0TJxZ"
    "OV7Tkx7YeiIkV9KRqVokHh09kUOp/CvUIHxLERbdr58NeRqekUYFQhN246gV15BQuXzsJDGVB64me4tMkM6FJ8hYnrHGy9uxfTtI"
    "4XZZuF/6xnPsnEZhFvvydXB+gwksbxZ/svxPm4PisFkzDc/0MCH7iBFBLgYrF9nj4sPYuvROvp1RWo7q4ZKKMj5evyp2jS9IU/gq"
    "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"
    "hwEAAAA="
)


# ---------------------------------------------------------------- 路径

def base_dir():
    """数据放在 exe 旁边，而不是 PyInstaller 的临时解压目录。

    开发模式（直接跑 .py）时，本文件在 desktop/ 下，
    而前端产物 www/ 在项目根，所以往回找一层。既找不到就原地。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))

    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    if os.path.isdir(os.path.join(parent, "www")) or os.path.isfile(os.path.join(parent, "index.html")):
        return parent
    return here


DATA_DIR = os.path.join(base_dir(), "keyapp-data")
FILE_DIR = os.path.join(DATA_DIR, "files")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
TOKENS_FILE = os.path.join(DATA_DIR, "tokens.json")
PROFILE_DIR = os.path.join(DATA_DIR, "window-profile")
# 内嵌 WebView2 的 localStorage / IndexedDB 落在这个目录，换 exe 也不丢
WEBVIEW_STORAGE = os.path.join(DATA_DIR, "webview")
# 密钥密文（DPAPI）
SECRETS_FILE = os.path.join(DATA_DIR, "secrets.dat")


def _make_secure_store():
    """SECRETS_FILE 依赖 DATA_DIR，而 DATA_DIR 在自测里会被改指向临时目录，
    所以不能提前创建实例，用函数惰性构造。"""
    try:
        import secure_store
    except Exception:
        return None
    return secure_store.DpapiStore(SECRETS_FILE)


def ensure_dirs():
    os.makedirs(FILE_DIR, exist_ok=True)


def load_json(path, fallback):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def save_json(path, value):
    """原子写。临时文件名必须每线程不同：
    并发时两个请求都写 state.json.tmp 会撞在一起（
    实测会抛 PermissionError: 另一个程序正在使用此文件）。"""
    tmp = "%s.%d.%d.%s.tmp" % (path, os.getpid(),
                                threading.get_ident(),
                                binascii.hexlify(os.urandom(4)).decode("ascii"))
    try:
        with io.open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        # Windows 上目标文件被另一个线程/杀软瞬时占用时 os.replace 会抛
        # PermissionError（WinError 5/32）。重试几次比直接 500 好。
        last = None
        for _ in range(8):
            try:
                os.replace(tmp, path)
                return
            except OSError as e:
                last = e
                time.sleep(0.02)
        raise last
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def local_ips():
    """返回 (主网卡 IP, 其他 IP)。主网卡用 UDP 出站地址判断，
    虚拟机/虚拟网卡排后面，免得用户不知道该填哪个。"""
    primary = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
    except Exception:
        primary = None

    others = []
    try:
        for fam, _, _, _, sockaddr in socket.getaddrinfo(socket.gethostname(), None):
            if fam != socket.AF_INET:
                continue
            ip = sockaddr[0]
            if ip.startswith("127.") or ip == primary or ip in others:
                continue
            others.append(ip)
    except Exception:
        pass

    if not primary:
        primary = others.pop(0) if others else "127.0.0.1"
    return primary, others


def fingerprint_for(port):
    raw = "%s|%d|%s" % (socket.gethostname(), port, os.name)
    h1, h2 = 0x811C9DC5, 0x01000193
    for ch in raw:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x01000193) & 0xFFFFFFFF
        h2 = (h2 + c * 31) & 0xFFFFFFFF
    return "%08x%08x" % (h1, h2)


def new_token():
    return base64.b16encode(os.urandom(24)).decode("ascii").lower()


# ---------------------------------------------------------------- 内嵌资源

def load_assets():
    """把内嵌的 zip 解成 {路径: bytes}，进程内只解一次。"""
    if not ASSETS_B64.strip():
        return None
    try:
        raw = base64.b64decode(ASSETS_B64.encode("ascii"))
        zf = zipfile.ZipFile(io.BytesIO(raw))
        return {n: zf.read(n) for n in zf.namelist() if not n.endswith("/")}
    except Exception:
        return None


_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
}


def content_type(path):
    _, ext = os.path.splitext(path.lower())
    return _TYPES.get(ext, "application/octet-stream")


# ---------------------------------------------------------------- 同步合并

def merge_state(local, remote):
    """同一个 id 取 updatedAt 更新的；墓碑比对话新就删掉。"""
    out = {"conversations": {}, "tombstones": {}, "skills": None, "skillsAt": 0, "updatedAt": 0}

    lc = (local or {}).get("conversations") or {}
    rc = (remote or {}).get("conversations") or {}
    lt = (local or {}).get("tombstones") or {}
    rt = (remote or {}).get("tombstones") or {}

    for cid in set(list(lc.keys()) + list(rc.keys())):
        a, b = lc.get(cid), rc.get(cid)
        if a and b:
            out["conversations"][cid] = b if (b.get("updatedAt") or 0) > (a.get("updatedAt") or 0) else a
        else:
            out["conversations"][cid] = a or b

    for cid in set(list(lt.keys()) + list(rt.keys())):
        out["tombstones"][cid] = max(lt.get(cid) or 0, rt.get(cid) or 0)

    for cid, ts in list(out["tombstones"].items()):
        conv = out["conversations"].get(cid)
        if conv and (conv.get("updatedAt") or 0) <= ts:
            out["conversations"].pop(cid, None)

    cutoff = int(time.time() * 1000) - 7 * 24 * 3600 * 1000
    out["tombstones"] = {k: v for k, v in out["tombstones"].items() if v >= cutoff}

    ls = (local or {}).get("skillsAt") or 0
    rs = (remote or {}).get("skillsAt") or 0
    if rs > ls:
        out["skills"] = (remote or {}).get("skills")
        out["skillsAt"] = rs
    elif ls > 0:
        out["skills"] = (local or {}).get("skills")
        out["skillsAt"] = ls

    out["updatedAt"] = int(time.time() * 1000)
    return out


# ---------------------------------------------------------------- 服务状态

class Hub(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.port = DEFAULT_PORT
        self.alias = "电脑"
        self.pair_code = "%06d" % (int.from_bytes(os.urandom(3), "big") % 1000000)
        self.tokens = {}
        self.peers = {}
        self.logs = []
        # 实时推送：订阅了 /api/events 的连接。每项 {wfile, lock, alive, agent}
        self.sse = []
        self.sse_lock = threading.Lock()
        # 配对码限速：ip -> {"n": 失败次数, "first": 起始时, "until": 封到什么时候}
        self.pair_fails = {}
        # 同步的「读-合并-写」必须串行，否则两个并发请求会互相覆盖（丢更新）
        self.state_lock = threading.Lock()

    # ---------- 配对码限速 ----------

    def pair_blocked(self, ip):
        with self.lock:
            rec = self.pair_fails.get(ip)
            if not rec:
                return 0
            now = int(time.time() * 1000)
            if rec.get("until") and now < rec["until"]:
                return int((rec["until"] - now) / 1000) + 1
            return 0

    def note_pair_fail(self, ip):
        now = int(time.time() * 1000)
        with self.lock:
            rec = self.pair_fails.get(ip) or {"n": 0, "first": now, "until": 0}
            if now - rec["first"] > PAIR_WINDOW_MS:
                rec = {"n": 0, "first": now, "until": 0}
            rec["n"] += 1
            if rec["n"] >= PAIR_MAX_FAILS:
                rec["until"] = now + PAIR_WINDOW_MS
                rec["n"] = 0
                rec["first"] = now
            self.pair_fails[ip] = rec

    def clear_pair_fail(self, ip):
        with self.lock:
            self.pair_fails.pop(ip, None)

    # ---------- 实时推送 ----------

    def add_sse(self, client):
        with self.sse_lock:
            self.sse.append(client)

    def drop_sse(self, client):
        with self.sse_lock:
            try:
                self.sse.remove(client)
            except ValueError:
                pass

    def broadcast(self, kind, payload=None, origin_token=None):
        """给所有订阅端推一条事件。谁写失败就把谁踢掉。

        origin_token：不要推回发起方自己，否则「收到事件→同步→广播」会无限对抽。
        """
        frame = "event: %s\ndata: %s\n\n" % (
            kind, json.dumps(payload or {}, ensure_ascii=False))
        with self.sse_lock:
            targets = list(self.sse)
        dead = []
        for c in targets:
            if origin_token and c.get("token") == origin_token:
                continue
            try:
                with c["lock"]:
                    data = frame.encode("utf-8")
                    c["wfile"].write(b"%x\r\n" % len(data) + data + b"\r\n")
                    c["wfile"].flush()
            except Exception:
                dead.append(c)
        for c in dead:
            self.drop_sse(c)
            c["alive"] = False

    def sse_count(self):
        with self.sse_lock:
            return len(self.sse)

    def log(self, message):
        line = time.strftime("%H:%M:%S") + "  " + message
        with self.lock:
            self.logs.append(line)
            if len(self.logs) > 300:
                del self.logs[:150]
        print(line, flush=True)

    def load_tokens(self):
        with self.lock:
            self.tokens = load_json(TOKENS_FILE, {}) or {}

    def save_tokens(self):
        with self.lock:
            save_json(TOKENS_FILE, self.tokens)

    def add_token(self, device_name):
        tk = new_token()
        with self.lock:
            self.tokens[tk] = {"device": (device_name or "device")[:40], "at": int(time.time() * 1000)}
        self.save_tokens()
        return tk

    def check_token(self, tk):
        with self.lock:
            return bool(tk) and tk in self.tokens

    def note_peer(self, fp, alias, address, port, model=""):
        if not fp or fp == fingerprint_for(self.port):
            return False
        with self.lock:
            is_new = fp not in self.peers
            self.peers[fp] = {
                "fingerprint": fp,
                "alias": (alias or address)[:40],
                "address": address,
                "port": int(port or DISCOVERY_PORT),
                "deviceModel": model,
                "at": int(time.time() * 1000),
            }
        return is_new

    def peer_list(self):
        self_fp = fingerprint_for(self.port)
        cutoff = int(time.time() * 1000) - 10 * 60 * 1000
        with self.lock:
            return [p for p in self.peers.values() if p["at"] >= cutoff and p["fingerprint"] != self_fp]


HUB = Hub()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "KeyappDesktop/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "authorization, content-type, x-filename")
        self.send_header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")

    def _json(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _drain(self, limit=4 * 1024 * 1024):
        """把没读完的请求体丢掉再回错误。

        不排空就直接断连，客户端还在发数据时收到 RST，会报
        ConnectionAbortedError 而不是看到真正的 413。"""
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        left = min(n, limit)
        try:
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
        except Exception:
            pass

    def _raw(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        # 本地服务不用缓存：改了代码重启就能看到，不会被浏览器留着旧版
        self.send_header("cache-control", "no-store, no-cache, must-revalidate")
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    # ---------- 请求体 ----------

    def _body(self, limit=None):
        """读请求体。超过上限就不读，直接抛 TooLarge（以前不限，
        局域网里发一个超大 body 就能把内存吃光）。"""
        limit = MAX_FILE if limit is None else limit
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n > limit:
            raise TooLarge(n)
        if n <= 0:
            return b""
        data = self.rfile.read(n)
        if len(data) > limit:
            raise TooLarge(len(data))
        return data

    def _body_json(self, limit=None):
        try:
            raw = self._body(MAX_JSON if limit is None else limit)
        except TooLarge as e:
            raise
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}

    def _is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _token(self):
        h = self.headers.get("authorization") or ""
        return h[7:].strip() if h.startswith("Bearer ") else ""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("content-length", "0")
        self._cors()
        self.end_headers()

    # ---------- 实时推送（SSE）----------

    def _sse(self, token=""):
        """长连接推送。用 chunked 编码，每条事件一个 chunk。"""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "keep-alive")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("x-accel-buffering", "no")
        self._cors()
        self.end_headers()

        client = {"wfile": self.wfile, "lock": threading.Lock(), "alive": True,
                  "agent": self.client_address[0], "token": token}
        HUB.add_sse(client)
        HUB.log("实时推送：%s 已连上（共 %d 个）" % (client["agent"], HUB.sse_count()))

        def chunk(text):
            data = text.encode("utf-8")
            with client["lock"]:
                self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                self.wfile.flush()

        try:
            chunk("retry: 3000\n\n")
            chunk("event: hello\ndata: %s\n\n" % json.dumps({"port": HUB.port}))
            last = time.time()
            while client["alive"]:
                time.sleep(1)
                if time.time() - last >= 15:
                    chunk(": ping\n\n")     # 注释行当心跳，EventSource 会忽略
                    last = time.time()
        except Exception:
            pass
        finally:
            client["alive"] = False
            HUB.drop_sse(client)
            self.close_connection = True
            HUB.log("实时推送：%s 断开（剩 %d 个）" % (client["agent"], HUB.sse_count()))

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        try:
            return self._route_inner(method)
        except TooLarge as e:
            # 先把没读完的 body 排掉，再回 413；否则客户端会看到 RST
            self._drain()
            self.close_connection = True
            return self._json(413, {"error": "too-large", "bytes": e.size},
                              {"connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return None

    def _route_inner(self, method):
        path = self.path.split("?")[0]

        # 手机扫描局域网时先打这个：免认证，只回一个身份标记，不含任何隐私
        # 电脑端自己看的东西（配对码、设备、文件）都走这个。
        # 本机专用：局域网其他设备拿到 403，所以不需要令牌。
        if path == "/api/host/info":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            primary, others = local_ips()
            devices = []
            for tk, meta in list(HUB.tokens.items()):
                devices.append({
                    "tail": tk[-6:],
                    "device": meta.get("device") or "device",
                    "at": meta.get("at") or 0,
                })
            devices.sort(key=lambda x: -x["at"])
            files = []
            try:
                for n in os.listdir(FILE_DIR):
                    fp = os.path.join(FILE_DIR, n)
                    if os.path.isfile(fp):
                        st = os.stat(fp)
                        files.append({"name": n, "size": st.st_size, "at": int(st.st_mtime * 1000)})
            except Exception:
                pass
            files.sort(key=lambda x: -x["at"])
            return self._json(200, {
                "code": HUB.pair_code,
                "alias": HUB.alias,
                "port": HUB.port,
                "ip": primary,
                "url": "http://%s:%d" % (primary, HUB.port),
                "otherIps": others,
                "devices": devices[:50],
                "files": files[:200],
            })

        if path == "/api/host/kick" and method == "POST":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            tail = str((self._body_json() or {}).get("tail") or "")
            removed = 0
            with HUB.lock:
                for tk in list(HUB.tokens.keys()):
                    if tail and tk.endswith(tail):
                        HUB.tokens.pop(tk, None)
                        removed += 1
            if removed:
                HUB.save_tokens()
                HUB.log("已断开 %d 台设备" % removed)
            return self._json(200, {"removed": removed})

        if path == "/api/host/file" and method == "POST":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            raw_name = unquote(self.headers.get("x-filename") or "file")
            safe = os.path.basename(raw_name)
            for ch in '\\/:*?"<>|':
                safe = safe.replace(ch, "_")
            safe = safe[:120] or "file"
            data = self._body()
            if not data:
                return self._json(400, {"error": "empty"})
            name, i = safe, 1
            while os.path.exists(os.path.join(FILE_DIR, name)):
                stem, ext = os.path.splitext(safe)
                name = "%s-%d%s" % (stem, i, ext)
                i += 1
            with open(os.path.join(FILE_DIR, name), "wb") as f:
                f.write(data)
            HUB.log("收到文件：%s（%d 字节）" % (name, len(data)))
            return self._json(200, {"name": name, "size": len(data)})

        if path.startswith("/api/host/file/"):
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            name = os.path.basename(unquote(path[len("/api/host/file/"):]))
            fp = os.path.join(FILE_DIR, name)
            if method == "DELETE":
                try:
                    os.remove(fp)
                    HUB.log("删除文件：%s" % name)
                except Exception:
                    pass
                return self._json(200, {"ok": True})
            if not os.path.isfile(fp):
                return self._json(404, {"error": "not-found"})
            with open(fp, "rb") as f:
                data = f.read()
            return self._raw(200, data, "application/octet-stream",
                             {"content-disposition": 'attachment; filename="%s"' % quote(name)})

        if path == "/api/ping":
            primary, _ = local_ips()
            return self._json(200, {
                "app": APP_TAG, "alias": HUB.alias,
                "url": "http://%s:%d" % (primary, HUB.port),
                "port": HUB.port, "version": APP_VERSION
            })

        if path == "/api/code":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            primary, others = local_ips()
            return self._json(200, {
                "code": HUB.pair_code, "port": HUB.port, "alias": HUB.alias,
                "ip": primary, "otherIps": others,
                "url": "http://%s:%d" % (primary, HUB.port),
                "devices": len(HUB.tokens),
                "version": "1.0",
            })

        # 实时推送。EventSource 不能带 header，所以令牌走 ?token=；
        # 本机（电脑端自己的界面）不需要令牌。
        if path == "/api/events" and method == "GET":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qtok = ""
            for part in qs.split("&"):
                if part.startswith("token="):
                    qtok = unquote(part[6:])
            if not (self._is_local() or HUB.check_token(qtok)):
                return self._json(401, {"error": "unauthorized"})
            return self._sse(qtok)

        if path == "/api/register" and method == "POST":
            body = self._body_json()
            if body.get("app") == APP_TAG and body.get("fingerprint"):
                HUB.note_peer(str(body["fingerprint"]), body.get("alias"), self.client_address[0],
                              body.get("port"), body.get("deviceModel", ""))
            return self._json(200, {"ok": True, "alias": HUB.alias})

        if path == "/api/pair" and method == "POST":
            ip = self.client_address[0]
            wait = HUB.pair_blocked(ip)
            if wait > 0:
                HUB.log("配对被限速：%s 还需等 %d 秒" % (ip, wait))
                return self._json(429, {"error": "too-many-attempts", "retryAfter": wait})
            body = self._body_json()
            if str(body.get("code") or "").strip() != HUB.pair_code:
                HUB.note_pair_fail(ip)
                HUB.log("配对失败：配对码不对（来自 %s）" % ip)
                return self._json(401, {"error": "bad-code"})
            HUB.clear_pair_fail(ip)
            tk = HUB.add_token(body.get("deviceName"))
            HUB.log("已配对：%s" % ((body.get("deviceName") or "device")[:30]))
            return self._json(200, {"token": tk})

        if path == "/api/version":
            # 电脑端界面（localhost）查版本不需要令牌
            if not ((LOCAL_FREE and self._is_local()) or HUB.check_token(self._token())):
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {
                "version": APP_VERSION,
                "app": APP_TAG,
                "repo": APP_REPO,
                "platform": "desktop",
            })

        if path.startswith("/api/"):
            # 本机（127.0.0.1）免令牌：能连到本机端口就说明已经在本机了，
            # 而电脑端自己的界面就是由这个端口托管的，它必须能读写同一份数据，
            # 否则电脑上的对话永远进不了同步。
            # LOCAL_FREE 只是给自测用的开关，默认开。
            local_free = LOCAL_FREE and self._is_local()
            if not (local_free or HUB.check_token(self._token())):
                return self._json(401, {"error": "unauthorized"})

            if path == "/api/version":
                return self._json(200, {
                    "version": APP_VERSION,
                    "app": APP_TAG,
                    "repo": APP_REPO,
                    "platform": "desktop",
                })

            # 客户端告诉中枢「我这边改了东西」→ 广播给其他端，它们自己去拉
            if path == "/api/touch" and method == "POST":
                body = self._body_json()
                HUB.broadcast("changed", {"from": body.get("device") or "device",
                                          "at": int(time.time() * 1000)},
                              origin_token=self._token())
                return self._json(200, {"ok": True, "listeners": HUB.sse_count()})

            if path == "/api/info":
                return self._json(200, {"name": APP_NAME + " · 电脑端", "version": 1,
                                        "alias": HUB.alias, "devices": len(HUB.tokens), "port": HUB.port})

            if path == "/api/devices" and method == "GET":
                out = []
                for tk, meta in list(HUB.tokens.items()):
                    out.append({
                        "tail": tk[-6:],
                        "device": meta.get("device") or "device",
                        "at": meta.get("at") or 0,
                    })
                out.sort(key=lambda x: -x["at"])
                return self._json(200, {"devices": out})

            if path == "/api/devices" and method == "DELETE":
                body = self._body_json()
                tail = str(body.get("tail") or "")
                removed = 0
                with HUB.lock:
                    for tk in list(HUB.tokens.keys()):
                        if tail and tk.endswith(tail):
                            HUB.tokens.pop(tk, None)
                            removed += 1
                if removed:
                    HUB.save_tokens()
                    HUB.log("已断开 %d 台设备" % removed)
                return self._json(200, {"removed": removed})

            if path == "/api/peers":
                return self._json(200, {"self": {"alias": HUB.alias, "port": HUB.port},
                                        "peers": HUB.peer_list()})

            if path == "/api/sync" and method == "GET":
                return self._json(200, load_json(STATE_FILE, {"conversations": {}, "tombstones": {},
                                                              "skills": None, "skillsAt": 0}))

            if path == "/api/sync" and method == "POST":
                incoming = self._body_json()
                # 读-合并-写串行：并发请求交叠会互相覆盖
                with HUB.state_lock:
                    local = load_json(STATE_FILE, {"conversations": {}, "tombstones": {},
                                                   "skills": None, "skillsAt": 0})
                    merged = merge_state(local, incoming)
                    save_json(STATE_FILE, merged)
                HUB.log("同步完成：%d 条对话" % len(merged["conversations"]))
                # 实时推送：把这次变更告诉其他端（发起方自己不用收，它已经拿到结果）
                HUB.broadcast("changed", {"from": str(incoming.get("device") or "device"),
                                          "at": int(time.time() * 1000)},
                              origin_token=self._token())
                return self._json(200, {"conversations": merged["conversations"],
                                        "tombstones": merged["tombstones"],
                                        "skills": merged["skills"], "skillsAt": merged["skillsAt"],
                                        "serverTime": int(time.time() * 1000)})

            if path == "/api/files" and method == "GET":
                items = []
                try:
                    for n in os.listdir(FILE_DIR):
                        fp = os.path.join(FILE_DIR, n)
                        if os.path.isfile(fp):
                            st = os.stat(fp)
                            items.append({"name": n, "size": st.st_size, "at": int(st.st_mtime * 1000)})
                except Exception:
                    pass
                items.sort(key=lambda x: -x["at"])
                return self._json(200, {"files": items[:200]})

            if path == "/api/files" and method == "POST":
                raw_name = unquote(self.headers.get("x-filename") or "file")
                safe = os.path.basename(raw_name)
                for ch in '\\/:*?"<>|':
                    safe = safe.replace(ch, "_")
                safe = safe[:120] or "file"
                data = self._body(MAX_FILE)
                if not data:
                    return self._json(400, {"error": "empty"})
                name, i = safe, 1
                while os.path.exists(os.path.join(FILE_DIR, name)):
                    stem, ext = os.path.splitext(safe)
                    name = "%s-%d%s" % (stem, i, ext)
                    i += 1
                with open(os.path.join(FILE_DIR, name), "wb") as f:
                    f.write(data)
                HUB.log("收到文件：%s（%d 字节）" % (name, len(data)))
                return self._json(200, {"name": name, "size": len(data)})

            if path.startswith("/api/files/"):
                name = os.path.basename(unquote(path[len("/api/files/"):]))
                fp = os.path.join(FILE_DIR, name)
                if method == "DELETE":
                    try:
                        os.remove(fp)
                        HUB.log("删除文件：%s" % name)
                    except Exception:
                        pass
                    return self._json(200, {"ok": True})
                if not os.path.isfile(fp):
                    return self._json(404, {"error": "not-found"})
                with open(fp, "rb") as f:
                    data = f.read()
                return self._raw(200, data, "application/octet-stream",
                                 {"content-disposition": 'attachment; filename="%s"' % quote(name)})

        if method == "GET":
            return self._static(path)
        return self._json(405, {"error": "method"})

    def _static(self, path):
        assets = self.server.assets
        if not path or path == "/":
            path = "/index.html"
        rel = path.lstrip("/")

        # 只接受干净的相对路径：拒绝 ..、反斜杠、隐藏文件（.git/.env 之类）
        if ".." in rel or "\\" in rel or "\x00" in rel:
            return self._json(400, {"error": "bad-path"})
        if any(seg.startswith(".") for seg in rel.split("/") if seg):
            return self._json(404, {"error": "not-found"})

        if assets is not None:
            data = assets.get(rel)
            if data is None:
                # SPA 回落只给「无扩展名」的路径。
                # 以前任何路径都回首页，于是 /package.json 也返回 200，
                # 既掩盖了路径探测，也让客户端分不清 404 和首页。
                if os.path.splitext(rel)[1]:
                    return self._json(404, {"error": "not-found"})
                data = assets.get("index.html")
                if data is None:
                    return self._json(404, {"error": "not-found"})
                rel = "index.html"
            return self._raw(200, data, content_type(rel))

        root = getattr(self.server, "www_dir", "") or ""
        fp = os.path.abspath(os.path.join(root, rel))
        if not root or not fp.startswith(os.path.abspath(root)):
            return self._json(400, {"error": "bad-path"})
        if not os.path.isfile(fp):
            # 无扩展名 → 回首页（同上面）
            if not os.path.splitext(rel)[1]:
                idx = os.path.join(os.path.abspath(root), "index.html")
                if os.path.isfile(idx):
                    with open(idx, "rb") as f:
                        return self._raw(200, f.read(), content_type("index.html"))
            return self._json(404, {"error": "not-found"})
        with open(fp, "rb") as f:
            return self._raw(200, f.read(), content_type(rel))


# ---------------------------------------------------------------- 组播发现

class Discovery(threading.Thread):
    def __init__(self, port):
        threading.Thread.__init__(self)
        self.daemon = True
        self.port = port
        self.fp = fingerprint_for(port)
        self.stop_flag = threading.Event()
        self.sock = None

    def _payload(self, announce):
        return json.dumps({
            "alias": HUB.alias, "version": "2.0", "deviceModel": sys.platform,
            "deviceType": "desktop", "fingerprint": self.fp, "port": self.port,
            "protocol": "http", "app": APP_TAG, "download": True, "announce": announce,
        }, ensure_ascii=False).encode("utf-8")

    def run(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except Exception:
                pass
            s.bind(("", DISCOVERY_PORT))
            mreq = struct.pack("4sl", socket.inet_aton(DISCOVERY_GROUP), socket.INADDR_ANY)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            s.settimeout(1.0)
            self.sock = s
        except Exception as e:
            HUB.log("组播启动失败（不影响手填地址）：%s" % e)
            return

        try:
            self.sock.sendto(self._payload(True), (DISCOVERY_GROUP, DISCOVERY_PORT))
        except Exception:
            pass
        last = time.time()

        while not self.stop_flag.is_set():
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                data, addr = None, None
            except Exception:
                break

            if data:
                try:
                    j = json.loads(data.decode("utf-8", "ignore"))
                except Exception:
                    j = None
                if j and j.get("app") == APP_TAG and j.get("fingerprint") != self.fp:
                    if HUB.note_peer(str(j.get("fingerprint")), j.get("alias"), addr[0],
                                     j.get("port"), j.get("deviceModel", "")):
                        HUB.log("发现设备：%s @ %s" % (j.get("alias") or addr[0], addr[0]))
                    if j.get("announce"):
                        try:
                            self.sock.sendto(self._payload(False), (addr[0], DISCOVERY_PORT))
                        except Exception:
                            pass

            if time.time() - last > 30:
                try:
                    self.sock.sendto(self._payload(True), (DISCOVERY_GROUP, DISCOVERY_PORT))
                except Exception:
                    pass
                last = time.time()

        try:
            self.sock.close()
        except Exception:
            pass

    def stop(self):
        self.stop_flag.set()


# ---------------------------------------------------------------- 启停

def _port_in_use(p):
    """有人在这个端口监听吗。

    不能只看自己能不能 bind：Windows 下别人只绑 127.0.0.1:8787 时，
    我们绑 0.0.0.0:8787 依然会成功，但客户端连 127.0.0.1 就打到别人那里去了。
    （实测：python -m http.server 占着 8787，find_free_port 仍返回 8787）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", p)) == 0
    except Exception:
        return False
    finally:
        s.close()


def find_free_port(start=DEFAULT_PORT, tries=20):
    """找一个真能用的端口。全被占时返回 None（以前是直接返回 start，
    结果去 bind 一个已占用的端口，进程直接崩，用户什么提示也看不到）。"""
    for p in range(start, start + tries):
        if _port_in_use(p):
            continue
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("0.0.0.0", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return None


def already_running(port):
    """已经在跑时返回它的版本号；没跑或端口上是别的程序时返回 None。

    以前只判 HTTP 200，于是 8787 被别的软件占用时会把对方当成自己，
    弹出来的窗口里是别人的页面。现在必须真的回 app=keyapp 才算。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/ping" % port, timeout=1.5) as r:
            if r.status != 200:
                return None
            info = json.loads(r.read().decode("utf-8") or "{}")
            if not isinstance(info, dict) or info.get("app") != APP_TAG:
                return None
            return str(info.get("version") or "")
    except Exception:
        return None


def start_server(port, assets, www_dir):
    HUB.port = port
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    srv.assets = assets
    srv.www_dir = www_dir
    t = threading.Thread(target=srv.serve_forever)
    t.daemon = True
    t.start()
    return srv


# ---------------------------------------------------------------- 应用窗口
#
# 首选：pywebview 的 edgechromium 后端 → 内嵌 WebView2 控件。
#       窗口属于本进程，不起浏览器，localStorage 落在 WEBVIEW_STORAGE。
# 次选：Chrome/Edge 的 --app 应用模式（看着像独立软件，但仍是浏览器进程）。
# 末选：系统默认浏览器 + 一个能看配对码的 tk 小窗。

BROWSER_CANDIDATES = [
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
]

# 窗口标题里出现这个就认为是我们的界面
WINDOW_TITLE_HINT = "钥匙"

WEBVIEW_STATE = {"checked": False, "ok": False, "why": ""}


def fetch_sidecar_hash(url):
    """去拉 `<url>.sha256` 旁文件。返回十六进制哈希或空串。

    release 页不提供 digest 时的备选：把一个同名 .sha256 文件一起上传即可。
    内容格式随意，取里面第一个 64 位十六进制串（兼容 `hash  filename` 写法）。"""
    import re
    try:
        req = urllib.request.Request(url + ".sha256", headers={"user-agent": "keyapp-updater/1"})
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read(4096).decode("utf-8", "replace")
        m = re.search(r"\b([0-9a-fA-F]{64})\b", text)
        return m.group(1).lower() if m else ""
    except Exception:
        return ""


def write_update_script(script_path, target, new_exe, old_path):
    """生成「等进程退出 → 改名旧版 → 放新版 → 启动」的 cmd 脚本。

    抽成独立函数是为了能单独测：直接跑这段 cmd 验证替换是否真的成功，
    不用真的下载一遍。

    为什么要重试：刚 os._exit 时 Windows 可能还没释放弃文件句柄，
    move 会失败。不能一次就放弃，否则用户点了更新什么都没发生。
    """
    lines = [
        "@echo off",
        "chcp 936 >nul",
        "timeout /t 2 /nobreak >nul",
        "set n=0",
        ":retry",
        'move /y "%s" "%s" >nul 2>&1' % (target, old_path),
        "if errorlevel 1 (",
        "  set /a n+=1",
        "  if %n% GEQ 20 goto fail",
        "  timeout /t 1 /nobreak >nul",
        "  goto retry",
        ")",
        'move /y "%s" "%s" >nul 2>&1' % (new_exe, target),
        "if errorlevel 1 goto restore",
        'del "%s" >nul 2>&1' % old_path,
        'start "" "%s"' % target,
        "exit /b 0",
        ":restore",
        'move /y "%s" "%s" >nul 2>&1' % (old_path, target),
        ":fail",
        'start "" "%s"' % target,
        "exit /b 1",
    ]
    with io.open(script_path, "w", encoding="gbk", newline="\r\n") as f:
        f.write("\r\n".join(lines))
    return script_path


class _Bridge:
    """暴露给页面的极小接口。
    open_external — 外链丢给系统浏览器，别把整个应用导航走
    self_update   — 下载新版 exe 并自己换上去（无需手动下载）
    secure_*      — Windows DPAPI 加密存密钥（不再明文放 localStorage）"""

    def secure_available(self):
        st = _make_secure_store()
        return bool(st and st.is_available())

    def secure_get(self, key):
        st = _make_secure_store()
        if not st:
            return None
        try:
            return st.get(key)
        except Exception as e:
            HUB.log("读取密钥失败：%s" % e)
            return None

    def secure_set(self, key, value):
        st = _make_secure_store()
        if not st:
            return False
        try:
            return bool(st.set(key, value))
        except Exception as e:
            HUB.log("保存密钥失败：%s" % e)
            return False

    def secure_remove(self, key):
        st = _make_secure_store()
        if not st:
            return False
        try:
            return bool(st.remove(key))
        except Exception as e:
            HUB.log("删除密钥失败：%s" % e)
            return False


    def open_external(self, url):
        try:
            if isinstance(url, str) and url.split(":", 1)[0].lower() in ("http", "https", "mailto"):
                webbrowser.open(url)
                return True
        except Exception:
            pass
        return False

    def app_version(self):
        return APP_VERSION

    def self_update(self, url, sha256=""):
        """下载并安装新版。返回 {ok, error}。

        sha256：期望的十六进制哈希（可空）。给了就必须一致才装。
          电脑端的 exe 里跑着用户的密钥，下错一个文件就把整个程序换掉了，
          所以没校验时至少去拉一个 .sha256 旁文件；两样都没有就拒装。

        Windows 不允许覆盖正在运行的 exe，但**允许改名**，所以：
          1. 下到 keyapp-data/update/new.exe
          2. 启一个分离的 cmd：等我们退出 → 改名旧 exe → 放新的 → 启动
          3. 本进程直接 _exit
        中途任何一步失败都把临时文件删干净，原 exe 不动。"""
        try:
            return self._self_update(url, sha256)
        except Exception as e:
            HUB.log("自动更新失败：%s" % e)
            return {"ok": False, "error": str(e)}

    def _self_update(self, url, sha256=""):
        ok_scheme = url.lower().startswith("https://") if isinstance(url, str) else False
        if UPDATE_ALLOW_HTTP and isinstance(url, str) and url.lower().startswith("http://127.0.0.1"):
            ok_scheme = True
        if not ok_scheme:
            return {"ok": False, "error": "bad-url"}
        if not getattr(sys, "frozen", False):
            # 开发模式（直接跑 .py）没有可替换的 exe，只开链接
            webbrowser.open(url)
            return {"ok": False, "error": "dev-mode"}

        target = os.path.abspath(sys.executable)
        if not target.lower().endswith(".exe"):
            return {"ok": False, "error": "not-exe"}

        upd_dir = os.path.join(DATA_DIR, "update")
        os.makedirs(upd_dir, exist_ok=True)
        tmp = os.path.join(upd_dir, "new.exe")
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass

        HUB.log("正在下载新版本…")
        req = urllib.request.Request(url, headers={
            "user-agent": "keyapp-updater/1",
            "accept": "application/octet-stream",
        })
        digest = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(262144)
                if not chunk:
                    break
                f.write(chunk)
                digest.update(chunk)
                total += len(chunk)
                if total > 400 * 1024 * 1024:
                    f.close()
                    os.remove(tmp)
                    return {"ok": False, "error": "文件太大，放弃"}
        actual = digest.hexdigest()

        size = os.path.getsize(tmp)
        if size < 3 * 1024 * 1024:
            os.remove(tmp)
            return {"ok": False, "error": "下载的内容不是 exe（%d 字节）" % size}
        with open(tmp, "rb") as f:
            if f.read(2) != b"MZ":
                os.remove(tmp)
                return {"ok": False, "error": "下载的内容不是有效的 exe"}

        # ---------- SHA-256 校验 ----------
        want = (sha256 or "").strip().lower()
        if want.startswith("sha256:"):
            want = want[7:]
        if not want:
            want = fetch_sidecar_hash(url)
        if not want:
            os.remove(tmp)
            HUB.log("更新被拒：拿不到校验值")
            return {"ok": False, "error": "no-checksum"}
        if want != actual:
            os.remove(tmp)
            HUB.log("更新被拒：校验失败 期望 %s 实际 %s" % (want[:16], actual[:16]))
            return {"ok": False, "error": "checksum-mismatch",
                    "expected": want[:16], "actual": actual[:16]}
        HUB.log("校验通过 %s…" % actual[:16])

        old = target + ".old.exe"
        script = write_update_script(
            os.path.join(upd_dir, "apply.cmd"), target, tmp, old)

        HUB.log("下载完成（%.1f MB），正在替换并重启" % (size / 1048576.0))
        subprocess.Popen(
            ["cmd.exe", "/c", script],
            creationflags=0x00000008 | 0x00000200,   # DETACHED_PROCESS | NEW_PROCESS_GROUP
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        def _bye():
            time.sleep(1.0)
            os._exit(0)
        threading.Thread(target=_bye, daemon=True).start()
        return {"ok": True, "size": size}


# 页内装一层外链兵，只拦 http(s)/mailto，站内跳转不管。
_LINK_GUARD_JS = """
(function () {
  if (window.__keyappLinkGuard) return;
  window.__keyappLinkGuard = true;
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
        window.pywebview.api.open_external(href);
      } else {
        window.open(href, '_blank');
      }
    } catch (e) {}
  }, true);
})();
"""


def webview_available():
    """能不能用内嵌 WebView2。结果缓存，只探测一次。"""
    if WEBVIEW_STATE["checked"]:
        return WEBVIEW_STATE["ok"]

    WEBVIEW_STATE["checked"] = True
    try:
        import webview  # noqa: F401
    except Exception as e:
        WEBVIEW_STATE["why"] = "pywebview 导入失败: %s" % e
        return False

    # 后端要能实例化（缺 pythonnet / WebView2 DLL 时这里会报）
    try:
        from webview.platforms import edgechromium  # noqa: F401
    except Exception as e:
        WEBVIEW_STATE["why"] = "WebView2 后端不可用: %s" % e
        return False

    WEBVIEW_STATE["ok"] = True
    return True


def run_embedded_window(url, width=1040, height=800):
    """内嵌 WebView2 起窗口。阻塞到窗口关闭。
    返回 True = 用户正常关窗；False = 起不来（调用方该走兜底）。"""
    try:
        import webview
    except Exception as e:
        HUB.log("内嵌窗口不可用: %s" % e)
        return False

    try:
        os.makedirs(WEBVIEW_STORAGE, exist_ok=True)
    except Exception:
        pass

    try:
        window = webview.create_window(
            APP_NAME,
            url,
            width=width,
            height=height,
            min_size=(720, 520),
            text_select=True,
            confirm_close=False,
            js_api=_Bridge(),
        )
    except Exception as e:
        HUB.log("创建窗口失败: %s" % e)
        return False

    opened = {"ok": False}

    def _on_loaded():
        if not opened["ok"]:
            opened["ok"] = True
            HUB.log("窗口已就绪（内嵌 WebView2），关掉它就会退出")
        # 外链交给系统浏览器，别把应用本身导航走
        try:
            window.evaluate_js(_LINK_GUARD_JS)
        except Exception:
            pass

    try:
        window.events.loaded += _on_loaded
    except Exception:
        pass

    try:
        webview.start(
            gui="edgechromium",          # 明确指定，别让它去试 Qt/GTK
            private_mode=False,          # 要持久化 localStorage（密钥、会话）
            storage_path=WEBVIEW_STORAGE,
            debug=False,
        )
    except Exception as e:
        HUB.log("内嵌窗口启动失败: %s" % e)
        return False

    if not opened["ok"]:
        # start() 立刻返回、连页面都没加载 —— 当作启动失败去走兜底
        HUB.log("内嵌窗口没加载出页面")
        return False

    HUB.log("窗口已关闭，正在退出")
    return True


def find_browser():
    for raw in BROWSER_CANDIDATES:
        p = os.path.expandvars(raw)
        if "%" in p:
            continue
        if os.path.isfile(p):
            return p
    for name in ("chrome.exe", "msedge.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def app_window_exists():
    """有没有一个可见窗口，标题包含 WINDOW_TITLE_HINT。
    只用 ctypes 调 user32，不引第三方库。"""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return False

    try:
        user32 = ctypes.windll.user32
    except Exception:
        return False

    found = [False]
    ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            text = buf.value or ""
            if WINDOW_TITLE_HINT in text:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                # 排除掉樱桃自己的对话窗、以及那些很小的提示窗
                if (rect.right - rect.left) >= 480:
                    found[0] = True
                    return False
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(ENUMPROC(cb), 0)
    except Exception:
        return False
    return found[0]


def launch_app_window(url, width=1040, height=800):
    """浏览器应用模式（兜底用）。返回进程，可能很快就自己退出。"""
    exe = find_browser()
    if not exe:
        return None
    try:
        os.makedirs(PROFILE_DIR, exist_ok=True)
    except Exception:
        pass

    args = [
        exe,
        "--app=" + url,
        "--window-size=%d,%d" % (width, height),
        "--user-data-dir=" + PROFILE_DIR,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,msEdgeSidebarV2,msEdgeCollections",
        "--disable-background-timer-throttling",
    ]
    try:
        return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None


def watch_window(url):
    """等窗口出现，然后等它消失。返回 True 表示正常经历了一个开→关周期。"""
    appeared = False
    for _ in range(25):                 # 最多等 25 秒让它起来
        if app_window_exists():
            appeared = True
            break
        time.sleep(1)

    if not appeared:
        HUB.log("没看到界面窗口，可能浏览器把它并到了已有窗口里")
        return False

    HUB.log("窗口已就绪，关掉它就会退出")
    idle = 0
    while True:
        time.sleep(2)
        if app_window_exists():
            idle = 0
            continue
        # 关窗后给 3 秒缓冲：浏览器有时会在换 tab 时短暂消失
        idle += 1
        if idle >= 2:
            HUB.log("窗口已关闭，正在退出")
            return True


def fallback_window(url):
    """最后兜底：默认浏览器 + 一个能看配对码的小窗。"""
    import tkinter as tk

    primary, _ = local_ips()
    root = tk.Tk()
    root.title(APP_NAME + " · 电脑端")
    root.configure(bg="#F2F8FF")
    root.geometry("420x260")

    tk.Label(root, text=APP_NAME + " · 电脑端", bg="#2E7BD6", fg="white",
             font=("Microsoft YaHei UI", 12, "bold")).pack(fill="x", ipady=10)
    tk.Label(root, text="配对码", bg="#F2F8FF", fg="#5C6D63",
             font=("Microsoft YaHei UI", 9)).pack(pady=(14, 0))
    tk.Label(root, text=HUB.pair_code, bg="#F2F8FF", fg="#2E7BD6",
             font=("Consolas", 26, "bold")).pack()
    tk.Label(root, text="手机访问  http://%s:%d" % (primary, HUB.port),
             bg="#F2F8FF", fg="#17211C", font=("Consolas", 9)).pack(pady=(6, 2))
    tk.Label(root, text="界面已在默认浏览器打开。\n关掉这个窗口服务就停。",
             bg="#F2F8FF", fg="#5C6D63", font=("Microsoft YaHei UI", 8),
             justify="center").pack(pady=8)

    tk.Button(root, text="再打开一次界面", command=lambda: webbrowser.open(url),
              bg="#2E7BD6", fg="white", relief="flat",
              font=("Microsoft YaHei UI", 9), padx=12, pady=4).pack(pady=6)
    webbrowser.open(url)
    root.mainloop()


def show_window(url):
    """按 内嵌 → 浏览器应用模式 → 默认浏览器 的顺序起界面。阻塞到关窗。
    返回 True 表示窗口正常开过并关掉了。"""
    if webview_available():
        if run_embedded_window(url):
            return True
        HUB.log("内嵌窗口失败，改用浏览器应用模式")

    win = launch_app_window(url)
    if win is not None:
        return watch_window(url)

    HUB.log("没找到可用的浏览器窗口，改用系统默认浏览器")
    fallback_window(url)
    return True


# ---------------------------------------------------------------- 入口

def err_box(title, message):
    """弹一个错误框。没 tkinter 也不崩。"""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message)
        root.destroy()
    except Exception:
        HUB.log(title + ": " + message.replace("\n", " "))


def main():
    ensure_dirs()
    _dev_version()
    HUB.load_tokens()

    # 已经有服务在跑：把窗口带出来就行，不起第二个
    if already_running(DEFAULT_PORT):
        url = "http://127.0.0.1:%d/" % DEFAULT_PORT
        if webview_available():
            # 只是把界面挂上去看，关窗不影响那已经在跑的服务
            run_embedded_window(url)
            return
        if launch_app_window(url) is None:
            webbrowser.open(url)
        else:
            watch_window(url)
        return

    assets = load_assets()
    www_dir = os.path.join(base_dir(), "www")
    if assets is None and not os.path.isdir(www_dir):
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror(
                "打包时选错了源文件",
                "这个 exe 里没有内嵌界面。\n\n"
                "原因是打包时选了「keyapp_desktop.py」（开发源码，\n"
                "里面没有界面资源），应该选：\n\n"
                "    desktop\\钥匙-打包用.py\n\n"
                "先运行 打包电脑端.bat（或 py desktop\\embed_assets.py）\n"
                "生成这个文件，再用它打包。")
        except Exception:
            pass
        return

    port = find_free_port(DEFAULT_PORT)
    if port is None:
        err_box("端口都被占用了",
                "%d 到 %d 都被其他程序占用，服务起不来。\n\n"
                "常因：上一份钥匙还在跑（去任务管理器结束「钥匙.exe」），\n"
                "或其他软件占着这些端口。\n\n"
                "关掉占用后再双击一次。" % (DEFAULT_PORT, DEFAULT_PORT + 19))
        return
    srv = start_server(port, assets, www_dir)
    disc = Discovery(port)
    disc.start()

    url = "http://127.0.0.1:%d/" % port
    HUB.log("服务已启动 %s" % url)

    try:
        show_window(url)
    except KeyboardInterrupt:
        pass
    finally:
        disc.stop()
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    main()
