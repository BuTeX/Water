from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1080
PADDING = 42
ROAD_WIDTH = 86
HOUSE_WIDTH = 270
HOUSE_HEIGHT = 62
ROW_HEIGHT = 82

COLORS = {
    "bg": "#f6f8fb",
    "panel": "#ffffff",
    "text": "#0f172a",
    "muted": "#64748b",
    "line": "#d8e0ea",
    "road": "#d1c4ae",
    "road_side": "#b8aa96",
    "paid_bg": "#f2fbf5",
    "paid_border": "#9ad5af",
    "paid_text": "#167346",
    "debt_bg": "#fff5f3",
    "debt_border": "#efb0a8",
    "debt_text": "#b42318",
    "overpaid_bg": "#f2f7ff",
    "overpaid_border": "#a8c9ff",
    "overpaid_text": "#2563eb",
    "empty_bg": "#f8fafc",
    "empty_border": "#cbd5e1",
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
    "title": font(44, True),
    "subtitle": font(22, False),
    "card_label": font(21, True),
    "card_value": font(30, True),
    "small": font(18, True),
    "house_no": font(18, True),
    "house_value": font(24, True),
    "house_status": font(16, True),
    "street": font(23, True),
}


def rub(value: object, plus: bool = False) -> str:
    amount = int(float(value or 0))
    text = f"{amount:,}".replace(",", " ")
    return f"{'+' if plus and amount else ''}{text} руб."


def month(value: object) -> str:
    text = str(value or "")
    if len(text) == 7 and text[4] == "-":
        return f"{text[5:7]}.{text[:4]}"
    return text or "-"


def pct(value: float, total: float) -> int:
    if not total:
        return 0
    return max(0, min(100, round(value / total * 100)))


def text_size(draw: ImageDraw.ImageDraw, text: str, used_font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=used_font)
    return box[2] - box[0], box[3] - box[1]


def draw_centered(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    text: str,
    used_font: ImageFont.ImageFont,
    fill: str,
) -> None:
    x1, y1, x2, y2 = xy
    width, height = text_size(draw, text, used_font)
    draw.text((x1 + (x2 - x1 - width) / 2, y1 + (y2 - y1 - height) / 2 - 2), text, font=used_font, fill=fill)


def draw_card(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    label: str,
    value: str,
    accent: str,
    detail: str = "",
) -> None:
    x1, y1, x2, y2 = xy
    draw.rounded_rectangle(xy, radius=18, fill=COLORS["panel"], outline=COLORS["line"], width=2)
    draw.rounded_rectangle((x1 + 18, y1 + 18, x1 + 28, y2 - 18), radius=4, fill=accent)
    draw.text((x1 + 44, y1 + 18), label, font=FONTS["card_label"], fill=COLORS["muted"])
    draw.text((x1 + 44, y1 + 45), value, font=FONTS["card_value"], fill=accent)
    if detail:
        draw.text((x1 + 44, y1 + 83), detail, font=FONTS["small"], fill=COLORS["muted"])


def house_tone(house: dict | None) -> str:
    if not house:
        return "empty"
    if int(house.get("debt") or 0) > 0:
        return "debt"
    if int(house.get("overpaid") or 0) > 0:
        return "overpaid"
    return "paid"


def house_value(house: dict | None) -> tuple[str, str, str]:
    if not house:
        return "нет данных", "участок", COLORS["muted"]
    debt = int(house.get("debt") or 0)
    overpaid = int(house.get("overpaid") or 0)
    if debt > 0:
        return rub(debt), "к оплате", COLORS["debt_text"]
    if overpaid > 0:
        return rub(overpaid, plus=True), "аванс", COLORS["overpaid_text"]
    return "оплачено", "статус", COLORS["paid_text"]


def house_visual_range(house: dict) -> dict:
    number = int(house.get("number"))
    single_plot = {"bottom": number, "top": number, "span": 1, "label": str(number)}
    display_name = str(house.get("displayName") or "")
    for match in re.finditer(r"(?:^|\D)(\d{1,3})\s*[-–—]\s*(\d{1,3})(?=\D|$)", display_name):
        first = int(match.group(1))
        second = int(match.group(2))
        if first != number and second != number:
            continue
        if first % 2 != second % 2:
            continue

        bottom = min(first, second)
        top = max(first, second)
        distance = top - bottom
        if distance < 2 or distance > 12:
            continue

        return {
            "bottom": bottom,
            "top": top,
            "span": distance // 2 + 1,
            "label": f"{bottom}-{top}",
        }
    return single_plot


