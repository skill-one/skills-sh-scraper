"""
Show exactly where the 7,500-byte truncation lands on the current local SKILL.md.
Prints what's kept, what's lost, and counts 'news' tokens in each.
"""
import re

MAX_BYTES = 7_500


def truncate_utf8_bytes(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    end = max_bytes
    while end > 0 and (encoded[end] & 0xC0) == 0x80:
        end -= 1
    return encoded[:end].decode("utf-8", errors="ignore")


def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not m:
        return {}, text
    fields = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    return fields, text[m.end():]


with open("e:/Code/Headline_Scraper/Frontend/TheHear/the-news-skill/SKILL.md",
          encoding="utf-8") as f:
    raw = f.read()
fm, body = parse_frontmatter(raw)
header = "\n".join([fm.get("name", ""), fm.get("description", "")])
emb_input = header + "\n\n" + body
kept = truncate_utf8_bytes(emb_input, MAX_BYTES)
lost = emb_input[len(kept):]

print(f"Total input: {len(emb_input):>6} chars / {len(emb_input.encode('utf-8')):>6} bytes")
print(f"Kept:        {len(kept):>6} chars / {len(kept.encode('utf-8')):>6} bytes")
print(f"Lost:        {len(lost):>6} chars / {len(lost.encode('utf-8')):>6} bytes")

# Locate every section header in the body and mark which side of the cut it falls on.
sections = []
for m in re.finditer(r"^## (.+)$", emb_input, re.MULTILINE):
    sections.append((m.start(), m.group(1)))

print(f"\nSection map (byte offset of '## Heading' in embedding input):")
print(f"{'byte':>6}  {'side':<5}  section")
print("-" * 60)
cut_byte = len(kept.encode("utf-8"))
for byte_offset, name in sections:
    # Convert char offset to byte offset
    b_offset = len(emb_input[:byte_offset].encode("utf-8"))
    side = "KEPT" if b_offset < cut_byte else "LOST"
    bar = "|" if b_offset < cut_byte else " "
    print(f"{b_offset:>6}  {side:<5}  {bar} {name}")
print(f"\n  CUT at byte {cut_byte}")

# Count occurrences of key terms in kept vs lost
print("\nKey-term frequency:")
print(f"{'term':<20}{'KEPT':>10}{'LOST':>10}")
print("-" * 42)
for term in ["news", "News", "headline", "headlines", "noticias",
             "Nachrichten", "新闻", "global", "country", "real-time",
             "breaking", "front-page", "international"]:
    in_kept = kept.lower().count(term.lower())
    in_lost = lost.lower().count(term.lower())
    print(f"{term:<20}{in_kept:>10}{in_lost:>10}")

print("\n--- LAST 250 CHARS OF KEPT (where the cut happens) ---")
print(kept[-250:])
print("\n--- FIRST 250 CHARS LOST ---")
print(lost[:250])
