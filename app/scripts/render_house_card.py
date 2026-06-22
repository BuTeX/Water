from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 820
PADDING = 34
GAP = 14
PANEL_RADIUS = 18

COLORS = {
    "bg": "#f6f8fb",
    "panel": "#ffffff",
    "text": "#0f172a",
    "muted": "#64748b",
    "line": "#d8e0ea",
    "ok": "#047857",
    "danger": "#b42318",
    "info": "#2563eb",
    "paid_bg": "#f2fbf5",
    "paid_border": "#9ad5af",
    "partial_bg": "#fffbeb",
    "partial_border": "#f7d77a",
    "unpaid_bg": "#fff5f3",
    "unpaid_border": "#efb0a8",
    "overpaid_bg": "#f2f7ff",
    "overpaid_border": "#a8c9ff",
    "disabled_bg": "#f8fafc",
    "disabled_border": "#cbd5e1",
}

STATUS_LABELS = {
    "paid": "оплачено",
    "partial": "частично",
    "unpaid": "долг",
    "not_applicable": "не участвует",
    "overpaid": "аванс",
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"]
    candidates = [
        Path("/usr/share/fonts/TTF"),
        Path("/usr/share/fonts/dejavu"),
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("C:/Windows/Fonts"),
    ]
    if bold:
        names.extend(["arialbd.ttf", "Arial Bold.ttf"])
    else:
        names.extend(["arial.ttf", "Arial.ttf"])

    for directory in candidates:
        for name in names:
            path = directory / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


FONTS = {
    "eyebrow": font(18, True),
    "title": font(42, True),
    "subtitle": font(19),
    "section": font(24, True),
    "label": font(17, True),
    "value": font(30, True),
    "small": font(16),
    "small_bold": font(16, True),
    "month_title": font(20, True),
    "payment": font(20, True),
}


def rub(value: object, plus: bool = False) -> str:
    amount = int(float(value or 0))
    text = f"{amount:,}".replace(",", " ")
    prefix = "+" if plus and amount else ""
    return f"{prefix}{text} руб."


def month(value: object) -> str:
    text = str(value or "")
    if len(text) == 7 and text[4] == "-":
        return f"{text[5:7]}.{text[:4]}"
    return text or "-"


def date(value: object) -> str:
    text = str(value or "")
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return f"{text[8:10]}.{text[5:7]}.{text[:4]}"
    return text or "-"


def text_size(draw: ImageDraw.ImageDraw, text: str, used_font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=used_font)
    return box[2] - box[0], box[3] - box[1]


def fit_text(draw: ImageDraw.ImageDraw, text: object, used_font: ImageFont.ImageFont, max_width: int) -> str:
    value = str(text or "")
    if text_size(draw, value, used_font)[0] <= max_width:
        return value

    suffix = "..."
    while value and text_size(draw, f"{value}{suffix}", used_font)[0] > max_width:
        value = value[:-1]
    return f"{value.rstrip()}{suffix}" if value else suffix


def status_style(status: object) -> tuple[str, str, str]:
    value = str(status or "")
    if value == "paid":
        return COLORS["paid_bg"], COLORS["paid_border"], COLORS["ok"]
    if value == "partial":
        return COLORS["partial_bg"], COLORS["partial_border"], "#a16207"
    if value == "overpaid":
        return COLORS["overpaid_bg"], COLORS["overpaid_border"], COLORS["info"]
    if value == "not_applicable":
        return COLORS["disabled_bg"], COLORS["disabled_border"], COLORS["muted"]
    return COLORS["unpaid_bg"], COLORS["unpaid_border"], COLORS["danger"]


def draw_stat(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    label: str,
    value: str,
    tone: str = "",
    detail: str = "",
) -> None:
    x1, y1, x2, y2 = xy
    accent = COLORS.get(tone, COLORS["text"]) if tone else COLORS["text"]
    draw.rounded_rectangle(xy, radius=16, fill=COLORS["panel"], outline=COLORS["line"], width=2)
    draw.text((x1 + 18, y1 + 15), label, font=FONTS["label"], fill=COLORS["muted"])
    draw.text((x1 + 18, y1 + 43), fit_text(draw, value, FONTS["value"], x2 - x1 - 36), font=FONTS["value"], fill=accent)
    if detail:
        draw.text((x1 + 18, y1 + 82), fit_text(draw, detail, FONTS["small"], x2 - x1 - 36), font=FONTS["small"], fill=COLORS["muted"])


def draw_panel(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], title: str) -> None:
    x1, y1, x2, y2 = xy
    draw.rounded_rectangle(xy, radius=PANEL_RADIUS, fill=COLORS["panel"], outline=COLORS["line"], width=2)
    draw.text((x1 + 20, y1 + 18), title, font=FONTS["section"], fill=COLORS["text"])


def draw_month(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], item: dict) -> None:
    x1, y1, x2, y2 = xy
    bg, border, accent = status_style(item.get("status"))
    label = STATUS_LABELS.get(str(item.get("status") or ""), str(item.get("status") or ""))
    draw.rounded_rectangle(xy, radius=14, fill=bg, outline=border, width=2)
    draw.text((x1 + 14, y1 + 12), month(item.get("month")), font=FONTS["month_title"], fill=COLORS["text"])
    draw.text(
        (x1 + 14, y1 + 40),
        fit_text(draw, f"{rub(item.get('paid'))} / {rub(item.get('charge'))}", FONTS["small"], x2 - x1 - 28),
        font=FONTS["small"],
        fill=COLORS["muted"],
    )
    draw.text((x1 + 14, y1 + 63), fit_text(draw, label, FONTS["small_bold"], x2 - x1 - 28), font=FONTS["small_bold"], fill=accent)


