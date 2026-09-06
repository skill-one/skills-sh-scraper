# Meme Catalogue

Two pools (`images`, `sounds`) joined at runtime by tag overlap, lock_sound, preferred_sounds, or silent. The hook auto-picks a sound when Claude Reads an image.

**Tags:** `bruh`, `rage`, `laugh`, `alert`, `shock`, `confusion`

## Tag meanings

| tag | feeling |
|------|---------|
| `bruh` | sarcastic disbelief, "really?", dunk-able moment |
| `rage` | unhinged scream / shout / mad |
| `laugh` | laughter (mocking or with the user) |
| `alert` | sudden attention beat / punctuation |
| `shock` | genuine "oh god" surprise |
| `confusion` | "what just happened?" |

## Image flags (mutually exclusive)

| flag | behavior |
|------|----------|
| `lock_sound: "<slug>"` | force a specific paired sound |
| `silent: true` | image only, no sound |
| `preferred_sounds: [...]` | hook picks from these 80% of the time, tag overlap 20% |
| (none) | pure tag-overlap pick from non-locked, non-standalone sounds |

## Sound flags

| flag | behavior |
|------|----------|
| `locked: true` | only fires when an image's `lock_sound` points here |
| `standalone: true` | never paired with images; reserved for sound-only fires |

## Images (16)

| slug | tags | flags |
|------|------|-------|
| skeleton            | rage              | lock_sound: skeleton |
| cat-laughing        | laugh, bruh       | lock_sound: cat-laughing |
| burro               | bruh              | — |
| surp-dog            | shock, confusion  | — |
| susp-dog            | bruh, confusion   | — |
| scared-dog          | shock, alert | preferred_sounds: [fahhh] |
| dog-scared          | shock, alert | preferred_sounds: [fahhh] |
| bro-freaking-out    | shock, alert | preferred_sounds: [fahhh] |
| tiger-freaking-out  | shock, alert | preferred_sounds: [fahhh] |
| cooked-dog          | bruh              | lock_sound: vine-boom |
| brainrot            | bruh              | lock_sound: vine-boom |
| horse-laughing      | laugh             | preferred_sounds: [cat-laughing, oh-my-god-bro, boy-what-the-hell] |
| hamster-mad         | bruh, rage        | — |
| cat-really          | bruh, rage        | — |
| bros-laughing       | laugh             | preferred_sounds: [cat-laughing, oh-my-god-bro, boy-what-the-hell] |
| brain-ass           | bruh              | silent |

## Sounds (19)

| slug | tags | flags |
|------|------|-------|
| skeleton          | rage                              | locked |
| cat-laughing      | laugh                             | — |
| fahhh             | bruh, confusion, alert, shock     | — |
| aaaaah            | rage, shock                       | standalone |
| vine-boom         | alert, bruh, confusion            | — |
| scream            | rage, shock, confusion, alert     | standalone |
| boy-what-the-hell | confusion, bruh, laugh            | — |
| bruh              | bruh, confusion                   | — |
| oh-my-god         | shock                             | standalone |
| rraaah            | rage, shock                       | standalone |
| ahh-fade          | bruh, confusion                   | — |
| alert             | alert, shock                      | standalone |
| huh               | confusion, bruh                   | — |
| aughhh            | rage                              | standalone |
| horn              | alert                             | standalone |
| horn-nerd         | alert                             | standalone (fused horn + nerd-emoji) |
| screaming         | rage                              | standalone |
| fart-eco          | bruh                              | standalone |
| oh-my-god-bro     | shock, bruh                       | — |
