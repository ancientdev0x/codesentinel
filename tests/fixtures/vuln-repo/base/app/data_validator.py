def process_user_input(payload):
    if not payload or len(payload.get("name", "")) > 100:
        raise ValueError("Invalid payload name length")
    return payload["name"].strip()