def draw_payment(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], payment: dict) -> None:
    x1, y1, x2, y2 = xy
    draw.rounded_rectangle(xy, radius=12, fill="#fbfdff", outline=COLORS["line"], width=2)
    amount = rub(payment.get("amount"))
    amount_width, _ = text_size(draw, amount, FONTS["payment"])
    draw.text((x1 + 16, y1 + 13), date(payment.get("paidAt")), font=FONTS["payment"], fill=COLORS["text"])
    draw.text((x2 - amount_width - 16, y1 + 13), amount, font=FONTS["payment"], fill=COLORS["text"])
    comment = str(payment.get("comment") or "")
    if comment:
        draw.text((x1 + 16, y1 + 43), fit_text(draw, comment, FONTS["small"], x2 - x1 - 32), font=FONTS["small"], fill=COLORS["muted"])


def render(data: dict) -> Image.Image:
    house = data.get("house") or {}
    months = data.get("months") or []
    payments = data.get("payments") or []
    balance = int(house.get("overpaid") or 0) - int(house.get("debt") or 0)

    content_width = WIDTH - PADDING * 2
    stat_width = (content_width - GAP) // 2
    month_width = (content_width - 40 - GAP) // 2
    month_rows = max(1, math.ceil(len(months) / 2))
    month_tile_height = 92
    months_panel_height = 70 + month_rows * month_tile_height + max(0, month_rows - 1) * GAP + 24
    payment_count = len(payments)
    payment_row_height = 66
    payments_panel_height = 70 + max(1, payment_count) * payment_row_height + max(0, payment_count - 1) * 10 + 24
    notice_height = 74 if data.get("paymentInstruction") else 0
    height = 140 + 112 + 24 + months_panel_height + 18 + payments_panel_height + notice_height + PADDING

    image = Image.new("RGBA", (WIDTH, height), COLORS["bg"])
    draw = ImageDraw.Draw(image)

    y = 30
    draw.text((PADDING, y), "СТРАНИЦА ДОМА", font=FONTS["eyebrow"], fill="#047857")
    y += 26
    title = str(house.get("displayName") or f"Дом {house.get('number') or ''}").strip()
    draw.text((PADDING, y), fit_text(draw, title, FONTS["title"], content_width), font=FONTS["title"], fill=COLORS["text"])
    y += 56
    subtitle = f"начало пользования {house.get('startsOn') or '-'} · расчет на {data.get('asOfMonth') or '-'}"
    draw.text((PADDING, y), fit_text(draw, subtitle, FONTS["subtitle"], content_width), font=FONTS["subtitle"], fill=COLORS["muted"])
    y += 42

    balance_text = f"+{rub(balance)}" if balance >= 0 else f"-{rub(abs(balance))}"
    draw_stat(
        draw,
        (PADDING, y, PADDING + stat_width, y + 112),
        "Баланс дома",
        balance_text,
        "ok" if balance >= 0 else "danger",
    )
    draw_stat(
        draw,
        (PADDING + stat_width + GAP, y, WIDTH - PADDING, y + 112),
        "Долг / аванс",
        f"{rub(house.get('debt'))} / {rub(house.get('overpaid'))}",
    )
    y += 112 + 24

    draw_panel(draw, (PADDING, y, WIDTH - PADDING, y + months_panel_height), "Месяцы")
    month_y = y + 70
    for index, item in enumerate(months):
        col = index % 2
        row = index // 2
        x = PADDING + 20 + col * (month_width + GAP)
        yy = month_y + row * (month_tile_height + GAP)
        draw_month(draw, (x, yy, x + month_width, yy + month_tile_height), item)
    if not months:
        draw.text((PADDING + 20, month_y), "Месяцы появятся после расчета.", font=FONTS["small"], fill=COLORS["muted"])
    y += months_panel_height + 18

    draw_panel(draw, (PADDING, y, WIDTH - PADDING, y + payments_panel_height), "Платежи")
    payment_y = y + 70
    if payments:
        for index, payment in enumerate(payments):
            yy = payment_y + index * (payment_row_height + 10)
            draw_payment(draw, (PADDING + 20, yy, WIDTH - PADDING - 20, yy + payment_row_height), payment)
    else:
        draw.text((PADDING + 20, payment_y), "Платежей пока нет.", font=FONTS["small"], fill=COLORS["muted"])
    y += payments_panel_height

    instruction = str(data.get("paymentInstruction") or "")
    if instruction:
        y += 16
        draw.rounded_rectangle((PADDING, y, WIDTH - PADDING, y + 58), radius=14, fill="#eef6ff", outline="#bfdbfe", width=2)
        draw.text((PADDING + 18, y + 15), fit_text(draw, instruction, FONTS["small"], content_width - 36), font=FONTS["small"], fill=COLORS["muted"])

    return image.convert("RGB")


def main() -> None:
    data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    image = render(data)
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    sys.stdout.buffer.write(output.getvalue())


if __name__ == "__main__":
    main()