def draw_house(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    house: dict | None,
    expected_number: int | None,
    span: int = 1,
    label: str | None = None,
    covered: bool = False,
) -> None:
    if expected_number is None or covered:
        return

    tone = house_tone(house)
    bg = COLORS[f"{tone}_bg"] if tone != "empty" else COLORS["empty_bg"]
    border = COLORS[f"{tone}_border"] if tone != "empty" else COLORS["empty_border"]
    text_value, status, value_color = house_value(house)
    tile_height = HOUSE_HEIGHT + ROW_HEIGHT * (max(1, span) - 1)
    content_y = y + max(0, (tile_height - HOUSE_HEIGHT) // 2)
    house_label = label or str(house.get("number") if house else expected_number)

    xy = (x, y, x + HOUSE_WIDTH, y + tile_height)
    draw.rounded_rectangle(xy, radius=14, fill=bg, outline=border, width=2)
    draw.text((x + 18, content_y + 9), f"№ {house_label}", font=FONTS["house_no"], fill=COLORS["muted"])
    draw.text((x + 18, content_y + 31), text_value, font=FONTS["house_value"], fill=value_color)
    status_width, _ = text_size(draw, status.upper(), FONTS["house_status"])
    draw.text((x + HOUSE_WIDTH - status_width - 18, content_y + 36), status.upper(), font=FONTS["house_status"], fill=COLORS["muted"])


def draw_street_name(image: Image.Image, center_x: int, center_y: int) -> None:
    label = "УЛ. УЮТНАЯ"
    temp = Image.new("RGBA", (220, 52), (255, 255, 255, 0))
    temp_draw = ImageDraw.Draw(temp)
    temp_draw.rounded_rectangle((0, 0, 220, 52), radius=26, fill="#ffffff", outline=COLORS["line"], width=2)
    draw_centered(temp_draw, (0, 0, 220, 52), label, FONTS["street"], COLORS["text"])
    rotated = temp.rotate(90, expand=True)
    image.alpha_composite(rotated, (center_x - rotated.width // 2, center_y - rotated.height // 2))


def build_rows(houses: list[dict]) -> list[dict]:
    if not houses:
        return []
    ranges_by_number = {}
    houses_by_plot = {}
    covered_plots = set()
    numbers = []

    for house in houses:
        number = int(house.get("number"))
        visual_range = house_visual_range(house)
        ranges_by_number[number] = visual_range
        houses_by_plot[visual_range["top"]] = house
        numbers.extend([visual_range["bottom"], visual_range["top"]])
        for plot in range(visual_range["top"] - 2, visual_range["bottom"] - 1, -2):
            covered_plots.add(plot)

    numbers = sorted(numbers)
    min_number = min(numbers)
    max_number = max(numbers)
    min_even = min_number if min_number % 2 == 0 else min_number + 1
    max_even = max_number if max_number % 2 == 0 else max_number + 1

    def plot(expected_number: int | None) -> dict:
        if expected_number is None:
            return {"house": None, "expected_number": None, "span": 1, "label": None, "covered": False}
        if expected_number in covered_plots:
            return {"house": None, "expected_number": expected_number, "span": 1, "label": None, "covered": True}

        house = houses_by_plot.get(expected_number)
        if not house:
            return {"house": None, "expected_number": expected_number, "span": 1, "label": None, "covered": False}

        visual_range = ranges_by_number.get(int(house.get("number")), house_visual_range(house))
        return {
            "house": house,
            "expected_number": expected_number,
            "span": visual_range["span"],
            "label": visual_range["label"],
            "covered": False,
        }

    rows = []
    for even in range(max_even, min_even - 1, -2):
        rows.append(
            {
                "even": plot(even if even <= max_number else None),
                "odd": plot(even - 1 if even - 1 >= min_number else None),
            }
        )
    return rows


def render(data: dict) -> Image.Image:
    houses = data.get("houses") or []
    totals = data.get("totals") or {}
    rows = build_rows(houses)
    paid = sum(int(house.get("paid") or 0) for house in houses)
    due = sum(int(house.get("due") or 0) for house in houses)
    debtors = [house for house in houses if int(house.get("debt") or 0) > 0]
    overpaid = [house for house in houses if int(house.get("overpaid") or 0) > 0]
    settled = len(houses) - len(debtors) - len(overpaid)

    street_top = 430
    street_height = max(ROW_HEIGHT * max(len(rows), 1) + 60, 360)
    height = street_top + street_height + 82

    image = Image.new("RGBA", (WIDTH, height), COLORS["bg"])
    draw = ImageDraw.Draw(image)

    draw.text((PADDING, 38), "Карта улицы", font=FONTS["title"], fill=COLORS["text"])
    draw.text((PADDING, 92), f"Сводка на {month(data.get('asOfMonth'))}", font=FONTS["subtitle"], fill=COLORS["muted"])
    draw.text((WIDTH - PADDING - 300, 48), "водоснабжение", font=FONTS["subtitle"], fill=COLORS["muted"])

    card_gap = 18
    card_width = (WIDTH - PADDING * 2 - card_gap) // 2
    draw_card(
        draw,
        (PADDING, 146, PADDING + card_width, 258),
        "Баланс кассы",
        rub(totals.get("balance")),
        COLORS["paid_text"] if int(totals.get("balance") or 0) >= 0 else COLORS["debt_text"],
        f"домов: {totals.get('houses') or len(houses)}",
    )
    draw_card(
        draw,
        (PADDING + card_width + card_gap, 146, WIDTH - PADDING, 258),
        "Собираемость",
        f"{pct(paid, due)}%",
        "#334155",
    )
    draw_card(
        draw,
        (PADDING, 276, PADDING + card_width, 388),
        "Долг",
        rub(totals.get("debt")),
        COLORS["debt_text"] if int(totals.get("debt") or 0) else COLORS["paid_text"],
        f"{len(debtors)} домов",
    )
    draw_card(
        draw,
        (PADDING + card_width + card_gap, 276, WIDTH - PADDING, 388),
        "Аванс",
        rub(totals.get("overpaid")),
        COLORS["overpaid_text"],
        f"{len(overpaid)} домов, оплачено {settled}",
    )

    legend_y = street_top - 2
    legend_items = [
        (COLORS["paid_text"], "оплачено"),
        (COLORS["debt_text"], "долг"),
        (COLORS["overpaid_text"], "аванс"),
    ]
    x = PADDING
    for color, label in legend_items:
        draw.ellipse((x, legend_y, x + 16, legend_y + 16), fill=color)
        draw.text((x + 24, legend_y - 4), label, font=FONTS["small"], fill=COLORS["muted"])
        x += 138

    road_x1 = WIDTH // 2 - ROAD_WIDTH // 2
    road_x2 = WIDTH // 2 + ROAD_WIDTH // 2
    road_y1 = street_top + 32
    road_y2 = street_top + street_height - 24
    draw.rounded_rectangle((road_x1, road_y1, road_x2, road_y2), radius=18, fill=COLORS["road"], outline="#ad9c83", width=2)
    draw.rectangle((road_x1, road_y1, road_x1 + 18, road_y2), fill=COLORS["road_side"])
    draw.rectangle((road_x2 - 18, road_y1, road_x2, road_y2), fill=COLORS["road_side"])
    for dash_y in range(road_y1 + 20, road_y2 - 20, 54):
        draw.rounded_rectangle((WIDTH // 2 - 4, dash_y, WIDTH // 2 + 4, dash_y + 30), radius=4, fill="#f8fafc")

    left_x = road_x1 - 26 - HOUSE_WIDTH
    right_x = road_x2 + 26
    y = street_top + 42
    for row in rows:
        draw_house(draw, left_x, y, **row["even"])
        draw_house(draw, right_x, y, **row["odd"])
        y += ROW_HEIGHT

    draw_street_name(image, WIDTH // 2, street_top + street_height // 2)
    draw.text((PADDING, height - 44), "Обновляется по текущим данным базы", font=FONTS["small"], fill=COLORS["muted"])
    return image.convert("RGB")


def main() -> None:
    data = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    image = render(data)
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    sys.stdout.buffer.write(output.getvalue())


if __name__ == "__main__":
    main()
