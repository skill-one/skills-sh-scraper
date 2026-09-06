# English AI-style reduction guide

Remove template rhythm, performative polish, and empty fluency without flattening the author's voice. If a passage already sounds natural and specific, leave it alone.

## Deterministic analyzer coverage

Use `scripts/analyze_ai_style.py` rather than copying regex commands from this reference. The analyzer reports locations, rules, severity, and local context for:

- binary contrast patterns such as “not just X, but Y”
- common AI openers and meta transitions
- generic prestige and importance words
- inflated verbs and copula avoidance
- canned conclusions
- assistant residue
- placeholders and copy-paste artifacts
- exclamation marks, dashes, and mixed curly punctuation
- rhetorical-question headings
- inline-header list items and neat triplets
- unusually uniform paragraph lengths, repeated openers, and high list density

Most findings require contextual review. Exclamation marks, dashes, and formulaic binary contrasts are hard constraints in editable prose and must all be removed. Only code, URLs, Markdown targets, and source text that must remain verbatim are exempt.

## 1. Cut throat-clearing

Remove openers that announce the writing instead of saying the thing.

> Bad: This article explores how teams can leverage vector databases in today's rapidly evolving AI landscape.
>
> Better: Teams use vector databases to keep retrieval fast as their AI apps grow.

Watch for “It is important to note,” “This guide will explore,” “Below is,” and “Let's dive into.”

## 2. Use normal punctuation

Remove every exclamation mark. Use a period, comma, or a simpler sentence instead. Enthusiastic brand voice and casual social copy are not reasons to keep one.

Remove every em dash, en dash, and double hyphen used as a dash. Replace it with a period, comma, colon, parentheses, or a simpler sentence.

Curly punctuation is not inherently wrong. Check for inconsistent mixing rather than normalizing every mark blindly.

Do not alter code, URLs, Markdown targets, identifiers, or quoted source material merely to normalize punctuation.

## 3. Remove synthetic binary contrast

AI prose often invents a misconception so it can correct it: “not just X,” “not merely X,” “more than just X,” or “rather than Y.” Rewrite every formulaic binary contrast as a direct claim. When the comparison carries factual information, state both facts plainly without retaining the template.

> Bad: Milvus is not just a vector database; it is a foundation for intelligent applications.
>
> Better: Milvus stores and searches vectors for AI applications that need low-latency retrieval.

## 4. Prefer plain verbs

Do not avoid “is,” “are,” or “has” just to sound polished.

Common fixes:

- “serves as” → “is”
- “stands as” → “is”
- “boasts” → “has”
- “features” → “has” or “includes”
- “plays a pivotal role in” → the actual verb
- “underscores the importance of” → the specific result

## 5. Replace generic importance with evidence

“Significant,” “crucial,” “pivotal,” “robust,” “seamless,” “transformative,” and “innovative” often announce value without proving it.

> Bad: This robust solution plays a crucial role in modern data workflows.
>
> Better: The pipeline retries failed imports and records every skipped row.

Keep an adjective when the sentence supplies the evidence that makes it accurate.

## 6. Break listicle rhythm

AI drafts often move in neat threes: three adjectives, three clauses, three sections, three closing takeaways. Collapse weak triplets, vary sentence length when the existing cadence feels mechanical, and remove bullets that do not help scanning.

Do not simulate humanity with slang, deliberate mistakes, or random fragments.

## 7. Put real actors in the sentence

Avoid false agency and vague authorities when the actor matters.

> Bad: A new benchmark was introduced to demonstrate that latency is reduced.
>
> Better: The team added a benchmark and cut p95 latency by 18%.

If “experts say” or “researchers agree” has no verifiable source, flag the claim instead of polishing it.

## 8. Use quieter headings and structure

Prefer headings that name the subject. Avoid rhetorical questions and generic sections such as “Challenges and Future Outlook,” “Key Takeaways,” or “Conclusion” when they add no information.

Inline-bold list headers can be correct in documentation. In essays, they often create a generated listicle rhythm. Preserve structures that fit the genre.

## 9. Remove assistant residue and placeholders

Delete knowledge-cutoff disclaimers, “based on the provided sources,” “I hope this helps,” “Would you like me to,” and unresolved template text.

Do not smooth over suspicious citations. Flag an incomplete link, DOI, date, or quoted claim for verification.

## 10. Preserve genre and voice

Technical docs, release notes, product pages, essays, and social posts need different structures. Lists, bold labels, and title-case headings may be intentional.

Do not over-humanize with contractions, jokes, anecdotes, or choppy prose unless the surrounding voice supports them. The safest rewrite is usually plainer, more specific, and less performative.

## 11. Full-read semantic checks

The analyzer cannot enumerate every semantic pattern. Read the whole article for:

- repeated arguments expressed with different vocabulary
- identical section logic repeated across the article
- unsupported escalation from a local fact to an industry-wide claim
- artificial emotional peaks and tidy reversals
- paragraph rhythm that remains mechanical despite varied words
- vague claims that sound polished but carry little information
- a rewrite that erases the author's actual position
- genre mismatch

A lower finding count is useful evidence, but the final article must still read coherently from start to finish. The exclamation, dash, and binary-contrast rule counts must be zero after rescanning, except for protected verbatim text.
