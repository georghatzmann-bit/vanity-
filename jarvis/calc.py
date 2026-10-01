"""Rechnen ohne Claude: "Was ist 15 mal 23?", "20 Prozent von 80", "Wurzel aus 144".

Nur reine Rechenaufgaben: Bleibt nach dem Übersetzen der Wörter etwas anderes als Zahlen
und Rechenzeichen übrig ("Was ist ein Quasar?"), ist es keine, und Claude antwortet.
"""

from __future__ import annotations

import ast
import math
import operator
import re

_NUMBER_WORDS = {
    "null": 0, "eins": 1, "ein": 1, "eine": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "sechs": 6,
    "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "elf": 11, "zwölf": 12, "zwanzig": 20, "dreißig": 30,
    "vierzig": 40, "fünfzig": 50, "sechzig": 60, "siebzig": 70, "achtzig": 80, "neunzig": 90,
    "hundert": 100, "tausend": 1000, "halb": 0.5,
}
_WORDS = [
    (r"\b(?:geteilt|dividiert) durch\b|\bdurch\b|÷", " / "),
    (r"\bmultipliziert mit\b|\bmal\b|×|(?<=\d)\s*x\s*(?=\d)", " * "),
    (r"\bplus\b|\baddiert mit\b", " + "),
    (r"\bminus\b|\bweniger\b|−", " - "),
    (r"\bhoch\b", " ** "),
    (r"\b(?:zum|im) quadrat\b", " ** 2 "),
    (r"\bklammer auf\b", " ( "),
    (r"\bklammer zu\b", " ) "),
]
_ALLOWED = re.compile(r"^[\d\s.+\-*/()√%]+$")
_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.Pow: operator.pow, ast.Mod: operator.mod,
}


class CalcError(ValueError):
    """Keine Rechenaufgabe, oder eine, die nicht geht (z. B. durch null)."""


def _numbers(text: str) -> str:
    # 1.000 ist Tausend, 3,5 ist drei Komma fünf
    text = re.sub(r"(?<=\d)\.(?=\d{3}\b)", "", text)
    text = re.sub(r"(?<=\d),(?=\d)", ".", text)
    text = re.sub(r"\bkomma\b", ".", text)
    for word, value in sorted(_NUMBER_WORDS.items(), key=lambda kv: -len(kv[0])):
        text = re.sub(rf"\b{word}\b", f" {value} ", text)
    return re.sub(r"(?<=\d)\s+\.\s+(?=\d)", ".", text)


def translate(text: str) -> str:
    """Gesprochene Rechnung -> Python-Ausdruck aus Zahlen und Rechenzeichen."""
    expr = " " + str(text).lower().strip(" ?!.=") + " "
    expr = re.sub(r"[?!=]", " ", expr)
    expr = _numbers(expr)
    # "20 Prozent von 80" -> (20/100*80), "20 %" -> (20/100)
    expr = re.sub(r"([\d.]+)\s*(?:prozent|%)\s*(?:von|aus)\s*([\d.]+)", r" (\1/100*\2) ", expr)
    expr = re.sub(r"([\d.]+)\s*(?:prozent|%)", r" (\1/100) ", expr)
    # "Wurzel aus 144", "Quadratwurzel von 2"
    expr = re.sub(r"\b(?:die )?(?:quadrat)?wurzel (?:aus|von) ([\d.]+)", r" √\1 ", expr)
    for pattern, symbol in _WORDS:
        expr = re.sub(pattern, symbol, expr)
    expr = re.sub(r"\s+", " ", expr).strip()
    if not expr or not _ALLOWED.match(expr):
        raise CalcError("keine Rechenaufgabe")
    if not re.search(r"\d", expr) or not (re.search(r"[+\-*/%]", expr) or "√" in expr):
        raise CalcError("keine Rechnung")
    return expr.replace("√", "sqrt ").replace("%", "/100")


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _eval(node.operand)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 100 or abs(left) > 1e6):
            raise CalcError("zu groß")
        return _OPS[type(node.op)](left, right)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "sqrt" and len(node.args) == 1:
        value = _eval(node.args[0])
        if value < 0:
            raise CalcError("Wurzel aus einer negativen Zahl")
        return math.sqrt(value)
    raise CalcError("keine Rechenaufgabe")


def evaluate(text: str) -> float:
    expr = translate(text)
    # "sqrt 144" -> "sqrt(144)"
    expr = re.sub(r"sqrt ([\d.]+)", r"sqrt(\1)", expr)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise CalcError("keine Rechenaufgabe") from exc
    try:
        result = _eval(tree)
    except ZeroDivisionError as exc:
        raise CalcError("durch null") from exc
    if isinstance(result, complex) or not math.isfinite(result) or abs(result) > 1e15:
        raise CalcError("zu groß")
    return result


def spoken(value: float) -> str:
    """345 -> "345", 14.285714 -> "ungefähr 14,2857", 1234567 -> "1.234.567", -5 -> "minus 5"."""
    if value < 0:
        return "minus " + spoken(-value).replace("ungefähr ", "") if abs(value - round(value, 4)) < 1e-12 \
            else "ungefähr minus " + spoken(-value).replace("ungefähr ", "")
    if abs(value - round(value)) < 1e-9:
        number = int(round(value))
        return f"{number:,}".replace(",", ".") if abs(number) >= 10000 else str(number)
    rounded = round(value, 4)
    text = f"{rounded:.4f}".rstrip("0").rstrip(".").replace(".", ",")
    return text if abs(rounded - value) < 1e-12 else f"ungefähr {text}"
