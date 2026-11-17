# Simplified Technical English

All text for Workhorse uses Simplified Technical English. This page gives the full rules. Read it before you write documentation, a commit message, a pull request description, or a Linear issue.

## Write in Simplified Technical English

All text for this project uses ASD-STE100 Simplified Technical English (STE). This rule applies to
the documentation layers, the site, commit messages, pull request descriptions, Linear issues and
comments, and agent replies to a person. Code, identifiers, and quoted output do not change.

STE makes the text easy to read for a person who is new to Workhorse. It also makes the text easy
to translate. `site/content/docs/contracts.mdx` and `docs/guides/230-payload-contracts.md` show the
style.

Give context first:

- Start each page, section, or reply with one or two sentences of context. Say what the subject is
  and why it is important. Then say how it works.
- Define a term when you use it for the first time. Use one short sentence.
- Do not use analogies. An analogy gives a term a second meaning.

Write each sentence for one purpose:

- Write one topic in each sentence.
- Use a maximum of 20 words in an instruction and 25 words in a description.
- Use a maximum of six sentences in a paragraph.
- Use the active voice. Name the actor. Workhorse does a state transition and gives a product-wide
  guarantee. The worker does process behavior. Say PostgreSQL only when the database, not the
  worker, has the authority.
- Use the present tense. Do not use "will" for a fact.
- Put the condition first: "If the payload is too large, Workhorse rejects the task."
- Use "must" for a requirement. Use "can" for a possibility.
- Do not use noun clusters of more than three words.

Write instructions as procedures:

- Write an instruction in the imperative. Write one action in each instruction.
- If the reader must do actions in sequence, write numbered steps.
- Write a warning or a limit as a separate sentence, near the step that it applies to.

Use simple, consistent words:

- Use common words. For example, use "use", not "utilize", and "start", not "initiate".
- Give each word one meaning and one part of speech.
- Do not use phrasal verbs or idioms when a simple verb is available.
- Use the terms that `CONTEXT.md` defines. `scripts/glossary-avoid-words.test.ts` flags its avoided
  words under `docs/`, apart from the senses that `scripts/glossary-allowlist.json` names.
- Write "payload contract" in full, because `CONTEXT.md` gives "contract step" a different meaning.
