#!/usr/bin/env python3
"""Find deterministic AI-writing signals in Chinese and English Markdown prose."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Pattern


FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
ATX_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+")
LIST_RE = re.compile(r"^\s{0,3}(?:[-+*]|\d+[.)、])\s+")
BLOCKQUOTE_RE = re.compile(r"^\s{0,3}>")
TABLE_SEPARATOR_RE = re.compile(
    r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$"
)
IMAGE_RE = re.compile(r"!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
INLINE_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]*)\)")
HTML_TAG_RE = re.compile(r"<[^>]+>")
VISUAL_TODO_START_RE = re.compile(r"^\s*<!--\s*VISUAL_TODO\b")
VISUAL_TODO_END_RE = re.compile(r"^\s*<!--\s*/VISUAL_TODO\s*-->\s*$")
HTML_COMMENT_START_RE = re.compile(r"^\s*<!--")
HTML_COMMENT_END_RE = re.compile(r"-->\s*$")
SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3}
HARD_CONSTRAINT_RULE_IDS = {
    "zh-binary-contrast",
    "zh-exclamation",
    "zh-dash",
    "en-binary-contrast",
    "en-exclamation",
    "en-dash",
}


@dataclass(frozen=True)
class Rule:
    rule_id: str
    language: str
    category: str
    severity: str
    pattern: Pattern[str]
    message: str
    suggestion: str
    allowed_kinds: tuple[str, ...] = ("prose", "heading", "list")


@dataclass(frozen=True)
class Segment:
    kind: str
    text: str
    start_line: int
    end_line: int


def compile_rule(
    rule_id: str,
    language: str,
    category: str,
    severity: str,
    pattern: str,
    message: str,
    suggestion: str,
    *,
    flags: int = 0,
    allowed_kinds: tuple[str, ...] = ("prose", "heading", "list"),
) -> Rule:
    return Rule(
        rule_id=rule_id,
        language=language,
        category=category,
        severity=severity,
        pattern=re.compile(pattern, flags),
        message=message,
        suggestion=suggestion,
        allowed_kinds=allowed_kinds,
    )


RULES = [
    compile_rule(
        "zh-binary-contrast",
        "zh",
        "formulaic_contrast",
        "high",
        r"(?:(?:不是|并非|不只是|不仅仅?|不止|绝非|与其|而非|拒绝|舍弃)[^。！？\n]{0,45}?(?:而是|而且|更是|还要|也要|专注|选择|追求|而不是|不如)|(?:看似|看起来|表面上?)[^。！？\n]{0,45}?(?:其实|实则|实际上))",
        "发现高频的否定 A、肯定 B 句式。",
        "直接陈述真正想表达的正面判断，避免先制造一个稻草人。",
    ),
    compile_rule(
        "zh-core-claim",
        "zh",
        "generic_importance",
        "medium",
        r"核心(?:是|在于|思想|逻辑|优势|问题|价值|能力|竞争力|原因)",
        "发现“核心是/核心优势”等模板化重要性表达。",
        "改写为具体机制、结果或因果关系。",
    ),
    compile_rule(
        "zh-empty-evaluative",
        "zh",
        "generic_importance",
        "medium",
        r"(?:很|非常|十分|相当)(?:直接|清晰|清楚|重要|简单|关键)",
        "发现无信息评价词。",
        "删掉空形容词；句子站不住时补机制、数字或例子，不要换一个同义形容词。",
    ),
    compile_rule(
        "zh-superlative-pivot",
        "zh",
        "dramatic_transition",
        "medium",
        r"(?:更|最)(?:重要|关键|有意思|值得注意|要命|糟糕|厉害|令人担忧|讽刺|微妙|可怕|难得)[^。！？\n]{0,6}(?:的)?是",
        "发现“更/最……的是”式戏剧化转折。",
        "删掉排名式前缀，直接写事实或判断。",
    ),
    compile_rule(
        "zh-meta-transition",
        "zh",
        "meta_transition",
        "high",
        r"(?:值得注意的是|需要指出的是|需要强调的是|不可否认|毋庸置疑|众所周知|显而易见|毫无疑问|必须承认|总的来说|总体而言|综上所述|归根结底|从某种意义上说|换句话说|也就是说|简单来说|简而言之|说白了|不难理解|你可能(?:会)?(?:觉得|认为|想|发现)|你也许(?:会)?(?:觉得|认为|想)|你会发现|很多人会问|不少人会问|别担心|先别急|读者也许会)",
        "发现宣布写作动作、预判读者或泛化结论的过渡语。",
        "删除套话，让句子直接进入事实、动作或判断。",
    ),
    compile_rule(
        "zh-ordered-transition",
        "zh",
        "over_structured",
        "medium",
        r"(?:(?:^|[。！？]\s*)(?:首先|其次|再次|最后)(?=[，,:：\s]|要|是|需要|可以|我们)|(?:第一|第二|第三)[，,:：])",
        "发现过于规整的顺序连接词。",
        "只保留真正需要顺序的步骤；叙事文章改为自然衔接。",
    ),
    compile_rule(
        "zh-marketing-abstraction",
        "zh",
        "marketing_language",
        "medium",
        r"(?:赋能|助力|全面提升|极大地提升|重塑[^。！？\n]{0,12}格局|开启[^。！？\n]{0,12}新篇章|注入[^。！？\n]{0,12}动力|打造[^。！？\n]{0,12}新范式|实现[^。！？\n]{0,12}闭环)",
        "发现营销化、抽象化的动词或口号。",
        "换成具体主体、动作和可观察结果。",
    ),
    compile_rule(
        "zh-assistant-residue",
        "zh",
        "assistant_residue",
        "high",
        r"(?:作为(?:一个)?AI|希望(?:以上|这些)[^。！？\n]{0,12}(?:帮助|有用)|如果你(?:愿意|需要)|欢迎(?:随时)?告诉我|让我知道|下面我将|本文将)",
        "发现助手回复或写作模板残留。",
        "删除面向提问者的助手话术，保留文章正文。",
    ),
    compile_rule(
        "zh-metaphor-marker",
        "zh",
        "metaphor",
        "low",
        r"(?:钥匙|引擎|桥梁|基石|灯塔|催化剂|双刃剑|冰山一角|拼图|舞台|浪潮|拐点|分水岭)",
        "发现常见概念比喻。单次使用未必有问题，重复出现时容易显得浮夸。",
        "结合全文判断是否保留；优先换成具体关系。",
    ),
    compile_rule(
        "zh-inference-cliche",
        "zh",
        "formulaic_inference",
        "low",
        r"(?:这(?:也)?意味着|这说明|由此可见|不难发现|可以看出)",
        "发现常见的推论提示语。",
        "如果上下文已经表达因果，删掉提示语或改成具体结论。",
    ),
    compile_rule(
        "zh-exclamation",
        "zh",
        "punctuation",
        "high",
        r"[！!]",
        "发现感叹号。",
        "删除感叹号，按语义改成句号、逗号或直接拆句。",
    ),
    compile_rule(
        "zh-double-quote",
        "zh",
        "punctuation",
        "low",
        r"[\"“”]",
        "发现正文双引号。密集使用可能形成模型腔。",
        "确认是否为必要引语；能自然转述时减少引号。",
    ),
    compile_rule(
        "zh-dash",
        "zh",
        "punctuation",
        "high",
        r"(?:—{1,2}|–|--)",
        "发现破折号或双连字符。",
        "删除破折号，按语义改成句号、逗号、冒号、括号或直接拆句。",
    ),
    compile_rule(
        "zh-rhetorical-heading",
        "zh",
        "heading",
        "medium",
        r"(?:[？?]\s*$|^\s*#{1,6}\s*(?:为什么|为何|难道|谁说|怎么会|究竟))",
        "发现反问式小标题。",
        "改成安静、具体、能描述本节内容的标题。",
        allowed_kinds=("heading",),
    ),
    compile_rule(
        "en-binary-contrast",
        "en",
        "formulaic_contrast",
        "high",
        r"\b(?:not only|not just|not merely|isn't just|doesn't just|more than just|rather than|instead of|not\b[^.!?\n]{0,80}\bbut|not\b[^.!?\n]{0,80}\balso)\b",
        "Detected a formulaic binary contrast.",
        "State the positive claim directly unless the contrast carries real information.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-ai-opener",
        "en",
        "meta_transition",
        "high",
        r"\b(?:in today's|ever-evolving|rapidly evolving|in the realm of|in the world of|delve into|dive into|unlock|harness|leverage|it is important to note|it is worth noting|this article (?:explores|examines|will)|this guide (?:explores|examines|will)|below is|here is|let's explore|let us explore)\b",
        "Detected a common AI-style opener or meta transition.",
        "Delete the announcement and start with the concrete subject, action, or result.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-prestige-filler",
        "en",
        "generic_importance",
        "low",
        r"\b(?:significant|crucial|pivotal|vital|robust|seamless|transformative|game-changing|cutting-edge|innovative|comprehensive|dynamic|nuanced|thoughtful|tapestry|landscape|journey|testament|underscores|highlights|plays a key role|plays a crucial role)\b",
        "Detected generic prestige or importance language.",
        "Keep it only when the sentence proves the claim; otherwise use a concrete detail.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-inflated-verb",
        "en",
        "inflated_verb",
        "medium",
        r"\b(?:serves as|stands as|acts as|represents a|marks a|boasts|features|offers a|holds the distinction|is designed to|is aimed at|refers to)\b",
        "Detected an inflated verb or copula-avoidance pattern.",
        "Use is, has, includes, or the actual action when the inflated verb adds no meaning.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-canned-closer",
        "en",
        "canned_closer",
        "high",
        r"\b(?:in conclusion|to sum up|ultimately|moving forward|the future of)\b",
        "Detected a canned conclusion transition.",
        "End on the article's specific consequence or judgment instead of announcing the conclusion.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-assistant-residue",
        "en",
        "assistant_residue",
        "high",
        r"\b(?:i hope this helps|let me know|would you like|as an ai|knowledge cutoff|based on available information|available sources|provided sources)\b",
        "Detected assistant or source-handling residue.",
        "Remove conversational assistant text and keep only article prose.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-placeholder",
        "en",
        "placeholder",
        "high",
        r"(?:\[(?:your name|insert|describe|link|source|todo|placeholder)[^\]]*\]|\b(?:INSERT_|PASTE_|TODO|TBD|202[0-9]-XX-XX)\b)",
        "Detected a placeholder or copy-paste artifact.",
        "Resolve the placeholder or remove the incomplete sentence before publishing.",
        flags=re.IGNORECASE,
    ),
    compile_rule(
        "en-exclamation",
        "en",
        "punctuation",
        "high",
        r"!",
        "Detected an exclamation mark.",
        "Remove it and use a period, comma, colon, or a simpler sentence as the meaning requires.",
    ),
    compile_rule(
        "en-curly-punctuation",
        "en",
        "punctuation",
        "low",
        r"[“”‘’]",
        "Detected curly quotes or apostrophes.",
        "Check for mixed punctuation and normalize only when the publication style requires it.",
    ),
    compile_rule(
        "en-dash",
        "en",
        "punctuation",
        "high",
        r"(?:—|–|--)",
        "Detected an em dash, en dash, or double hyphen used as a dash.",
        "Remove the dash and use a period, comma, colon, parentheses, or a simpler sentence.",
    ),
    compile_rule(
        "en-rhetorical-heading",
        "en",
        "heading",
        "medium",
        r"(?:\?\s*$|^\s*#{1,6}\s*(?:why|how can|what if|who says|isn't|aren't|don't|doesn't)\b)",
        "Detected a rhetorical-question heading.",
        "Use a quieter sentence-case heading that names the section's subject.",
        flags=re.IGNORECASE,
        allowed_kinds=("heading",),
    ),
    compile_rule(
        "en-inline-header-list",
        "en",
        "over_structured",
        "low",
        r"^\s*(?:\d+\.|[-*])\s+(?:\*\*[^*]+:\*\*|[A-Z][A-Za-z /-]{2,40}:)",
        "Detected an inline-header list item.",
        "Keep it in documentation when useful; in an essay, consider normal prose or a smaller list.",
        flags=re.MULTILINE,
        allowed_kinds=("list",),
    ),
    compile_rule(
        "en-neat-triplet",
        "en",
        "over_structured",
        "low",
        r"\b[A-Za-z][A-Za-z-]+,\s+[A-Za-z][A-Za-z-]+,\s+and\s+[A-Za-z][A-Za-z-]+\b",
        "Detected a neat three-item rhetorical list.",
        "Check whether all three items add information or merely create polished rhythm.",
        flags=re.IGNORECASE,
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find deterministic AI-writing signals in Markdown prose."
    )
    parser.add_argument("article_path", help="Markdown path, or - to read from stdin")
    parser.add_argument("--language", choices=("auto", "zh", "en"), default="auto")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument(
        "--fail-on",
        choices=("high", "medium", "low"),
        help="Exit with status 2 when a finding at or above this severity exists.",
    )
    parser.add_argument(
        "--fail-on-hard-constraints",
        action="store_true",
        help="Exit with status 2 when an editable exclamation mark, dash, or formulaic binary contrast remains.",
    )
    return parser.parse_args()


def read_markdown(article_path: str) -> tuple[str, list[str]]:
    if article_path == "-":
        return "<stdin>", sys.stdin.read().splitlines()
    path = Path(article_path).expanduser().resolve()
    return str(path), path.read_text(encoding="utf-8").splitlines()


def mark_range(kinds: list[str | None], start: int, end: int, kind: str) -> None:
    for index in range(start, min(end + 1, len(kinds))):
        kinds[index] = kind


def mark_frontmatter(lines: list[str], kinds: list[str | None]) -> None:
    if not lines or lines[0].strip() != "---":
        return
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            mark_range(kinds, 0, index, "frontmatter")
            return


def mark_fenced_code(lines: list[str], kinds: list[str | None]) -> None:
    active_char: str | None = None
    active_length = 0
    for index, line in enumerate(lines):
        match = FENCE_RE.match(line)
        if active_char is None:
            if kinds[index] is not None or not match:
                continue
            token = match.group(1)
            active_char = token[0]
            active_length = len(token)
            kinds[index] = "code"
            continue
        kinds[index] = "code"
        if match:
            token = match.group(1)
            if token[0] == active_char and len(token) >= active_length:
                active_char = None
                active_length = 0


def mark_comment_blocks(lines: list[str], kinds: list[str | None]) -> None:
    index = 0
    while index < len(lines):
        if kinds[index] is not None:
            index += 1
            continue
        if VISUAL_TODO_START_RE.match(lines[index]):
            end = index
            while end < len(lines) and not VISUAL_TODO_END_RE.match(lines[end]):
                end += 1
            if end < len(lines):
                mark_range(kinds, index, end, "visual_todo")
                index = end + 1
                continue
        if HTML_COMMENT_START_RE.match(lines[index]):
            end = index
            while end < len(lines) and not HTML_COMMENT_END_RE.search(lines[end]):
                end += 1
            mark_range(kinds, index, end, "html_comment")
            index = end + 1
            continue
        index += 1


def looks_like_table_row(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped and "|" in stripped)


def mark_tables(lines: list[str], kinds: list[str | None]) -> None:
    for index, line in enumerate(lines):
        if kinds[index] is not None or not TABLE_SEPARATOR_RE.match(line):
            continue
        start = index
        if index > 0 and kinds[index - 1] is None and looks_like_table_row(lines[index - 1]):
            start = index - 1
        end = index
        cursor = index + 1
        while cursor < len(lines) and kinds[cursor] is None and looks_like_table_row(lines[cursor]):
            end = cursor
            cursor += 1
        mark_range(kinds, start, end, "table")


def classify_lines(lines: list[str]) -> list[str | None]:
    kinds: list[str | None] = [None] * len(lines)
    mark_frontmatter(lines, kinds)
    mark_comment_blocks(lines, kinds)
    mark_fenced_code(lines, kinds)
    mark_tables(lines, kinds)

    for index, line in enumerate(lines):
        if kinds[index] is not None:
            continue
        stripped = line.strip()
        if not stripped:
            kinds[index] = "blank"
        elif BLOCKQUOTE_RE.match(line):
            kinds[index] = "blockquote"
        elif IMAGE_RE.fullmatch(stripped):
            kinds[index] = "image"
        elif ATX_HEADING_RE.match(line):
            kinds[index] = "heading"
        elif LIST_RE.match(line):
            kinds[index] = "list"
        elif stripped.startswith("<") and stripped.endswith(">"):
            kinds[index] = "html"
        else:
            kinds[index] = "prose"
    return kinds


def collect_segments(lines: list[str], kinds: list[str | None]) -> list[Segment]:
    segments: list[Segment] = []
    index = 0
    while index < len(lines):
        kind = kinds[index]
        if kind == "prose":
            start = index
            text_lines = [lines[index]]
            while index + 1 < len(lines) and kinds[index + 1] == "prose":
                index += 1
                text_lines.append(lines[index])
            segments.append(
                Segment("prose", "\n".join(text_lines), start + 1, index + 1)
            )
        elif kind in {"heading", "list"}:
            segments.append(Segment(kind, lines[index], index + 1, index + 1))
        index += 1
    return segments


def mask_span(buffer: list[str], start: int, end: int) -> None:
    for index in range(start, min(end, len(buffer))):
        if buffer[index] != "\n":
            buffer[index] = " "


def mask_inline_markdown(text: str) -> str:
    buffer = list(text)
    for pattern in (INLINE_CODE_RE, IMAGE_RE, HTML_TAG_RE):
        for match in pattern.finditer(text):
            mask_span(buffer, match.start(), match.end())
    for match in INLINE_LINK_RE.finditer(text):
        mask_span(buffer, match.start(2), match.end(2))
    return "".join(buffer)


def detect_language(segments: list[Segment]) -> str:
    text = "\n".join(segment.text for segment in segments)
    cjk_count = len(re.findall(r"[\u3400-\u9fff]", text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    if cjk_count >= 20 and cjk_count >= latin_count * 0.25:
        return "zh"
    return "en"


def line_and_column(segment: Segment, offset: int) -> tuple[int, int]:
    prefix = segment.text[:offset]
    relative_line = prefix.count("\n")
    last_newline = prefix.rfind("\n")
    column = offset + 1 if last_newline < 0 else offset - last_newline
    return segment.start_line + relative_line, column


def compact_context(text: str, limit: int = 180) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    return compact if len(compact) <= limit else compact[: limit - 3] + "..."


def finding_id(rule_id: str, text: str, start: int, end: int) -> str:
    before = re.sub(r"\s+", "", text[max(0, start - 48) : start]).casefold()
    matched = re.sub(r"\s+", "", text[start:end]).casefold()
    after = re.sub(r"\s+", "", text[end : end + 48]).casefold()
    anchor = f"{before}\0{matched}\0{after}\0{start}\0{end}"
    digest = hashlib.sha256(f"{rule_id}\0{anchor}".encode("utf-8")).hexdigest()[:10]
    return f"style-{digest}"


def rule_findings(segments: list[Segment], language: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for segment in segments:
        masked_text = mask_inline_markdown(segment.text)
        for rule in RULES:
            if rule.language != language or segment.kind not in rule.allowed_kinds:
                continue
            for match in rule.pattern.finditer(masked_text):
                line, column = line_and_column(segment, match.start())
                matched = segment.text[match.start() : match.end()]
                findings.append(
                    {
                        "id": finding_id(rule.rule_id, masked_text, match.start(), match.end()),
                        "rule_id": rule.rule_id,
                        "hard_constraint": rule.rule_id in HARD_CONSTRAINT_RULE_IDS,
                        "category": rule.category,
                        "severity": rule.severity,
                        "line": line,
                        "column": column,
                        "end_line": line_and_column(segment, match.end())[0],
                        "segment_kind": segment.kind,
                        "matched": matched,
                        "message": rule.message,
                        "suggestion": rule.suggestion,
                        "context": compact_context(segment.text),
                    }
                )
    return findings


def structural_findings(segments: list[Segment], language: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    prose = [segment for segment in segments if segment.kind == "prose"]

    for index in range(len(prose) - 3):
        window = prose[index : index + 4]
        lengths = [len(re.sub(r"\s+", "", segment.text)) for segment in window]
        if min(lengths) < 45 or max(lengths) > min(lengths) * 1.25:
            continue
        anchor = "\n".join(segment.text for segment in window)
        if language == "zh":
            matched = "连续四个长度接近的段落"
            message = "发现连续四个段落长度过于接近。"
            suggestion = "通读这一节判断节奏是否像模板；只有确实机械时才调整。"
        else:
            matched = "four similarly sized paragraphs"
            message = "Detected four consecutive paragraphs with unusually similar lengths."
            suggestion = "Read this section for metronomic rhythm; vary only when the current cadence feels artificial."
        findings.append(
            {
                "id": finding_id("structure-uniform-paragraphs", anchor, 0, len(anchor)),
                "rule_id": "structure-uniform-paragraphs",
                "hard_constraint": False,
                "category": "over_structured",
                "severity": "low",
                "line": window[0].start_line,
                "column": 1,
                "end_line": window[-1].end_line,
                "segment_kind": "document",
                "matched": matched,
                "message": message,
                "suggestion": suggestion,
                "context": compact_context(anchor),
            }
        )
        break

    opener_map: dict[str, list[Segment]] = defaultdict(list)
    for segment in prose:
        compact = re.sub(r"\s+", " ", segment.text).strip()
        if language == "zh":
            opener = re.sub(r"^[`*_>#\s]+", "", compact)[:5]
        else:
            words = re.findall(r"[A-Za-z']+", compact.lower())
            opener = " ".join(words[:3])
        if len(opener) >= 3:
            opener_map[opener].append(segment)
    repeated = [item for item in opener_map.items() if len(item[1]) >= 3]
    if repeated:
        opener, matches = max(repeated, key=lambda item: len(item[1]))
        context = " | ".join(compact_context(segment.text, 70) for segment in matches[:4])
        if language == "zh":
            message = f"发现 {len(matches)} 个段落使用相同的开头模式。"
            suggestion = "检查重复开头是否形成了人工模板节奏。"
        else:
            message = f"Detected {len(matches)} paragraphs with the same opening pattern."
            suggestion = "Check whether the repeated opener creates an artificial template rhythm."
        findings.append(
            {
                "id": finding_id("structure-repeated-opener", context, 0, len(context)),
                "rule_id": "structure-repeated-opener",
                "hard_constraint": False,
                "category": "repetitive_rhythm",
                "severity": "low",
                "line": matches[0].start_line,
                "column": 1,
                "end_line": matches[-1].end_line,
                "segment_kind": "document",
                "matched": opener,
                "message": message,
                "suggestion": suggestion,
                "context": context,
            }
        )

    list_segments = [segment for segment in segments if segment.kind == "list"]
    if len(list_segments) >= 5 and len(list_segments) >= len(segments) * 0.35:
        context = " | ".join(compact_context(segment.text, 60) for segment in list_segments[:5])
        if language == "zh":
            matched = f"{len(list_segments)} 个列表项"
            message = "发现列表相对于正文的占比偏高。"
            suggestion = "保留有助扫读的列表；观点或叙事内容可以改回自然段落。"
        else:
            matched = f"{len(list_segments)} list items"
            message = "Detected high list density relative to prose."
            suggestion = "Keep lists that aid scanning; turn essay-like bullets back into prose when appropriate."
        findings.append(
            {
                "id": finding_id("structure-list-density", context, 0, len(context)),
                "rule_id": "structure-list-density",
                "hard_constraint": False,
                "category": "over_structured",
                "severity": "low",
                "line": list_segments[0].start_line,
                "column": 1,
                "end_line": list_segments[-1].end_line,
                "segment_kind": "document",
                "matched": matched,
                "message": message,
                "suggestion": suggestion,
                "context": context,
            }
        )
    return findings


def analyze(source: str, lines: list[str], language_option: str) -> dict[str, Any]:
    kinds = classify_lines(lines)
    segments = collect_segments(lines, kinds)
    language = detect_language(segments) if language_option == "auto" else language_option
    findings = rule_findings(segments, language)
    findings.extend(structural_findings(segments, language))
    findings.sort(
        key=lambda item: (
            item["line"],
            item["column"],
            -SEVERITY_RANK[item["severity"]],
            item["rule_id"],
        )
    )

    severity_counts = Counter(item["severity"] for item in findings)
    rule_counts = Counter(item["rule_id"] for item in findings)
    category_counts = Counter(item["category"] for item in findings)
    hard_constraint_counts = Counter(
        item["rule_id"] for item in findings if item.get("hard_constraint", False)
    )
    repeated_rules = [
        {"rule_id": rule_id, "count": count}
        for rule_id, count in sorted(rule_counts.items())
        if count >= 3
    ]
    segment_counts = Counter(segment.kind for segment in segments)
    protected_line_counts = Counter(
        kind
        for kind in kinds
        if kind
        not in {None, "blank", "prose", "heading", "list"}
    )
    prose_chars = sum(
        len(re.sub(r"\s+", "", segment.text))
        for segment in segments
        if segment.kind == "prose"
    )
    return {
        "version": 1,
        "source": source,
        "language": language,
        "document": {
            "line_count": len(lines),
            "prose_chars": prose_chars,
            "segment_counts": dict(sorted(segment_counts.items())),
            "protected_line_counts": dict(sorted(protected_line_counts.items())),
        },
        "findings": findings,
        "patterns": {
            "rule_counts": dict(sorted(rule_counts.items())),
            "hard_constraint_counts": dict(sorted(hard_constraint_counts.items())),
            "category_counts": dict(sorted(category_counts.items())),
            "repeated_rules": repeated_rules,
        },
        "summary": {
            "total": len(findings),
            "high": severity_counts["high"],
            "medium": severity_counts["medium"],
            "low": severity_counts["low"],
        },
    }


def print_text(result: dict[str, Any]) -> None:
    summary = result["summary"]
    document = result["document"]
    print(f"Source: {result['source']}")
    print(f"Language: {result['language']}")
    print(f"Lines: {document['line_count']}; prose chars: {document['prose_chars']}")
    print(
        "Findings: "
        f"high={summary['high']}, medium={summary['medium']}, low={summary['low']}"
    )
    for index, finding in enumerate(result["findings"], start=1):
        print(
            f"{index}. {finding['id']} {finding['severity'].upper()} "
            f"{finding['rule_id']} line {finding['line']}:{finding['column']}"
        )
        print(f"   Match: {finding['matched']}")
        print(f"   {finding['message']}")
        print(f"   Suggestion: {finding['suggestion']}")
        print(f"   Context: {finding['context']}")


def should_fail(
    result: dict[str, Any],
    fail_on: str | None,
    fail_on_hard_constraints: bool,
) -> bool:
    if fail_on_hard_constraints and any(
        finding.get("hard_constraint", False) for finding in result["findings"]
    ):
        return True
    if fail_on is not None:
        threshold = SEVERITY_RANK[fail_on]
        return any(
            SEVERITY_RANK[finding["severity"]] >= threshold
            for finding in result["findings"]
        )
    return False


def main() -> int:
    args = parse_args()
    source, lines = read_markdown(args.article_path)
    result = analyze(source, lines, args.language)
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_text(result)
    return 2 if should_fail(
        result,
        args.fail_on,
        args.fail_on_hard_constraints,
    ) else 0


if __name__ == "__main__":
    raise SystemExit(main())
