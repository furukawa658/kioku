"""Render docs/demo.gif: save a lesson in chat 1, reuse it in a new chat 2.

The animation is a scripted illustration of the kioku MCP tool calls, not a screen recording.
Run: python scripts/make-demo-gif.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 540
BG, PANEL, USER, AGENT = "#1e1e1e", "#252526", "#2d3a4f", "#2a2a2a"
TXT, DIM, GREEN, RED, BLUE, AMBER = "#e6e6e6", "#9da0a6", "#4ec9b0", "#f48771", "#569cd6", "#e5c07b"
SANS = "C:/Windows/Fonts/segoeui.ttf"
SANS_B = "C:/Windows/Fonts/segoeuib.ttf"
MONO = "C:/Windows/Fonts/consola.ttf"
f = lambda p, s: ImageFont.truetype(p, s)
F_TXT, F_B, F_MONO, F_S, F_T = f(SANS, 20), f(SANS_B, 20), f(MONO, 17), f(SANS, 16), f(SANS_B, 26)

OUT = Path(__file__).resolve().parent.parent / "docs" / "demo.gif"


def base(title, chat):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 64], fill=PANEL)
    d.text((28, 16), "kioku", font=F_T, fill=GREEN)
    d.text((120, 22), title, font=F_TXT, fill=DIM)
    d.rounded_rectangle([W - 190, 16, W - 24, 48], 16, outline=DIM)
    d.text((W - 176, 21), chat, font=F_S, fill=TXT)
    return im, d


def bubble(d, y, who, lines, fill, h=None, mono=False):
    h = h or 42 + 28 * len(lines)
    d.rounded_rectangle([28, y, W - 28, y + h], 10, fill=fill)
    d.text((44, y + 8), who, font=F_S, fill=DIM)
    yy = y + 34
    for text, color in lines:
        d.text((44, yy), text, font=F_MONO if mono else F_TXT, fill=color)
        yy += 28
    return y + h + 14


def frame(title, chat, blocks, caption):
    im, d = base(title, chat)
    y = 82
    for kind, lines in blocks:
        if kind == "user":
            y = bubble(d, y, "You", lines, USER)
        elif kind == "tool":
            y = bubble(d, y, "Copilot  ->  kioku", lines, AGENT, mono=True)
        else:
            y = bubble(d, y, "Copilot", lines, AGENT)
    d.rectangle([0, H - 56, W, H], fill=PANEL)
    d.text((28, H - 42), caption, font=F_B, fill=AMBER)
    return im


c1_user = ("user", [("The VSIX bundled devDependencies again. Fix it and remember why.", TXT)])
c1_tool = ("tool", [
    ("save_memory", BLUE),
    ('  outcome: "failure"', TXT),
    ('  cause:   "vsce package ran without --no-dependencies"', TXT),
    ('  lesson:  "Always pass --no-dependencies to vsce package."', GREEN),
])
c1_done = ("agent", [("Fixed. Lesson saved, so the next chat will know.", TXT)])

c2_user = ("user", [("Package the extension.", TXT)])
c2_tool = ("tool", [
    ("search", BLUE),
    ('  query: "package VSIX"   concepts: "lesson"', TXT),
    ("  -> failure: vsce package ran without --no-dependencies", RED),
    ("     lesson: Always pass --no-dependencies to vsce package.", GREEN),
])
c2_done = ("agent", [
    ("Past lesson found. Running:", TXT),
    ("vsce package --no-dependencies", GREEN),
])

steps = [
    (frame("Chat 1 - something goes wrong", "Chat 1", [c1_user], "A mistake happens"), 1800),
    (frame("Chat 1 - something goes wrong", "Chat 1", [c1_user, c1_tool], "The agent saves outcome, cause and lesson"), 3200),
    (frame("Chat 1 - something goes wrong", "Chat 1", [c1_user, c1_tool, c1_done], "Saved on your PC. Nothing leaves it."), 2200),
    (frame("A week later - brand new chat", "New chat", [c2_user], "A new chat knows nothing yet"), 1800),
    (frame("A week later - brand new chat", "New chat", [c2_user, c2_tool], "The agent searches past lessons first"), 3400),
    (frame("A week later - brand new chat", "New chat", [c2_user, c2_tool, c2_done], "Same task. This time it gets it right."), 3600),
]

OUT.parent.mkdir(parents=True, exist_ok=True)
frames = [s[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT) for s in steps]
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=[s[1] for s in steps], loop=0, optimize=True)
print(OUT, OUT.stat().st_size // 1024, "KB")
