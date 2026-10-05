def slugify(text: str) -> str:
    cleaned = text.strip().lower()
    return cleaned.replace(" ", "-")
